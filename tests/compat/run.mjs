#!/usr/bin/env node
// Runs Hera TV against a real Jellyfin server and fails when Hera reports that anything is broken.
//
//   node run.mjs --tag 12.4          # the Jellyfin image tag; default: the one the plugin is built for
//
// It starts jellyfin/jellyfin:<tag> in a container (docker, else podman) with the published plugin
// (out/ at the repository root, from `dotnet publish -c Release -o out`) in its plugin folder and
// fixture media from fixtures.mjs, sets the server up through its API (server.mjs), then drives
// Chromium through each kind of page and reads window.HeraTV.health() on every one.
//
// Exit status: 0 when every page is healthy (an untested Jellyfin is only a warning), 1 when Hera
// is missing, in safe mode, has a degraded or disabled module, or throws from its own scripts.
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { generate, hostSources, run, ffmpegArgs } from "./fixtures.mjs";
import { DEVICE, populate, setUp, waitForServer } from "./server.mjs";
import { repoRoot, testedTag } from "./tag.mjs";

const { values: options } = parseArgs({
  options: {
    tag: { type: "string" },
    plugin: { type: "string", default: join(repoRoot, "out") },
    out: { type: "string", default: new URL("./results", import.meta.url).pathname },
    runtime: { type: "string" },
    keep: { type: "boolean", default: false },
  },
});

const tag = options.tag || testedTag();
const resultsDir = resolve(options.out);
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
    const probe = net.createServer().once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => done(port));
    });
  });

// The files are owned by whoever runs this, so the container runs as them too: nothing in the
// temporary folders is left owned by root. Rootless podman needs keep-id for that to line up.
const userArgs = (runtime) => {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  return [...(runtime === "podman" ? ["--userns=keep-id"] : []), "--user", `${uid}:${gid}`];
};

// ---------- pages -------------------------------------------------------------------------

/** What each page needs to be considered shown (`view` is the id of Jellyfin's .page element). */
const pagesFor = (data) => {
  const film = data.films[0];
  const details = (id) => `#/details?id=${id}`;
  return [
    { name: "home", hash: "#/home", view: "indexPage" },
    { name: "films-library", hash: `#/movies?topParentId=${data.filmsLibrary}&collectionType=movies` },
    { name: "film", hash: details(film.Id), view: "itemDetailPage" },
    { name: "series", hash: details(data.series.Id), view: "itemDetailPage" },
    { name: "episode", hash: details(data.episode.Id), view: "itemDetailPage" },
    { name: "collection", hash: details(data.collection), view: "itemDetailPage" },
    { name: "search", hash: "#/search" },
    { name: "dashboard", hash: "#/dashboard" },
    // Starts the film from its own page and lets it play for two seconds.
    { name: "player", hash: details(film.Id), view: "videoOsdPage", play: true },
  ];
};

const PLAY_SECONDS = 2;
// Hera waits up to 2.5 s for the pieces a page needs before it stands aside, so a verdict
// earlier than that would miss a module that is about to degrade.
const SETTLE_MS = 3500;

const readHealth = (page) => page.evaluate(() => window.HeraTV?.health?.() ?? null);

