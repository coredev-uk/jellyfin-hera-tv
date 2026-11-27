#!/usr/bin/env node
// Runs Hera TV against a real Jellyfin server and fails when anything about it is not right.
//
//   node run.mjs --tag 12.4          # the Jellyfin image tag; default: the one the plugin is built for
//
// It starts jellyfin/jellyfin:<tag> in a container (docker, else podman) with the published plugin
// (out/ at the repository root, from `dotnet publish -c Release -o out`) in its plugin folder,
// fixture media from fixtures.mjs and a stand-in for Seerr (seerr-stub.mjs), sets the server up
// through its API (server.mjs), then
//
//   - checks the server: the plugin is Active; each Hera endpoint answers as the administrator and
//     as an ordinary user; both scheduled tasks run to the end; the film that is playing shows in the
//     statistics; Jellyfin is still up after 70+ s; and its log has no error from the plugin (checks.mjs)
//   - drives Chromium through the signed-out sign-in page, `?hera=off`, the TV layout with the keys of
//     a remote, and every kind of page in the desktop layout, with a few clicks (pages.mjs); on each
//     it reads window.HeraTV.health() and what Hera drew (judge.mjs says what counts as broken).
//
// Exit status: 0 when everything is as it should be (an untested Jellyfin is only a warning), 1 otherwise.
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { checkApi, checkHealth, checkPlugin, checkStreams, runTasks, stillUp } from "./checks.mjs";
import { ffmpegArgs, generate, hostSources, run } from "./fixtures.mjs";
import { createJudge, heraWarnings, isHeraScript, isHeraUrl, judgeConsole, judgeResponse, quoteEntry, scanLog } from "./judge.mjs";
import { desktopPages, disabledPages, offSpec, signedOutPages, tvPages } from "./pages.mjs";
import { API_KEY as SEERR_KEY, startSeerrStub } from "./seerr-stub.mjs";
import { addViewer, DEVICE, populate, probe, setUp, waitForServer } from "./server.mjs";
import { repoRoot, testedTag } from "./tag.mjs";

const { values: options } = parseArgs({
  options: {
    tag: { type: "string" },
    plugin: { type: "string", default: join(repoRoot, "out") },
    out: { type: "string", default: new URL("./results", import.meta.url).pathname },
    runtime: { type: "string" },
    keep: { type: "boolean", default: false },
    // The server's loops tick once a minute; the film plays at least this long (seconds) so each ticks.
    soak: { type: "string", default: "75" },
    // A browser without VP9 (a distribution's Chromium) cannot play the fixtures: the pause screen and
    // the statistics' stream are then not checked, and the run says so.
    "allow-no-playback": { type: "boolean", default: false },
  },
});

const tag = options.tag || testedTag();
const resultsDir = resolve(options.out);
const SOAK_MS = Math.max(0, Number(options.soak)) * 1000;
const log = (message) => console.log(`[compat] ${message}`);

// ---------- container ---------------------------------------------------------------------

const detectRuntime = () => {
  for (const candidate of options.runtime ? [options.runtime] : ["docker", "podman"]) {
    if (spawnSync(candidate, ["--version"], { stdio: "ignore" }).status === 0) return candidate;
  }
  throw new Error("Neither docker nor podman is available (use --runtime to name one)");
};

const freePort = () =>
  new Promise((done, fail) => {
    const probePort = net.createServer().once("error", fail);
    probePort.listen(0, "127.0.0.1", () => {
      const { port } = probePort.address();
      probePort.close(() => done(port));
    });
  });

// The files are owned by whoever runs this, so the container runs as them too: nothing in the
// temporary folders is left owned by root. Rootless podman needs keep-id for that to line up.
const userArgs = (runtime) => {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return [...(runtime === "podman" ? ["--userns=keep-id"] : []), "--user", `${uid}:${gid}`];
};

// How the container reaches the Seerr stand-in on this machine.
const hostAccess = (runtime) =>
  runtime === "podman"
    ? { name: "host.containers.internal", args: [] }
    : { name: "host.docker.internal", args: ["--add-host", "host.docker.internal:host-gateway"] };

// ---------- the run -----------------------------------------------------------------------

const summary = {
  tag,
  jellyfin: null,
  status: "error",
  error: null,
  failures: [],
  warnings: [],
  pages: [],
  playback: null,
  api: [],
  tasks: [],
  heraLog: null,
};
const addUnique = (list, message) => !list.includes(message) && list.push(message);
const fail = (message) => addUnique(summary.failures, message);
const warn = (message) => addUnique(summary.warnings, message);

