#!/usr/bin/env node
// Builds the legacy web assets: web/*.js and web/*.css rewritten for Chromium 53 to 85 (Tizen 5's
// browser, webOS 4's) into web-legacy/, which the project embeds when it is there. WebAssets.cs
// puts them together as hera-bundle-legacy.js and hera-bundle-legacy.css, in its own manifest's
// order; the page gets them instead of the modern bundles when its browser is one of those (see
// WebInjection.cs). Anything the old engines can't parse fails the build.
//
//   node tools/legacy/build.mjs        (npm run build:legacy)
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { brotliCompressSync, constants } from "node:zlib";
import { fileURLToPath } from "node:url";
import { manifestEntries } from "../../tests/compat/manifest.mjs";
import { describe, lowerStylesheets } from "./css.mjs";
import { buildPrelude, checkSyntax, featuresFor, lowerScript, usedNames } from "./js.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const out = `${root}web-legacy/`;

const brotli = (text) => brotliCompressSync(Buffer.from(text), { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 22 } }).length;
const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

const main = async () => {
  const sources = readdirSync(`${root}web`).filter((name) => /^hera-[\w-]+\.(css|js)$/.test(name));
  const order = manifestEntries(readFileSync(`${root}WebAssets.cs`, "utf8")).map((entry) => entry.file);
  const scripts = [...new Set(order.filter((name) => name.endsWith(".js")))];
  const styles = [...new Set(order.filter((name) => name.endsWith(".css")))];
  const unlisted = sources.filter((name) => !order.includes(name));
  if (unlisted.length) throw new Error(`${unlisted.join(", ")} not in WebAssets.cs's manifest`);

  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });

  // Scripts: which APIs they use decides the prelude; each is then lowered on its own.
  const names = new Set();
  const lowered = [];
  for (const name of scripts) {
    const source = readFileSync(`${root}web/${name}`, "utf8");
    for (const used of usedNames(source)) names.add(used);
    const { unavailable } = featuresFor(usedNames(source));
    if (unavailable.length) throw new Error(`web/${name} uses ${unavailable.join(", ")}, which Chromium 53 to 85 lack and nothing in tools/legacy provides (add a polyfill, or guard the call)`);
    const code = await lowerScript(source, name);
    checkSyntax(code, name);
    lowered.push({ name, code });
  }
  // Stylesheets, in cascade order: some rewrites look at what other files say about an element.
  const css = lowerStylesheets(styles.map((name) => ({ name, css: readFileSync(`${root}web/${name}`, "utf8") })));
  // Fallbacks written by hand for what the transforms can't know (tools/legacy/extra/<stylesheet>),
  // at the end of the stylesheet they belong to.
  for (const file of css.files) {
    const extra = `${root}tools/legacy/extra/${file.name}`;
    if (existsSync(extra)) {
      file.css += `\n${readFileSync(extra, "utf8")}`;
      css.report.count("extra: stylesheets with hand-written fallbacks");
    }
    writeFileSync(`${out}${file.name}`, file.css);
  }
  const report = describe(css.report);
  writeFileSync(`${out}legacy-report.txt`, `${report}\n`);

  // The prelude is told which containers the stylesheet gave margins in place of a gap.
  const { modules } = featuresFor(names);
  const prelude = await buildPrelude(modules, [...css.report.flexContainers]);
  checkSyntax(prelude.code, "hera-polyfills.js");
  writeFileSync(`${out}hera-polyfills.js`, prelude.code);
  for (const { name, code } of lowered) writeFileSync(`${out}${name}`, code);

  const script = [prelude.code, ...lowered.map((file) => file.code)].join("");
  const sheet = css.files.map((file) => file.css).join("");
  const modern = (names) => names.map((name) => readFileSync(`${root}web/${name}`, "utf8")).join("");
  console.log(`legacy scripts: ${kb(Buffer.byteLength(script))}, ${kb(brotli(script))} br (modern ${kb(Buffer.byteLength(modern(scripts)))}, ${kb(brotli(modern(scripts)))} br); prelude ${kb(Buffer.byteLength(prelude.code))} with ${prelude.modules.length} core-js modules`);
  console.log(`legacy styles:  ${kb(Buffer.byteLength(sheet))}, ${kb(brotli(sheet))} br (modern ${kb(Buffer.byteLength(modern(styles)))}, ${kb(brotli(modern(styles)))} br)`);
  console.log(`\n${report}\n\n(also in web-legacy/legacy-report.txt)`);
};

main().catch((error) => {
  console.error(`::error::${error.message}`);
  process.exit(1);
});
