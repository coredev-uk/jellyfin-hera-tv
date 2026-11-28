// Hera's scripts for Chromium 53 to 85: the syntax lowered per file by Babel, the built-ins and
// browser APIs they use supplied by one prelude (core-js for what the scripts call, plus
// polyfills/dom.js), and a parse at the language level Chromium 53 reads to make sure nothing
// slipped through.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { transformAsync } from "@babel/core";
import presetEnv from "@babel/preset-env";
import * as acorn from "acorn";
import * as walk from "acorn-walk";
import { build } from "esbuild";
import { CORE_JS, UNAVAILABLE } from "./features.mjs";

const require = createRequire(import.meta.url);
const compat = require("core-js-compat/compat.js");
const coreJsVersion = require("core-js/package.json").version;

const here = fileURLToPath(new URL(".", import.meta.url));

/** The newest ECMAScript Chromium 53 parses: 2016 (exponentiation, but no async functions, object spread or trailing commas in calls). */
export const ECMA_VERSION = 2016;

/** What a core-js module replaces in the browser rather than adds to it: never bundled (see features.mjs). */
const REPLACING = /core-js\/modules\/(es\.(promise\.(constructor|js)|regexp\.(exec|constructor)|string\.(replace|split|match|search)|array\.sort|json\.stringify|error\.cause|symbol\.constructor)|web\.url(\.constructor)?)\.js$/;

/** Throws where `code` uses syntax Chromium 53 can't parse. */
export const checkSyntax = (code, name) => {
  try {
    acorn.parse(code, { ecmaVersion: ECMA_VERSION, sourceType: "script" });
  } catch (error) {
    const line = error.loc ? `${name}:${error.loc.line}:${error.loc.column}` : name;
    const text = error.loc ? code.split("\n")[error.loc.line - 1].trim().slice(0, 120) : "";
    throw new Error(`${line}: ${error.message.replace(/ \(\d+:\d+\)$/, "")} (Chromium 53 parses ES${ECMA_VERSION})\n    ${text}`);
  }
};

/** The member names, `Object.entries`-style static members and global names a script uses. */
export const usedNames = (source) => {
  const names = new Set();
  walk.full(acorn.parse(source, { ecmaVersion: "latest", sourceType: "script" }), (node) => {
    if (node.type === "MemberExpression" && !node.computed && node.property.type === "Identifier") {
      names.add(node.property.name);
      if (node.object.type === "Identifier") names.add(`${node.object.name}.${node.property.name}`);
    } else if (node.type === "Identifier") {
      names.add(node.name);
    }
  });
  return names;
};

/** The core-js modules the names call for, and the names that nothing here can supply. */
export const featuresFor = (names) => {
  const modules = new Set();
  for (const [name, list] of Object.entries(CORE_JS)) if (names.has(name)) for (const id of list) modules.add(id);
  return { modules: [...modules].sort(), unavailable: UNAVAILABLE.filter((name) => names.has(name)) };
};

/** One script with its syntax lowered for Chromium 53, kept a self-contained function so Babel's helpers stay inside it. */
export const lowerScript = async (source, filename) => {
  const result = await transformAsync(source, {
    filename,
    babelrc: false,
    configFile: false,
    sourceType: "script",
    comments: false,
    compact: false,
    assumptions: { noDocumentAll: true, objectRestNoSymbols: true, setSpreadProperties: true, ignoreFunctionLength: true },
    presets: [[presetEnv, { targets: { chrome: "53" }, modules: false }]],
  });
  return `(function () {\n${result.code}\n}).call(this);\n`;
};

/** The prelude: core-js's modules for `modules` (those Chromium 53 needs), then polyfills/dom.js and polyfills/layout.js (which is given the selectors of the flex containers the stylesheet gave margins), as one script. */
export const buildPrelude = async (modules, flexContainers = []) => {
  const needed = compat({ modules, targets: { chrome: "53" } }).list;
  const entry = [...needed.map((id) => `import "core-js/modules/${id}.js";`), ...["dom", "layout"].map((name) => `import ${JSON.stringify(`${here}polyfills/${name}.js`)};`)].join("\n");
  const result = await build({
    stdin: { contents: entry, resolveDir: fileURLToPath(new URL("../../", import.meta.url)), sourcefile: "legacy-prelude.js" },
    bundle: true,
    format: "iife",
    target: "chrome53",
    platform: "browser",
    legalComments: "none",
    write: false,
    metafile: true,
    define: { __HERA_FLEX_CONTAINERS__: JSON.stringify(flexContainers) },
    logLevel: "silent",
  });
  const bundled = Object.keys(result.metafile.inputs);
  const replacing = bundled.filter((path) => REPLACING.test(path));
  if (replacing.length) {
    throw new Error(`the prelude would replace built-ins the browser already has: ${replacing.join(", ")}. A core-js module in features.mjs pulls them in; see the note there.`);
  }
  const code = `/* core-js ${coreJsVersion} (MIT, © Denis Pushkarev, https://github.com/zloirock/core-js) and Hera TV's own DOM stand-ins, for browsers before Chromium 86. */\n${result.outputFiles[0].text}`;
  return { code, modules: needed, bundled: bundled.filter((path) => path.includes("core-js/modules/")).length };
};

export const readSource = (path) => readFileSync(path, "utf8");