// Hera waits up to 2.5 s for the pieces a page needs before it stands aside, so a verdict
// earlier than that would miss a module that is about to degrade.
const SETTLE_MS = 3500;

const readHealth = (page) => page.evaluate(() => window.HeraTV?.health?.() ?? null);

/** Waits for the page to show, then for Hera to have had its say about it. */
const settle = async (page, spec, { view = spec.view } = {}) => {
  const ids = Array.isArray(view) ? view : [view];
  try {
    await page.waitForFunction((wanted) => wanted.includes(document.querySelector(".page:not(.hide)")?.id), ids, { timeout: 20_000 });
  } catch {
    const shown = await page.evaluate(() => document.querySelector(".page:not(.hide)")?.id ?? null).catch(() => null);
    throw new Error(`expected page ${ids.join(" or ")}, but ${shown ? `${shown} is` : "no page is"} showing`);
  }
  await page.waitForTimeout(SETTLE_MS);
  let last = JSON.stringify(await readHealth(page));
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.waitForTimeout(500);
    const now = JSON.stringify(await readHealth(page));
    if (now === last) break;
    last = now;
  }
};

/** What Hera must have drawn: the page-level class Hera sets, each required module's own class, and the spec's `dom`. */
const checkDom = async (page, spec, { hera = true } = {}) => {
  const problems = [];
  const rules = hera ? ["html.hera-on", ...(spec.modules ?? []).map((name) => `html.hera-m-${name}`), ...(spec.dom ?? [])] : (spec.dom ?? []);
  for (const rule of rules) {
    if (typeof rule === "string") {
      const found = await page.waitForSelector(rule, { state: "attached", timeout: 6_000 }).catch(() => null);
      if (!found) problems.push(`${spec.name}: Hera drew nothing at ${rule}`);
    } else if (rule.none) {
      if (await page.$(rule.none)) problems.push(`${spec.name}: ${rule.none} is on the page`);
    } else if (rule.notText) {
      const [selector, pattern] = rule.notText;
      const text = await page.evaluate((sel) => document.querySelector(sel)?.textContent ?? null, selector);
      if (text === null) problems.push(`${spec.name}: ${selector} is not on the page`);
      else if (new RegExp(pattern).test(text)) problems.push(`${spec.name}: ${selector} still reads "${text.trim().slice(0, 80)}"`);
    }
  }
  return problems;
};

/**
 * One browser context and the listeners that judge what its pages do: Hera's console output, the
 * errors its scripts throw, and every answer from /HeraTV/.
 */
const openContext = async (browser, { base, viewport, credentials, deviceId, layout }) => {
  const context = await browser.newContext({ viewport, locale: "en-GB" });
  // Signing in through the form would test Hera's restyled login page instead of the pages under
  // test, and break when Jellyfin changes it. The web client signs in from the stored credentials
  // of an access token the API issued, as it does after a real sign-in.
  await context.addInitScript(
    ({ stored, device, savedLayout }) => {
      if (stored && !localStorage.getItem("jellyfin_credentials")) localStorage.setItem("jellyfin_credentials", JSON.stringify(stored));
      if (device) localStorage.setItem("_deviceId2", device);
      if (savedLayout) localStorage.setItem("layout", savedLayout);
    },
    { stored: credentials ?? null, device: deviceId ?? null, savedLayout: layout ?? null },
  );
  const page = await context.newPage();
  const seen = { pageErrors: [], console: [] };
  page.on("pageerror", (error) => seen.pageErrors.push({ message: error.message, stack: error.stack || "" }));
  page.on("console", (message) => seen.console.push({ type: message.type(), text: message.text(), url: message.location().url }));
  page.on("response", (response) => {
    const problem = judgeResponse(response.url(), response.status());
    if (problem) fail(problem);
  });
  return { context, page, seen, base };
};

/**
 * Visits each spec in turn and judges it. `hooks.whilePlaying` runs once a film is playing, and the
 * film then plays on until the soak is over.
 */
