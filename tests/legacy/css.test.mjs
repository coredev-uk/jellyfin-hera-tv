// The legacy stylesheet transforms (tools/legacy): each one on a small input, so a rewrite that
// stops doing what it says fails here rather than on a television.
import assert from "node:assert/strict";
import test from "node:test";
import { parseColor } from "../../tools/legacy/css-color.mjs";
import { evaluate, reduceMath } from "../../tools/legacy/css-math.mjs";
import { parse, stringify } from "../../tools/legacy/css-model.mjs";
import { lowerSelector } from "../../tools/legacy/css-selectors.mjs";
import { lowerStylesheets } from "../../tools/legacy/css.mjs";

/** One stylesheet through the transforms (without lightningcss, so the input is what is tested) as normalised text. */
const lower = (css, { lightning = false, others = [] } = {}) => {
  const { files, report } = lowerStylesheets([{ name: "a.css", css }, ...others], { lightning });
  return { css: files[0].css.trim(), report };
};
const flat = (text) => text.replace(/\s+/g, " ").trim();

test("the model reads and writes what it was given", () => {
  const css = '@media (min-width: 600px) {\n  .a,\n  .b > c {\n    color: red !important;\n    margin: 0 calc(1px + var(--x, 2px));\n  }\n}\n\n.d::before {\n  content: "a;b{";\n}';
  assert.equal(stringify(parse(css)), css);
});

test("selectors: :focus-visible becomes :focus, in lists and in :not()", () => {
  assert.deepEqual(lowerSelector(".a:focus-visible").selectors, [".a:focus"]);
  assert.deepEqual(lowerSelector(".a:focus:not(:focus-visible)").selectors, [".a:focus:not(:focus)"]);
});

test("selectors: :is() and :where() are expanded, a complex argument taking a whole compound", () => {
  assert.deepEqual(lowerSelector(".x :is(.a, .b) .c").selectors, [".x .a .c", ".x .b .c"]);
  assert.deepEqual(lowerSelector(".x :is(.a, .a > .b) > .c").selectors, [".x .a > .c", ".x .a > .b > .c"]);
  assert.deepEqual(lowerSelector("p:where(.a, .b)").selectors, ["p.a", "p.b"]);
  // An argument that would have to merge with the compound it is in has nowhere to go.
  assert.deepEqual(lowerSelector(".x:is(.a .b)").selectors, []);
});

test("selectors: :not() with a list or a compound becomes chains and alternatives, a complex one is dropped", () => {
  assert.deepEqual(lowerSelector(".a:not(.b, .c)").selectors, [".a:not(.b):not(.c)"]);
  assert.deepEqual(lowerSelector(".a:not(.b.c)").selectors, [".a:not(.b)", ".a:not(.c)"]);
  assert.deepEqual(lowerSelector(".a:not(:is(.b, .c))").selectors, [".a:not(.b):not(.c)"]);
  assert.deepEqual(lowerSelector(".a:not(.b .c)").selectors, []);
  assert.deepEqual(lowerSelector(".a:not(.b + .c)").selectors, []);
  assert.deepEqual(lowerSelector(".a:not(:last-child)").selectors, [".a:not(:last-child)"]);
});

test("selectors: :has() drops the selector, wherever it is", () => {
  assert.deepEqual(lowerSelector(".a:has(> .b)").selectors, []);
  assert.deepEqual(lowerSelector(".a:not(:has(.b))").selectors, []);
  assert.deepEqual(lowerSelector('.a[title=":has(x)"]').selectors, ['.a[title=":has(x)"]']);
});

test("a list keeps the selectors that survive, and a rule with none is gone", () => {
  const { css, report } = lower(".a:has(.x), .b:focus-visible, .c:not(.d .e) { color: red }\n.f:has(.g) { color: blue }");
  assert.equal(flat(css), ".b:focus { color: red; }");
  assert.equal(report.counts.get("rules dropped (no selector left)"), 1);
  assert.equal(report.notes.get("selector dropped").length, 3);
});

test("a :focus-within selector gets a rule of its own, so engines without it keep the rest of the list", () => {
  const { css } = lower(".a:focus-within, .b { color: red }\n.c:focus-within { color: blue }");
  assert.equal(flat(css), ".b { color: red; } .a:focus-within { color: red; } .c:focus-within { color: blue; }");
});

test("min(), max() and clamp() pick the argument that wins at 1920x1080 and keep it as written", () => {
  assert.equal(reduceMath("clamp(132px, 11.5vw, 196px)"), "196px");
  assert.equal(reduceMath("clamp(48px, 5vh, 96px)"), "5vh");
  assert.equal(reduceMath("clamp(48px, 9vh, 96px)"), "96px");
  assert.equal(reduceMath("clamp(240px, 5vw, 340px)"), "240px");
  assert.equal(reduceMath("min(804px, 100%)"), "804px");
  assert.equal(reduceMath("min(520px, calc(100% - 96px))"), "520px");
  assert.equal(reduceMath("max(40px, calc(45vh - 170px))"), "calc(45vh - 170px)");
  assert.equal(reduceMath("min(var(--w), calc(100vw - 48px))"), "var(--w)");
  assert.equal(reduceMath("clamp(440px, min(80vh, 56.25vw), 1100px)"), "80vh");
  assert.equal(reduceMath("calc(100% - clamp(10px, 1vw, 30px))"), "calc(100% - 1vw)");
  assert.equal(reduceMath("min(100% - 10px, 50vw)"), "50vw");
  assert.equal(reduceMath("12px"), "12px");
  assert.equal(evaluate("calc(45vh - 170px)"), 316);
  assert.equal(evaluate("100%"), null);
});

