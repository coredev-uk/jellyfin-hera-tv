// Checks of the verdicts themselves: the run only means something if a broken Hera fails it.
// `node --test tests/compat` (no browser, no server).
import assert from "node:assert/strict";
import { test } from "node:test";
import { createJudge, heraWarnings, isHeraScript, judgeConsole, judgeResponse, quoteEntry, scanLog } from "./judge.mjs";

const healthy = (overrides = {}) => ({
  boot: "ok",
  reason: null,
  jellyfin: "12.4.0",
  tested: ["12.4"],
  modules: [
    { name: "core", status: "ok", missing: [], page: null, errors: 0, lastError: null },
    { name: "home", status: "ok", missing: [], page: null, errors: 0, lastError: null },
  ],
  ...overrides,
});
const spec = { name: "home", modules: ["core", "home"] };

test("a healthy snapshot passes", () => {
  const verdict = createJudge()(healthy(), spec, {});
  assert.deepEqual(verdict, { failures: [], warnings: [] });
});

test("a missing HeraTV fails", () => {
  assert.equal(createJudge()(null, spec, {}).failures.length, 1);
});

test("boot must be ok or untested", () => {
  const judge = createJudge();
  assert.match(judge(healthy({ boot: "starting" }), spec, {}).failures[0], /never finished starting/);
  assert.match(judge(healthy({ boot: "safe", reason: "no ApiClient" }), spec, {}).failures[0], /safe mode: no ApiClient/);
  const untested = createJudge()(healthy({ boot: "untested" }), spec, {});
  assert.deepEqual(untested.failures, []);
  assert.equal(untested.warnings.length, 1);
});

test("a signed-out page may still be starting", () => {
  assert.deepEqual(createJudge()(healthy({ boot: "starting" }), { name: "login", signedOut: true }, {}).failures, []);
});

test("degraded, partial and disabled modules fail, once and together", () => {
  const judge = createJudge();
  const snapshot = healthy({
    modules: [
      { name: "core", status: "degraded", missing: ["detailRibbon"], page: "itemDetailPage", errors: 0 },
      { name: "trailer", status: "degraded", missing: ["detailRibbon"], page: "itemDetailPage", errors: 0 },
      { name: "extras", status: "partial", missing: ["cardScalable"], page: "itemDetailPage", errors: 0 },
      { name: "player", status: "disabled", missing: [], errors: 3, lastError: "boom" },
    ],
  });
  const first = judge(snapshot, { name: "film" }, { detailRibbon: ".detailRibbon" });
  assert.equal(first.failures.length, 3);
  assert.match(first.failures[0], /modules "core", "trailer": degraded on itemDetailPage, Jellyfin has no detailRibbon \(\.detailRibbon\)/);
  assert.match(first.failures[1], /"extras": only partly working/);
  assert.match(first.failures[2], /disabled after repeated errors, last: boom/);
  assert.deepEqual(judge(snapshot, { name: "series" }, { detailRibbon: ".detailRibbon" }).failures, [], "reported once, where first seen");
});

test("a module that threw once fails even though it recovered", () => {
  const snapshot = healthy({ modules: [{ name: "home", status: "ok", missing: [], errors: 1, lastError: "x is undefined" }] });
  assert.match(createJudge()(snapshot, { name: "home" }, {}).failures[0], /threw 1 time\(s\), last: x is undefined/);
});

test("a module the page needs must have run", () => {
  const judge = createJudge();
  const absent = judge(healthy({ modules: [] }), spec, {});
  assert.equal(absent.failures.length, 2);
  assert.match(absent.failures[0], /"core": never ran \(not in the health report\)/);
  const idle = judge(healthy({ modules: [{ name: "core", status: "idle", missing: [], errors: 0 }, { name: "home", status: "ok", missing: [], errors: 0 }] }), { name: "film", modules: ["core"] }, {});
  assert.match(idle.failures[0], /"core": never ran \(status idle\)/);
});

test("a required module must have run on the page that showed, not just on an earlier one", () => {
  const judge = createJudge();
  const modules = [
    { name: "core", status: "ok", missing: [], errors: 0, runs: 2, ranOn: ["indexPage"] },
    { name: "login", status: "ok", missing: [], errors: 0, runs: 0, ranOn: [] },
  ];
  const verdict = judge(healthy({ modules }), { name: "film", modules: ["core", "login"] }, {}, "itemDetailPage");
  assert.equal(verdict.failures.length, 1);
  assert.match(verdict.failures[0], /"core": never ran on itemDetailPage \(it ran on indexPage\)/);
  assert.deepEqual(createJudge()(healthy({ modules }), { name: "home", modules: ["core"] }, {}, "indexPage").failures, []);
});

