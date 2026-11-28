#!/usr/bin/env node
// Checks WebAssets.cs's manifest (which files make up the bundles, in order, and which module each
// stylesheet belongs to) against what web/ holds and what the scripts register:
//
//   - every web/*.css and web/*.js is in the manifest, and every file the manifest names exists: the
//     project embeds all of web/, so a file left out of the manifest is embedded and never served
//   - a stylesheet's module is one a script registers (`register({ name: "…" })`, or "core"): the
//     bundler gates its rules on html.hera-m-<module>, so a misspelt one is a stylesheet that never applies
//   - no two scripts register the same module name
//   - the module names the server accepts in a health report (Compatibility.cs, where it still has a list)
//     are the registered ones, so a report from a new module is not dropped and a retired one is not kept
//
//   node manifest.mjs
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/**
 * The module names each script registers, by file: `register({ name: "x" … })`, where the name is
 * a literal or a constant of the file (`const MODULE = "x"`), plus the core's own.
 */
export const registeredModules = (files) => {
  const byFile = new Map();
  for (const [file, text] of files) {
    const constant = (identifier) => new RegExp(`\\bconst\\s+${identifier}\\s*=\\s*"([^"]+)"`).exec(text)?.[1];
    const names = [...text.matchAll(/\bregister\(\s*\{\s*name:\s*(?:"([^"]+)"|([A-Za-z_]\w*))/g)].map((match) => match[1] ?? constant(match[2]) ?? `<${match[2]}>`);
    // The core's built-in features report under its own name; it is not registered like the others.
    if (file === "hera-tv.js") names.push("core");
    if (names.length) byFile.set(file, names);
  }
  return byFile;
};

/**
 * The manifest in WebAssets.cs: each Hera file named in a string literal, with the module name in
 * the literal beside it on the same line (after it, or before it), else null, and for a stylesheet
 * the script named on the same line. It does not depend on how the entries are spelt, only on a
 * file, its module and its script sharing a line.
 */
export const manifestEntries = (source) => {
  const entries = [];
  for (const line of source.split("\n")) {
    const literals = [...line.matchAll(/"([^"\\]*)"/g)].map((match) => match[1]);
    const isHeraFile = (value) => /^hera-[\w-]+\.(css|js)$/.test(value) && !/-bundle(-legacy)?\.(css|js)$/.test(value);
    const script = literals.find((value) => isHeraFile(value) && value.endsWith(".js")) ?? null;
    literals.forEach((literal, index) => {
      if (!isHeraFile(literal)) return;
      const isFile = (value) => /\.(css|js|woff2)$/.test(value ?? "");
      const isModule = (value) => value !== undefined && !isFile(value) && /^[a-z][a-z0-9-]*$/.test(value);
      const module = isModule(literals[index + 1]) ? literals[index + 1] : isModule(literals[index - 1]) ? literals[index - 1] : null;
      entries.push({ file: literal, module, ...(literal.endsWith(".css") ? { script } : {}) });
    });
  }
  return entries;
};

/** The names in Compatibility.cs's KnownModules array, or null when there is none. */
export const knownModules = (source) => {
  const match = /KnownModules\s*=\s*\[([^\]]*)\]/s.exec(source);
  return match ? [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null;
};

export const check = ({ webFiles, scripts, manifestSource, compatSource }) => {
  const problems = [];
  const entries = manifestEntries(manifestSource);
  const inManifest = new Set(entries.map((entry) => entry.file));
  const present = new Set(webFiles);

  for (const file of webFiles) if (!inManifest.has(file)) problems.push(`web/${file} is embedded but not in WebAssets.cs's manifest, so it is never served`);
  for (const file of inManifest) if (!present.has(file)) problems.push(`WebAssets.cs's manifest names ${file}, which is not in web/`);
  const twice = entries.map((entry) => entry.file).filter((file, index, all) => all.indexOf(file) !== index);
  for (const file of new Set(twice)) problems.push(`${file} appears more than once in WebAssets.cs's manifest`);

  const registered = registeredModules(scripts);
  const owners = new Map();
  for (const [file, names] of registered) {
    for (const name of names) {
      if (owners.has(name)) problems.push(`module "${name}" is registered by both ${owners.get(name)} and ${file}`);
      owners.set(name, file);
    }
  }

  const sheets = entries.filter((entry) => entry.file.endsWith(".css"));
  if (sheets.length && sheets.every((entry) => entry.module === null)) {
    problems.push("WebAssets.cs's manifest maps no stylesheet to a module (the bundler gates each on html.hera-m-<module>)");
  }
  for (const { file, module, script } of sheets) {
    if (module === null) continue;
    if (!owners.has(module)) problems.push(`${file} is gated on module "${module}", which no script registers (registered: ${[...owners.keys()].join(", ")})`);
    // The entry names the script the module is registered by: a stylesheet gated on another file's module is mis-filed.
    else if (script && !registered.get(script)?.includes(module)) {
      problems.push(`${file} is gated on module "${module}" next to ${script}, which registers ${registered.get(script)?.join(", ") ?? "no module"} (module "${module}" is registered by ${owners.get(module)})`);
    }
  }

  const known = knownModules(compatSource);
  if (known) {
    for (const name of owners.keys()) if (!known.includes(name)) problems.push(`module "${name}" is registered but Compatibility.cs does not accept its health reports`);
    for (const name of known) if (!owners.has(name)) problems.push(`Compatibility.cs accepts health reports from "${name}", which no script registers`);
  }
  return problems;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const web = readdirSync(`${root}web`).filter((name) => /^hera-[\w-]+\.(css|js)$/.test(name));
  const scripts = web.filter((name) => name.endsWith(".js")).map((name) => [name, readFileSync(`${root}web/${name}`, "utf8")]);
  const problems = check({
    webFiles: web,
    scripts,
    manifestSource: readFileSync(`${root}WebAssets.cs`, "utf8"),
    compatSource: readFileSync(`${root}Compatibility.cs`, "utf8"),
  });
  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length) process.exit(1);
  console.log(`WebAssets.cs's manifest matches web/ (${web.length} files) and the registered modules`);
}
