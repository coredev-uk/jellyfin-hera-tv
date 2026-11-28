// The legacy build's gates (tools/legacy): the scripts lowered and parsed at the level Chromium 53
// reads, the prelude assembled without anything that replaces a built-in, the stylesheets free of
// what those engines drop a rule for, and the C# bundle wrapper in the same ES5.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { transform } from "lightningcss";
import { lowerStylesheets } from "../../tools/legacy/css.mjs";
import { buildPrelude, checkSyntax, featuresFor, lowerScript, usedNames } from "../../tools/legacy/js.mjs";
import { manifestEntries } from "../compat/manifest.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, "utf8");

const MODERN = `(() => {
  "use strict";
  class Box { #n = 1; static kind = "box"; get n() { return this.#n; } }
  const wait = async (ms) => { await new Promise((r) => setTimeout(r, ms)); return ms ?? 0; };
  const spread = { ...window.a, b: 1 };
  let o = window.x?.y?.[0] ?? "z";
  o ??= "q";
  try { wait(1); } catch { o = null; }
  const f = (a, b,) => a ** b;
  async function* gen() { yield* [1]; }
  (async () => { for await (const v of gen()) o = v; })();
  return [Box, spread, o, f];
})();`;

test("the syntax gate refuses what Chromium 53 can't parse, with where", () => {
  for (const [code, what] of [
    ["async function f() { await 1; }", /async|await|Unexpected/i],
    ["a?.b", /Unexpected/],
    ["f(a, b,);", /Unexpected/],
    ["({ ...a })", /Unexpected/],
    ["try {} catch {}", /Unexpected/],
    ["/(?<=a)b/", /regular expression|Invalid/i],
    ["a ??= 1", /Unexpected/],
  ]) {
    assert.throws(() => checkSyntax(code, "x.js"), (error) => error.message.startsWith("x.js:1:") && what.test(error.message), code);
  }
  assert.doesNotThrow(() => checkSyntax("const a = 2 ** 3; class A { static f() {} } function* g() { yield 1; }", "x.js"));
});

test("a script is lowered to ES2016 and stays one self-contained function", async () => {
  const code = await lowerScript(MODERN, "modern.js");
  checkSyntax(code, "modern.js");
  assert.match(code, /^\(function \(\) \{/);
  assert.match(code, /\}\)\.call\(this\);\n$/);
});

test("the names a script uses decide which core-js modules it gets, and what has no polyfill stops the build", () => {
  const names = usedNames("const a = Object.entries(x).flatMap(f).at(-1); p.finally(g); Promise.allSettled(l); s.padStart(2); queueMicrotask(h); globalThis.k;");
  const { modules, unavailable } = featuresFor(names);
  for (const id of ["es.object.entries", "es.array.flat-map", "es.array.at", "es.promise.finally", "es.promise.all-settled", "es.string.pad-start", "web.queue-microtask", "es.global-this"]) assert.ok(modules.includes(id), id);
  assert.deepEqual(unavailable, []);
  assert.deepEqual(featuresFor(usedNames("new WeakRef(a); x.requestSubmit()")).unavailable, ["WeakRef", "requestSubmit"]);
});

test("the prelude is core-js for what is used plus the DOM stand-ins, replaces no built-in, and parses as ES2016", async () => {
  const prelude = await buildPrelude(["es.array.at", "es.promise.finally", "es.object.from-entries"]);
  checkSyntax(prelude.code, "hera-polyfills.js");
  assert.ok(prelude.modules.includes("es.array.at"));
  assert.match(prelude.code, /ResizeObserver/);
  assert.match(prelude.code, /replaceChildren/);
  await assert.rejects(buildPrelude(["es.array.sort"]), /replace built-ins/);
});

test("every script of the manifest is lowered and parses at the level of Chromium 53", async () => {
  const scripts = manifestEntries(read("WebAssets.cs")).map((entry) => entry.file).filter((name) => name.endsWith(".js"));
  assert.ok(scripts.length >= 10);
  const names = new Set();
  for (const name of scripts) {
    const source = read(`web/${name}`);
    for (const used of usedNames(source)) names.add(used);
    assert.deepEqual(featuresFor(usedNames(source)).unavailable, [], `${name} uses an API nothing in tools/legacy provides`);
    checkSyntax(await lowerScript(source, name), name);
  }
  const prelude = await buildPrelude(featuresFor(names).modules);
  checkSyntax(prelude.code, "hera-polyfills.js");
});

test("every stylesheet is lowered without what Chromium before 88 drops a rule for", () => {
  const styles = [...new Set(manifestEntries(read("WebAssets.cs")).map((entry) => entry.file).filter((name) => name.endsWith(".css")))];
  const { files } = lowerStylesheets(styles.map((name) => ({ name, css: read(`web/${name}`) })));
  assert.equal(files.length, styles.length);
  for (const { name, css } of files) {
    // It parses strictly, as the first check that nothing it wrote is malformed.
    transform({ filename: name, code: Buffer.from(css), errorRecovery: false });
    for (const [what, pattern] of [
      [":has()", /:has\(/],
      [":is()", /:is\(/],
      [":where()", /:where\(/],
      [":focus-visible", /:focus-visible/],
      [":dir()", /:dir\(/],
      ["inset", /(^|[\s;{])inset(-[a-z]+)*\s*:/],
      ["overflow: clip", /overflow(-[xy])?:\s*clip/],
      ["a :not() with a list", /:not\([^()]*,/],
      ["color-mix", /color-mix\(/],
    ]) {
      assert.doesNotMatch(css, pattern, `${name} still has ${what}`);
    }
  }
});

// The wrapper the server puts around the legacy bundle is C# strings, so it is read back out of
// WebAssets.cs and parsed at the same level as the scripts it wraps.
test("the legacy bundle's own wrapper (WebAssets.cs) parses as ES2016", () => {
  const source = read("WebAssets.cs");
  const literal = (name) => {
    const match = new RegExp(`const string ${name} = "((?:[^"\\\\]|\\\\.)*)";`).exec(source);
    assert.ok(match, `WebAssets.cs has no ${name}`);
    return JSON.parse(`"${match[1]}"`);
  };
  const wrapper = literal("LegacyPrologueHead") + "abc123" + literal("PrologueMiddle") + '[["hera-polyfills.js",21]]' + literal("LegacyPrologueTail") + literal("ModuleStart") + "var x = 1;\n" + '} catch (error) {\n  window.HeraBundle.failed("hera-tv.js", error);\n}\n';
  checkSyntax(wrapper, "hera-bundle-legacy.js");
  assert.match(wrapper, /variant: "legacy"/);
});
