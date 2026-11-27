// `node --test "tests/**/*.test.mjs"`: the manifest check must catch a file left out and a module misspelt.
import assert from "node:assert/strict";
import { test } from "node:test";
import { check, knownModules, manifestEntries, registeredModules } from "./manifest.mjs";

const manifest = `
    private static readonly Unit[] Manifest =
    [
        new("hera-tv.js", "hera-tv.css", null),
        new("hera-home.js", "hera-home.css", "home"),
        new(null, "hera-home-detail.css", "home-detail"),
        new(null, "hera-dashboard.css", null),
    ];
    public const string StylesheetBundle = "hera-bundle.css";
`;
const scripts = [
  ["hera-tv.js", 'window.HeraTV = { register(m) {} }; const builtIns = { name: "core" };'],
  ["hera-home.js", 'const MODULE = "home";\n  heraTv.register({\n    name: MODULE,\n  });\n  heraTv.register({ name: "home-detail" });'],
];

test("entries and registrations are read whatever way they are spelt", () => {
  assert.deepEqual(manifestEntries(manifest), [
    { file: "hera-tv.js", module: null },
    { file: "hera-tv.css", module: null, script: "hera-tv.js" },
    { file: "hera-home.js", module: null },
    { file: "hera-home.css", module: "home", script: "hera-home.js" },
    { file: "hera-home-detail.css", module: "home-detail", script: null },
    { file: "hera-dashboard.css", module: null, script: null },
  ]);
  assert.deepEqual([...registeredModules(scripts)], [["hera-tv.js", ["core"]], ["hera-home.js", ["home", "home-detail"]]]);
  assert.deepEqual(knownModules('KnownModules = ["core", "home"];'), ["core", "home"]);
  // Module before the file, and no script on the line.
  assert.deepEqual(manifestEntries('new("home", "hera-home.css"),'), [{ file: "hera-home.css", module: "home", script: null }]);
});

const ok = { webFiles: ["hera-tv.css", "hera-home.css", "hera-home-detail.css", "hera-dashboard.css", "hera-tv.js", "hera-home.js"], scripts, manifestSource: manifest, compatSource: "" };

test("a consistent manifest passes", () => {
  assert.deepEqual(check(ok), []);
});

test("a file left out of the manifest, one it names that is missing, and a stylesheet for no module fail", () => {
  assert.match(check({ ...ok, webFiles: [...ok.webFiles, "hera-new.css"] })[0], /hera-new\.css is embedded but not in WebAssets\.cs/);
  assert.match(check({ ...ok, webFiles: ok.webFiles.slice(1) })[0], /names hera-tv\.css, which is not in web/);
  assert.match(check({ ...ok, manifestSource: manifest.replace('"home")', '"hom")') })[0], /gated on module "hom"/);
});

test("a stylesheet gated on a module its own script does not register fails", () => {
  const swapped = manifest.replace('"hera-home.js", "hera-home.css", "home"', '"hera-tv.js", "hera-home.css", "home"');
  assert.match(check({ ...ok, manifestSource: swapped }).find((problem) => /next to hera-tv\.js/.test(problem)) ?? "", /registers core.*registered by hera-home\.js/);
});

test("a stylesheet with no script of its own passes when any script registers its module, and fails when none does", () => {
  // home-detail is registered by hera-home.js, which is listed on another line.
  assert.deepEqual(check(ok), []);
  const orphan = manifest.replace('"home-detail"', '"nobody"');
  assert.match(check({ ...ok, manifestSource: orphan })[0], /hera-home-detail\.css is gated on module "nobody", which no script registers/);
});

test("the health report's module list must match what is registered", () => {
  const problems = check({ ...ok, compatSource: 'KnownModules = ["core", "home", "collections"];' });
  assert.deepEqual(problems.length, 2);
  assert.match(problems[0], /"home-detail" is registered but Compatibility\.cs does not accept/);
  assert.match(problems[1], /"collections", which no script registers/);
});