test("math: a fallback goes before the original in a declaration, and replaces the value in a custom property", () => {
  const { css, report } = lower(".a { width: clamp(1px, 50vw, 3px); --edge: clamp(24px, 4vw, 72px); height: 5px }");
  assert.equal(flat(css), ".a { width: 3px; width: clamp(1px, 50vw, 3px); --edge: 72px; height: 5px; }");
  assert.equal(report.counts.get("math: fallback added"), 1);
  assert.equal(report.counts.get("math: custom property replaced"), 1);
});

test("color-mix with a token and transparent becomes the token's colour at that alpha, beside each declaration of the token", () => {
  const { css } = lower(
    ":root { --bg: #000; --label: rgba(235, 235, 245, 0.52) }\n:root[data-s=light] { --bg: #fff }\n.a { background: linear-gradient(color-mix(in srgb, var(--bg) 58%, transparent), transparent); color: color-mix(in srgb, var(--label) 80%, transparent) }",
  );
  assert.match(flat(css), /:root \{ --bg: #000; --bg-mix-58: rgba\(0, 0, 0, 0\.58\); --label: rgba\(235, 235, 245, 0\.52\); --label-mix-80: rgba\(235, 235, 245, 0\.416\); \}/);
  assert.match(flat(css), /:root\[data-s=light\] \{ --bg: #fff; --bg-mix-58: rgba\(255, 255, 255, 0\.58\); \}/);
  assert.match(flat(css), /background: linear-gradient\(var\(--bg-mix-58, rgba\(0, 0, 0, 0\.58\)\), transparent\)/);
  assert.match(flat(css), /color: var\(--label-mix-80, rgba\(235, 235, 245, 0\.416\)\)/);
});

test("color-mix of two literals is worked out, and one it can't resolve falls back to its first colour, reported", () => {
  const { css, report } = lower(".a { color: color-mix(in srgb, #ff0000 50%, #0000ff); border-color: color-mix(in oklab, var(--x), red) }");
  assert.match(css, /color: rgb\(128, 0, 128\)/);
  assert.match(css, /border-color: var\(--x\)/);
  assert.equal(report.notes.get("color-mix unresolved").length, 1);
});

test("overflow: clip becomes hidden", () => {
  assert.equal(flat(lower(".a { overflow: clip; overflow-x: clip }").css), ".a { overflow: hidden; overflow-x: hidden; }");
});

test("individual transform properties fold into transform where the rule has none, and are left where it has", () => {
  assert.equal(flat(lower(".a { translate: 1px 2px; scale: 1.2; rotate: 5deg; color: red }").css), ".a { transform: translate(1px, 2px) scale(1.2) rotate(5deg); color: red; }");
  const kept = lower(".b { translate: 1px; transform: scale(2) }");
  assert.equal(flat(kept.css), ".b { translate: 1px; transform: scale(2); }");
  assert.equal(kept.report.notes.get("transform property left").length, 1);
});

test("inset and the logical box properties become their physical longhands", () => {
  assert.equal(flat(lower(".a { inset: 0 }").css), ".a { top: 0; right: 0; bottom: 0; left: 0; }");
  assert.equal(flat(lower(".a { inset: 72px var(--e) auto auto !important }").css), ".a { top: 72px !important; right: var(--e) !important; bottom: auto !important; left: auto !important; }");
  assert.equal(flat(lower(".a { margin-inline: 1px 2px; padding-block: 3px }").css), ".a { margin-left: 1px; margin-right: 2px; padding-top: 3px; padding-bottom: 3px; }");
});

test("gap on a flex row or column becomes margins on the later children, and goes", () => {
  const row = lower(".a { display: flex; gap: 8px 20px }");
  assert.equal(flat(row.css), ".a { display: flex; } .a > * + * { margin-left: 20px; }");
  const column = lower(".a { display: flex; flex-direction: column; gap: 6px }");
  assert.equal(flat(column.css), ".a { display: flex; flex-direction: column; } .a > * + * { margin-top: 6px; }");
  const reversed = lower(".a { display: flex; flex-direction: row-reverse; gap: 6px }");
  assert.match(flat(reversed.css), /\.a > \* \+ \* \{ margin-right: 6px; \}/);
});

test("the flex container can be named by another rule, and a wrapping row gets margins on every child", () => {
  const apart = lower(".a { display: flex; flex-direction: column }\n@media (width < 600px) { .a { gap: 4px } }");
  assert.match(flat(apart.css), /@media \(width < 600px\) \{ \.a > \* \+ \* \{ margin-top: 4px; \} \}/);
  const wrap = lower(".a { display: flex; flex-wrap: wrap; gap: 4px 10px }");
  assert.equal(flat(wrap.css), ".a { display: flex; flex-wrap: wrap; } .a > * { margin-right: 10px; margin-bottom: 4px; }");
  const centred = lower(".a { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px }");
  assert.match(centred.css, /gap: 4px/);
  assert.equal(centred.report.notes.get("gap left (wrapping flex container that isn't a plain row)").length, 1);
});

test("gap on a grid gains grid-gap, and gap where the container isn't known is left and reported", () => {
  assert.equal(flat(lower(".a { display: grid; gap: 4px 8px }").css), ".a { display: grid; grid-gap: 4px 8px; gap: 4px 8px; }");
  const unknown = lower(".stock { gap: 4px }");
  assert.equal(flat(unknown.css), ".stock { gap: 4px; }");
  assert.equal(unknown.report.notes.get("gap left (not a flex or grid container here)").length, 1);
});

test("aspect-ratio becomes a spacer in ::before on a box that holds its own float, with its image taken out of the flow", () => {
  const { css } = lower(".card { position: relative; display: block; overflow: hidden }\n.poster .card { aspect-ratio: 2 / 3 }");
  assert.match(flat(css), /\.poster \.card::before \{ content: ""; float: left; width: 0; padding-top: 150%; \}/);
  assert.match(flat(css), /\.poster \.card > img \{ position: absolute; top: 0; left: 0; \}/);
  assert.doesNotMatch(css, /aspect-ratio/);
  assert.doesNotMatch(css, /::after/);
});

test("aspect-ratio on a box that is no formatting context also clears its float, and is left where a pseudo-element is taken", () => {
  const plain = lower(".a { aspect-ratio: 1 }");
  assert.match(flat(plain.css), /\.a::before \{ content: ""; float: left; width: 0; padding-top: 100%; \} \.a::after \{ content: ""; display: table; clear: both; \}/);
  const taken = lower(".a { aspect-ratio: 16 / 9 }\n.a::before { content: 'x' }");
  assert.match(taken.css, /aspect-ratio: 16 \/ 9/);
  assert.equal(taken.report.notes.get("aspect-ratio left").length, 1);
  const flexBox = lower(".a { display: flex; aspect-ratio: 1 }");
  assert.match(flexBox.css, /aspect-ratio: 1/);
  const image = lower("img.a { aspect-ratio: 1 }");
  assert.match(image.css, /aspect-ratio: 1/);
});

test("a glass token and a blurred background are made close to opaque where there is no backdrop-filter", () => {
  const { css } = lower(":root { --hera-glass: rgba(30, 30, 34, 0.62); --hera-glass-hover: rgba(70, 70, 76, 0.85) }\n.a { background: rgba(0, 0, 0, 0.4); backdrop-filter: blur(4px) }\n.b { background: rgba(0, 0, 0, 0.4) }");
  assert.match(css, /--hera-glass: rgba\(30, 30, 34, 0\.92\)/);
  assert.match(css, /--hera-glass-hover: rgba\(70, 70, 76, 0\.92\)/);
  assert.match(css, /\.a \{\s+background: rgba\(0, 0, 0, 0\.88\)/);
  assert.match(css, /\.b \{\s+background: rgba\(0, 0, 0, 0\.4\)/);
});

test("colours: hex, rgb() and rgba() are read, anything else isn't", () => {
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("rgba(0 0 0 / 50%)"), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.equal(parseColor("var(--x)"), null);
});

test("through lightningcss: nesting, prefixes and ranges are lowered, and what it must not touch is left to the transforms", () => {
  const { css } = lower(".a { &:hover { color: red } width: clamp(1px, 2vw, 3px); margin-inline: 4px } @media (width >= 600px) { .b { color: blue } }", { lightning: true });
  assert.match(css, /\.a:hover/);
  assert.match(css, /width: 3px;\s+width: clamp\(1px, 2vw, 3px\)/);
  assert.match(css, /margin-left: 4px;\s+margin-right: 4px/);
  assert.match(css, /min-width: 600px/);
  assert.doesNotMatch(css, /:dir\(/);
});

test("math: a declaration that reads var() is replaced, not given a fallback, because it would always parse and win", () => {
  const { css, report } = lower(".a { bottom: calc(var(--o) + clamp(28px, 5vh, 56px)); width: min(560px, 44vw) }");
  assert.equal(flat(css), ".a { bottom: calc(var(--o) + 5vh); width: 560px; width: min(560px, 44vw); }");
  assert.equal(report.counts.get("math: var() declaration replaced"), 1);
});

test("a flex container's selector is recorded, for the script that gives its bare text a box", () => {
  const { report } = lower(".btn { display: inline-flex; gap: 8px }\n.grid { display: grid; gap: 4px }");
  assert.deepEqual([...report.flexContainers], [".btn"]);
});