/** Waits for the page to show, then for Hera to have had its say about it. */
const settle = async (page, spec) => {
  if (spec.view) {
    await page.waitForFunction((id) => document.querySelector(".page:not(.hide)")?.id === id, spec.view, { timeout: 20_000 });
  } else {
    await page.waitForSelector(".page:not(.hide)", { state: "attached", timeout: 20_000 });
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

// A module's status stays until it next runs on a page, so a break would otherwise be repeated on
// every page after it. Each is reported once, where it was first seen, with the modules it hit
// together: one missing piece of Jellyfin usually degrades every module at once.
const reported = new Set();

/** What is wrong, and what is only worth knowing, in one health snapshot. */
const judge = (snapshot, jf, spec) => {
  const failures = [];
  const warnings = [];
  if (!snapshot) {
    failures.push(`${spec.name}: window.HeraTV is missing; the plugin's scripts are not running on this page`);
    return { failures, warnings };
  }
  if (snapshot.boot === "safe") failures.push(`${spec.name}: Hera went into safe mode: ${snapshot.reason}`);
  if (snapshot.boot === "untested") {
    warnings.push(`Jellyfin ${snapshot.jellyfin} is not one Hera was tested on (${(snapshot.tested || []).join(", ")})`);
  }
  const groups = new Map();
  for (const m of snapshot.modules) {
    const detail =
      m.status === "degraded" ? `degraded on ${m.page}, Jellyfin has no ${m.missing.map((key) => `${key} (${jf?.[key] ?? "?"})`).join(", ")}`
      : m.status === "disabled" ? `disabled after repeated errors, last: ${m.lastError}`
      : m.errors > 0 ? `threw ${m.errors} time(s), last: ${m.lastError}`
      : null;
    if (!detail || reported.has(`${m.name}|${detail}`)) continue;
    reported.add(`${m.name}|${detail}`);
    if (!groups.has(detail)) groups.set(detail, { failure: m.status === "degraded" || m.status === "disabled", names: [] });
    groups.get(detail).names.push(m.name);
  }
  for (const [detail, { failure, names }] of groups) {
    (failure ? failures : warnings).push(`${names.length > 1 ? "modules" : "module"} ${names.map((name) => `"${name}"`).join(", ")}: ${detail} (first seen on ${spec.name})`);
  }
  return { failures, warnings };
};

const isHeraUrl = (text) => /\/HeraTV\//.test(text || "");

// ---------- the run -----------------------------------------------------------------------

const summary = { tag, jellyfin: null, status: "error", error: null, failures: [], warnings: [], pages: [], playback: null };
const addUnique = (list, message) => !list.includes(message) && list.push(message);

const test = async ({ base, token, userId, serverId, data }) => {
  const browser = await chromium.launch({
    executablePath: process.env.HERA_CHROMIUM || undefined,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 810 }, locale: "en-GB" });
    // Signing in through the form would test Hera's restyled login page instead of the pages
    // under test, and break when Jellyfin changes it. The web client signs in from the stored
    // credentials of an access token the API issued, as it does after a real sign-in.
    await context.addInitScript(
      ({ credentials, deviceId }) => {
        if (!localStorage.getItem("jellyfin_credentials")) localStorage.setItem("jellyfin_credentials", JSON.stringify(credentials));
        localStorage.setItem("_deviceId2", deviceId);
      },
      {
        deviceId: DEVICE.id,
        credentials: {
          Servers: [{ Id: serverId, Name: "Hera compat", ManualAddress: base, LastConnectionMode: 2, UserId: userId, AccessToken: token, DateLastAccessed: Date.now() }],
        },
      },
    );
    const page = await context.newPage();

    let pageErrors = [];
    let heraLogs = [];
    page.on("pageerror", (error) => pageErrors.push({ message: error.message, stack: error.stack || "" }));
    page.on("console", (message) => {
      if (message.text().startsWith("[Hera TV")) heraLogs.push(`${message.type()}: ${message.text()}`);
    });
    page.on("response", (response) => {
      const url = response.url();
      if (response.status() >= 400 && /\/HeraTV\/[^/?]+\.(js|css|woff2)(\?|$)/.test(url)) {
        addUnique(summary.failures, `${url} answered ${response.status()}`);
      }
    });

    const pages = pagesFor(data);
    for (const [index, spec] of pages.entries()) {
      pageErrors = [];
      heraLogs = [];
      const entry = { name: spec.name, hash: spec.hash, view: null, screenshot: `${String(index + 1).padStart(2, "0")}-${spec.name}.png`, health: null, failures: [], warnings: [] };
      summary.pages.push(entry);
      log(`${spec.name}: ${spec.hash}`);

      try {
        if (index === 0) await page.goto(`${base}/web/${spec.hash}`, { waitUntil: "domcontentloaded" });
        else await page.evaluate((hash) => { window.location.hash = hash; }, spec.hash);

        // Hera's script is injected into index.html; if it is not there nothing else can be judged.
        if (index === 0) await page.waitForFunction(() => window.HeraTV, null, { timeout: 30_000 }).catch(() => {});

        if (spec.play) {
          await settle(page, { ...spec, view: "itemDetailPage" });
          await page.click(".mainDetailButtons .btnPlay", { timeout: 10_000 });
          await page.waitForFunction((id) => document.querySelector(".page:not(.hide)")?.id === id, spec.view, { timeout: 20_000 });
          await page.waitForTimeout(PLAY_SECONDS * 1000);
          summary.playback = await page.evaluate(() => {
            const video = document.querySelector("video");
            return video ? { currentTime: video.currentTime, paused: video.paused, error: video.error?.message ?? null } : null;
          });
          if (!summary.playback || summary.playback.currentTime <= 0) {
            // Playback needs a codec the browser has; Hera's health is what is under test.
            entry.warnings.push(`the video did not advance (${JSON.stringify(summary.playback)})`);
          }
        }
        await settle(page, spec);
      } catch (error) {
        entry.failures.push(`${spec.name}: ${error.message.split("\n")[0]} (at ${page.url()})`);
      }

      entry.view = await page.evaluate(() => document.querySelector(".page:not(.hide)")?.id ?? null).catch(() => null);
      entry.health = await readHealth(page).catch(() => null);
      const jf = await page.evaluate(() => window.HeraTV?.jf ?? null).catch(() => null);
      const verdict = judge(entry.health, jf, spec);
      entry.failures.push(...verdict.failures);
      entry.warnings.push(...verdict.warnings);

      for (const error of pageErrors) {
        const ours = isHeraUrl(error.stack) || isHeraUrl(error.message);
        (ours ? entry.failures : entry.warnings).push(`${ours ? "Hera script" : "Jellyfin's own script"} threw on ${spec.name}: ${error.message}`);
      }
      entry.heraLogs = [...heraLogs];
      await page.screenshot({ path: join(resultsDir, entry.screenshot) }).catch(() => {});
      entry.failures.forEach((message) => addUnique(summary.failures, message));
      entry.warnings.forEach((message) => addUnique(summary.warnings, message));
    }
  } finally {
    await browser.close();
  }
};

