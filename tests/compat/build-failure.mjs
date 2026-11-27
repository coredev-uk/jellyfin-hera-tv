#!/usr/bin/env node
// Writes the same summary.json and summary.md as run.mjs for a nightly build that did not compile
// (Hera rebuilt against a newer Jellyfin.Controller), so the per-tag issue shows the compiler's
// errors instead of nothing:
//
//   node build-failure.mjs --log build.log --controller 12.5.0 --tag latest --out results
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { log: { type: "string" }, controller: { type: "string" }, tag: { type: "string" }, out: { type: "string", default: "results" } },
});
if (!values.log || !values.controller || !values.tag) {
  console.error("usage: node build-failure.mjs --log <file> --controller <version> --tag <image tag> [--out <dir>]");
  process.exit(2);
}

const text = await readFile(values.log, "utf8").catch(() => "");
// MSBuild repeats each diagnostic once per project and again in the summary: keep each once.
const errors = [...new Set(text.split("\n").filter((line) => /\berror [A-Z]+\d+:/.test(line)).map((line) => line.trim().replace(/\s+\[[^\]]+\]$/, "")))];
const shown = errors.slice(0, 15);

const summary = {
  tag: values.tag,
  jellyfin: null,
  status: "failed",
  error: null,
  failures: [`Hera does not compile against Jellyfin.Controller ${values.controller}: ${errors.length ? `${errors.length} error(s)` : "the build failed (see the run's log)"}`, ...shown],
  warnings: [],
  pages: [],
  playback: null,
};

await mkdir(values.out, { recursive: true });
await writeFile(`${values.out}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
await writeFile(
  `${values.out}/summary.md`,
  [
    `**Hera rebuilt against Jellyfin.Controller \`${values.controller}\` (for Jellyfin \`${values.tag}\`): failed to build**`,
    "",
    ...(shown.length ? ["```text", ...shown, ...(errors.length > shown.length ? [`… ${errors.length - shown.length} more`] : []), "```"] : ["The build log has no compiler errors; see the run's log."]),
    "",
  ].join("\n"),
);