const runPass = async (surface, specs, { judge, hera = true, hooks = {} } = {}) => {
  const { page, seen, base } = surface;
  for (const [index, spec] of specs.entries()) {
    const entry = { name: spec.name, hash: spec.hash, view: null, screenshot: null, failures: [], warnings: [] };
    summary.pages.push(entry);
    if (spec.skip) {
      entry.failures.push(`${spec.name}: not visited: ${spec.skip}`);
      entry.failures.forEach(fail);
      continue;
    }
    if (spec.warnInstead) {
      entry.warnings.push(`${spec.name}: ${spec.warnInstead}`);
      entry.warnings.forEach(warn);
      continue;
    }
    entry.screenshot = `${String(summary.pages.length).padStart(2, "0")}-${spec.name}.png`;
    seen.pageErrors = [];
    seen.console = [];
    log(`${spec.name}: ${spec.hash || "(start page)"}`);

    try {
      if (index === 0) await page.goto(`${base}/web/${spec.hash}`, { waitUntil: "domcontentloaded" });
      else await page.evaluate((hash) => { window.location.hash = hash; }, spec.hash);

      // Hera's script is injected into index.html; if it is not there nothing else can be judged.
      if (index === 0 && hera) await page.waitForFunction(() => window.HeraTV, null, { timeout: 30_000 }).catch(() => {});

      if (spec.play) {
        await settle(page, spec, { view: "itemDetailPage" });
        await page.click(".mainDetailButtons .btnPlay", { timeout: 10_000 });
        await page.waitForFunction((id) => document.querySelector(".page:not(.hide)")?.id === id, spec.view, { timeout: 20_000 });
        summary.playback = await startPlayback(page);
      }
      await settle(page, spec);
      entry.failures.push(...(await checkDom(page, spec, { hera })));
      for (const check of spec.checks ?? []) {
        const problem = await check(page);
        if (problem) entry.failures.push(`${spec.name}: ${problem}`);
      }

      for (const interaction of spec.interactions ?? []) {
        if (spec.play && !summary.playback?.playing) {
          warn(`${spec.name}: ${interaction.name} was not tried: the film is not playing`);
          continue;
        }
        try {
          await interaction.run(page);
        } catch (error) {
          entry.failures.push(`${spec.name}: ${interaction.name}: ${error.message.split("\n")[0]}`);
        }
      }

      if (spec.play) await hooks.whilePlaying?.(page);
    } catch (error) {
      entry.failures.push(`${spec.name}: ${error.message.split("\n")[0]} (at ${page.url()})`);
    }

    entry.view = await page.evaluate(() => document.querySelector(".page:not(.hide)")?.id ?? null).catch(() => null);
    if (hera) {
      const snapshot = await readHealth(page).catch(() => null);
      const jf = await page.evaluate(() => window.HeraTV?.jf ?? null).catch(() => null);
      const verdict = judge(snapshot, spec, jf, entry.view);
      entry.failures.push(...verdict.failures);
      entry.warnings.push(...verdict.warnings);
      entry.failures.push(...judgeConsole(seen.console, spec, snapshot));
    }
    for (const error of seen.pageErrors) {
      const ours = isHeraUrl(error.stack) || isHeraUrl(error.message) || isHeraScript(error.stack);
      (ours ? entry.failures : entry.warnings).push(`${ours ? "Hera script" : "Jellyfin's own script"} threw on ${spec.name}: ${error.message}`);
    }
    await page.screenshot({ path: join(resultsDir, entry.screenshot) }).catch(() => {});
    entry.failures.forEach(fail);
    entry.warnings.forEach(warn);
  }
};

/** Waits for the video to move, and notes when it did. A film that never plays is a finding; so is a failed hook. */
const startPlayback = async (page) => {
  const state = () =>
    page.evaluate(() => {
      const video = document.querySelector("video");
      return video ? { currentTime: video.currentTime, paused: video.paused, error: video.error?.message ?? null } : null;
    });
  const moved = await page.waitForFunction(() => (document.querySelector("video")?.currentTime ?? 0) > 0.5, null, { timeout: 20_000 }).then(() => true, () => false);
  const result = { ...(await state()), playing: moved, startedAt: Date.now() };
  if (!moved) {
    const message = `the film did not start playing (${JSON.stringify(await state())})`;
    if (options["allow-no-playback"]) warn(message);
    else fail(message);
  }
  return result;
};