const markdown = () => {
  const lines = [`**Jellyfin \`${summary.tag}\`${summary.jellyfin ? ` (server ${summary.jellyfin})` : ""}: ${summary.status}**`, ""];
  if (summary.error) lines.push(`Run error: ${summary.error}`, "");
  if (summary.failures.length) lines.push("Failures", "", ...summary.failures.map((m) => `- ${m}`), "");
  if (summary.warnings.length) lines.push("Warnings", "", ...summary.warnings.map((m) => `- ${m}`), "");
  if (summary.pages.length) {
    lines.push("| Page | Shown as | Result |", "| --- | --- | --- |");
    for (const p of summary.pages) lines.push(`| ${p.name} | ${p.view ?? "?"} | ${p.failures.length ? "failed" : "ok"} |`);
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
  const logs = () => spawnSync(runtime, ["logs", name], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

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

    const port = await freePort();
    log(`starting ${name} on 127.0.0.1:${port}`);
    await run(runtime, [
      "run", "-d", "--name", name, ...userArgs(runtime),
      "--security-opt", "label=disable",
      "-p", `127.0.0.1:${port}:8096`,
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
    const data = await populate(session);
    log(`library ready: ${data.films.map((f) => f.Name).join(", ")}; ${data.series.Name}; collection`);

    await test({ base, ...session, data });
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
      // A plugin Jellyfin refused to load is the usual reason Hera is missing; say so.
      const mentions = text.split("\n").filter((line) => /hera ?tv/i.test(line) && /(warn|err|fail|disabled|incompatible|abi)/i.test(line)).slice(0, 5);
      if (mentions.length && summary.failures.length) summary.failures.push(`Jellyfin's log about Hera: ${mentions.join(" | ")}`);
      if (options.keep) log(`left ${name} running (${runtime} rm -f ${name} to remove it); data in ${work}`);
      else spawnSync(runtime, ["rm", "-f", "-v", name], { stdio: "ignore" });
    }
    if (!options.keep) await rm(work, { recursive: true, force: true });
    await writeFile(join(resultsDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    await writeFile(join(resultsDir, "summary.md"), markdown());
  }
};

await main();
console.log(`\n${markdown()}`);
if (summary.warnings.length && summary.status === "passed") log("passed with warnings");
process.exit(summary.status === "passed" ? 0 : 1);