test("console errors and warnings from Hera's scripts fail; Jellyfin's and Hera's logs do not", () => {
  const entries = [
    { type: "error", text: "Uncaught TypeError: x\n at y", url: "http://h/HeraTV/hera-bundle.js?v=1" },
    { type: "warning", text: "[Hera TV:core] standing aside on itemDetailPage", url: "http://h/HeraTV/hera-bundle.js?v=1" },
    { type: "error", text: "boom", url: "http://h/web/main.jellyfin.bundle.js" },
    { type: "log", text: "fine", url: "http://h/HeraTV/hera-bundle.js" },
    { type: "error", text: "Failed to load resource: 404", url: "http://h/HeraTV/activity/title/movie/1" },
    { type: "error", text: "plugin page", url: "http://h/web/configurationpage?name=heratv-settings.js" },
  ];
  const failures = judgeConsole(entries, { name: "film" }, healthy());
  assert.equal(failures.length, 3);
  assert.match(failures[0], /console error on film: Uncaught TypeError: x$/);
});

test("the untested-Jellyfin warning is not a failure on an untested Jellyfin only", () => {
  const entry = [{ type: "warning", text: "[Hera TV] Jellyfin 12.5.0 is newer than the releases this build was tested on (12.4)", url: "http://h/HeraTV/hera-bundle.js" }];
  assert.deepEqual(judgeConsole(entry, { name: "home" }, healthy({ boot: "untested" })), []);
  assert.equal(judgeConsole(entry, { name: "home" }, healthy()).length, 1);
});

test("responses: 5xx under /HeraTV/ and 4xx on assets fail", () => {
  assert.match(judgeResponse("http://h/HeraTV/stats/now", 500), /answered 500/);
  assert.equal(judgeResponse("http://h/HeraTV/stats/now", 404), null);
  assert.match(judgeResponse("http://h/HeraTV/hera-bundle.css?v=1", 404), /answered 404/);
  assert.equal(judgeResponse("http://h/Items", 500), null);
  assert.equal(isHeraScript("http://h/HeraTV/hera-bundle.js?v=abc"), true);
  assert.equal(isHeraScript("http://h/HeraTV/stats/now"), false);
});

const LOG = [
  "[19:21:04] [INF] [1] Main: Jellyfin version: 12.4.0",
  "[19:21:09] [ERR] [14] Jellyfin.Plugin.HeraTv.Letterboxd.LetterboxdWatcher: BackgroundService failed",
  "System.IO.FileNotFoundException: Could not load file or assembly 'Microsoft.Data.Sqlite, Version=10.0.15.0'",
  "   at Jellyfin.Plugin.HeraTv.Letterboxd.LetterboxdStore.Count()",
  "   at Jellyfin.Plugin.HeraTv.Letterboxd.LetterboxdWatcher.ExecuteAsync(CancellationToken stoppingToken)",
  "[19:21:09] [WRN] [14] Jellyfin.Plugin.HeraTv.ServerHealth: Hera TV couldn't sample the playing streams",
  "[19:21:10] [ERR] [3] Emby.Server.Implementations.Library.LibraryManager: Something else failed",
  "   at Emby.Server.Implementations.Library.LibraryManager.Run()",
  "[19:21:11] [FTL] [1] Main: Kestrel failed to start!",
].join("\n");

test("the log scan finds the plugin's errors with their stacks, and every fatal one", () => {
  const scan = scanLog(LOG);
  assert.equal(scan.errors.length, 3);
  assert.equal(scan.hera.length, 1);
  assert.equal(scan.fatal.length, 1);
  const quoted = quoteEntry(scan.hera[0]);
  assert.match(quoted, /^\[19:21:09\] \[ERR\] \[14\] Jellyfin\.Plugin\.HeraTv\.Letterboxd\.LetterboxdWatcher/);
  assert.match(quoted, /at Jellyfin\.Plugin\.HeraTv\.Letterboxd\.LetterboxdStore\.Count/);
  assert.deepEqual(heraWarnings(LOG), ["Jellyfin.Plugin.HeraTv.ServerHealth: Hera TV couldn't sample the playing streams"]);
});

test("a clean log has nothing to quote", () => {
  const scan = scanLog("[19:21:04] [INF] [1] Main: up\n[19:21:05] [WRN] [1] Other: a warning");
  assert.deepEqual([scan.errors.length, scan.hera.length, scan.fatal.length], [0, 0, 0]);
});