/** After the checks that ran while the film played: let it play out the rest of the soak, then check it still is. */
const finishSoak = async (page) => {
  const left = SOAK_MS - (Date.now() - (summary.playback?.startedAt ?? Date.now()));
  if (left > 0) {
    log(`keeping the film playing for ${Math.ceil(left / 1000)} s more, so every loop on the server ticks`);
    await page.waitForTimeout(left);
  }
  if (!summary.playback?.playing) return;
  const state = await page.evaluate(() => {
    const video = document.querySelector("video");
    return video ? { currentTime: video.currentTime, paused: video.paused, ended: video.ended, error: video.error?.message ?? null } : null;
  });
  Object.assign(summary.playback, { at: state });
  if (!state || state.error || state.paused || state.ended) fail(`the film stopped playing before the soak was over (${JSON.stringify(state)})`);
};

const test = async ({ base, session, viewer, serverId, data, seerr, container }) => {
  const admin = probe(base, session.token);
  const user = probe(base, viewer.token);
  const anonymous = probe(base);
  const credentials = { Servers: [{ Id: serverId, Name: "Hera compat", ManualAddress: base, LastConnectionMode: 2, UserId: session.userId, AccessToken: session.token, DateLastAccessed: Date.now() }] };

  for (const message of await checkPlugin(admin)) fail(message);

  const browser = await chromium.launch({
    executablePath: process.env.HERA_CHROMIUM || undefined,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  try {
    // Nobody signed in: the sign-in page is Hera's to restyle, and a person who cannot reach it cannot reach anything.
    const signedOut = await openContext(browser, { base, viewport: { width: 1440, height: 810 } });
    await runPass(signedOut, signedOutPages(), { judge: createJudge() });
    await signedOut.context.close();

    // ?hera=off is the way out when an update breaks a page: it has to take Hera off the tab.
    const off = await openContext(browser, { base, viewport: { width: 1440, height: 810 } });
    await runPass(off, [offSpec], { hera: false });
    await checkHeraIsOff(off.page, summary.pages.at(-1));
    await off.context.close();

    // The TV layout, at 1920x1080 and with a remote's keys.
    const tv = await openContext(browser, { base, viewport: { width: 1920, height: 1080 }, credentials, deviceId: DEVICE.id, layout: "tv" });
    await runPass(tv, tvPages(data), { judge: createJudge() });
    await tv.context.close();

    // The desktop layout. The film is started on the last page and keeps playing under the server checks.
    const desktop = await openContext(browser, { base, viewport: { width: 1440, height: 810 }, credentials, deviceId: DEVICE.id });
    await runPass(desktop, desktopPages(data), {
      judge: createJudge(),
      hooks: {
        whilePlaying: async (page) => {
          await serverChecks({ admin, user, anonymous, data, seerr });
          await finishSoak(page);
          if (summary.playback?.playing) for (const message of await checkStreams(admin)) fail(message);
          for (const message of await checkHealth(admin)) fail(message);
          if (!(await stillUp(anonymous)) || !container.running()) fail("Jellyfin stopped answering while Hera was running");
        },
      },
    });
    await desktop.context.close();

    // The kill switch, once the desktop pass is over: it changes what every browser is served.
    await disabledModulesPass({ browser, base, credentials, admin, anonymous });
  } finally {
    await browser.close();
  }
};

/**
 * The kill switch: with `DisabledModules = ["discover"]` saved through the settings API, the web
 * client must never register Discover, so nothing of it is drawn or restyled, and the rest of Hera
 * runs as before. The setting is put back afterwards, whatever happened.
 */
const disabledModulesPass = async ({ browser, base, credentials, admin, anonymous }) => {
  const set = async (names) => {
    const { status } = await admin("/HeraTV/settings", { method: "POST", body: { disabledModules: names } });
    if (status >= 300) fail(`saving DisabledModules answered ${status}`);
    return status < 300;
  };
  if (!(await set(["discover"]))) return;
  try {
    const served = (await anonymous("/HeraTV/config")).body?.disabledModules;
    if (!Array.isArray(served) || !served.includes("discover")) fail(`/HeraTV/config does not serve the saved DisabledModules (it says ${JSON.stringify(served)})`);
    const surface = await openContext(browser, { base, viewport: { width: 1440, height: 810 }, credentials, deviceId: DEVICE.id });
    await runPass(surface, disabledPages(), { judge: createJudge() });
    await surface.context.close();
  } finally {
    await set([]);
  }
};

/** The checks that need no browser, run while the film plays. */
const serverChecks = async ({ admin, user, anonymous, data, seerr }) => {
  log("calling every Hera endpoint as the administrator, as a viewer and with no token");
  const api = await checkApi({ admin, viewer: user, anonymous, ids: { film: data.films[0].Id, series: data.series.Id } });
  summary.api = api.table;
  api.failures.forEach(fail);
  for (const wanted of ["/api/v1/discover/trending", "/api/v1/user/1/requests"]) {
    if (!seerr.hits.some((hit) => hit.includes(wanted))) fail(`Hera never reached the Seerr stand-in at ${wanted}: its Seerr calls are not getting through`);
  }

  log("running Hera's scheduled tasks");
  const tasks = await runTasks(admin);
  summary.tasks = tasks.results;
  tasks.failures.forEach(fail);
};

/** `?hera=off`: no Hera class, no Hera stylesheet, nothing restyled. */
const checkHeraIsOff = async (page, entry) => {
  const state = await page.evaluate(() => ({
    classes: [...document.documentElement.classList].filter((name) => name === "hera" || name === "hera-on" || name.startsWith("hera-m-")),
    sheets: document.querySelectorAll("link[data-hera-tv]").length,
    restyled: Boolean(document.querySelector("#loginPage.hera-login")),
  }));
  const problems = [];
  if (state.classes.length) problems.push(`?hera=off left ${state.classes.join(", ")} on <html>`);
  if (state.sheets) problems.push(`?hera=off left ${state.sheets} Hera stylesheet(s) in the page`);
  if (state.restyled) problems.push("?hera=off left the sign-in page restyled");
  entry.failures.push(...problems);
  problems.forEach(fail);
};

// ---------- the report --------------------------------------------------------------------

const markdown = () => {
  const lines = [`**Jellyfin \`${summary.tag}\`${summary.jellyfin ? ` (server ${summary.jellyfin})` : ""}: ${summary.status}**`, ""];
  if (summary.error) lines.push(`Run error: ${summary.error}`, "");
  if (summary.failures.length) lines.push("Failures", "", ...summary.failures.map((m) => `- ${m}`), "");
  if (summary.heraLog) lines.push("First error from the plugin in Jellyfin's log", "", "```text", summary.heraLog, "```", "");
  if (summary.warnings.length) lines.push("Warnings", "", ...summary.warnings.map((m) => `- ${m}`), "");
  if (summary.pages.length) {
    lines.push("| Page | Shown as | Result |", "| --- | --- | --- |");
    for (const p of summary.pages) lines.push(`| ${p.name} | ${p.view ?? "?"} | ${p.failures.length ? "failed" : "ok"} |`);
    lines.push("");
  }
  if (summary.tasks.length) lines.push(`Scheduled tasks: ${summary.tasks.map((t) => `${t.key} ${t.status}`).join(", ")}`, "");
  if (summary.api.length) {
    lines.push(`Hera endpoints called: ${summary.api.length} (${summary.api.filter((row) => !row.ok).length} with an unexpected answer)`, "");
  }
  return `${lines.join("\n")}\n`;
};

const main = async () => {
  const runtime = detectRuntime();
  const dll = join(resolve(options.plugin), "Jellyfin.Plugin.HeraTv.dll");
  if (!existsSync(dll)) throw new Error(`${dll} is missing; run \`dotnet publish -c Release -o out\` in the repository root first`);

  await mkdir(resultsDir, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), "hera-compat-"));
  const image = `docker.io/jellyfin/jellyfin:${tag}`;
  const name = `hera-compat-${process.pid}`;
  let started = false;
  let seerr = null;
  const logs = () => spawnSync(runtime, ["logs", name], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  const running = () => spawnSync(runtime, ["inspect", "-f", "{{.State.Running}}", name], { encoding: "utf8" }).stdout.trim() === "true";

  try {
    const plugin = join(work, "config", "plugins", "HeraTV");
    await mkdir(plugin, { recursive: true });
    await mkdir(join(work, "cache"), { recursive: true });
    await cp(dll, join(plugin, "Jellyfin.Plugin.HeraTv.dll"));
    await cp(join(repoRoot, "meta.json"), join(plugin, "meta.json"));

    log(`pulling ${image}`);
    await run(runtime, ["pull", image]);

    log("generating fixture media");
    const hasFfmpeg = spawnSync(process.env.FFMPEG || "ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
    await generate(join(work, "media"), hasFfmpeg
      ? hostSources()
      // The image carries its own ffmpeg, so a machine without one still works.
      : (dir) => run(runtime, ["run", "--rm", ...userArgs(runtime), "-v", `${dir}:/work`, "-w", "/work", "--entrypoint", "/usr/lib/jellyfin-ffmpeg/ffmpeg", image, ...ffmpegArgs()]));

    // Seerr is switched off without a server to ask, and so are Discover and Requests; the stand-in keeps them on.
    seerr = await startSeerrStub();
    const host = hostAccess(runtime);

    const port = await freePort();
    log(`starting ${name} on 127.0.0.1:${port}`);
    await run(runtime, [
      "run", "-d", "--name", name, ...userArgs(runtime),
      "--security-opt", "label=disable",
      ...host.args,
      "-p", `127.0.0.1:${port}:8096`,
      "-e", `HERATV_SEERR_URL=http://${host.name}:${seerr.port}`,
      "-e", `HERATV_SEERR_API_KEY=${SEERR_KEY}`,
      "-e", "HERATV_SEERR_USERS=hera=1,viewer=2",
      "-v", `${join(work, "config")}:/config`,
      "-v", `${join(work, "cache")}:/cache`,
      "-v", `${join(work, "media")}:/media:ro`,
      image,
    ]);
    started = true;

    const base = `http://127.0.0.1:${port}`;
    const info = await waitForServer(base);
    summary.jellyfin = info.Version;
    log(`Jellyfin ${info.Version} is up; setting it up`);
    const session = await setUp(base);
    const viewer = await addViewer(base, session.jf);
    const data = await populate(session);
    log(`library ready: ${data.films.map((f) => f.Name).join(", ")}; ${data.series.Name}; collection; ${data.person ? `person ${data.person.Name}` : "no person"}`);

    await test({ base, session, viewer, serverId: session.serverId, data, seerr, container: { running } });
    summary.status = summary.failures.length ? "failed" : "passed";
  } catch (error) {
    summary.status = "error";
    summary.error = error.message;
    summary.failures.push(`the run itself failed: ${error.message.split("\n")[0]}`);
  } finally {
    if (started) {
      const output = logs();
      const text = `${output.stdout ?? ""}${output.stderr ?? ""}`;
      await writeFile(join(resultsDir, "jellyfin.log"), text);
      reviewLog(text);
      if (options.keep) log(`left ${name} running (${runtime} rm -f ${name} to remove it); data in ${work}`);
      else spawnSync(runtime, ["rm", "-f", "-v", name], { stdio: "ignore" });
    }
    await seerr?.close();
    if (!options.keep) await rm(work, { recursive: true, force: true });
    if (summary.status === "passed" && summary.failures.length) summary.status = "failed";
    await writeFile(join(resultsDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(join(resultsDir, "summary.md"), markdown());
  }
};

/** Jellyfin's own log: an error with the plugin in its stack is a failure, quoted; so is a fatal one, whoever caused it. */
const reviewLog = (text) => {
  const scan = scanLog(text);
  if (scan.hera.length) {
    summary.heraLog = quoteEntry(scan.hera[0]);
    fail(`Jellyfin logged ${scan.hera.length} error(s) from the plugin; the first: ${scan.hera[0].lines[0].replace(/^\[[^\]]*\]\s*/, "").slice(0, 300)}`);
  }
  for (const entry of scan.fatal.filter((candidate) => !scan.hera.includes(candidate))) {
    fail(`Jellyfin logged a fatal error: ${entry.lines[0].replace(/^\[[^\]]*\]\s*/, "").slice(0, 300)}`);
  }
  heraWarnings(text).forEach((line) => warn(`Hera in Jellyfin's log: ${line}`));
  // A plugin Jellyfin refused to load is the usual reason Hera is missing; say so.
  if (summary.failures.length && !scan.hera.length) {
    const mentions = text.split("\n").filter((line) => /hera ?tv/i.test(line) && /(warn|err|fail|disabled|incompatible|abi)/i.test(line)).slice(0, 5);
    if (mentions.length) fail(`Jellyfin's log about Hera: ${mentions.join(" | ")}`);
  }
};

await main();
console.log(`\n${markdown()}`);
if (summary.warnings.length && summary.status === "passed") log("passed with warnings");
process.exit(summary.status === "passed" ? 0 : 1);
