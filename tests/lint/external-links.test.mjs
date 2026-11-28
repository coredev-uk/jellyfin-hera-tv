// Every link out of Jellyfin goes through kit.externalLink (web/hera-tv.js), which leaves it out of
// the TV layout: a TV has no new tab to open. Setting target="_blank" (or opening a window) anywhere
// else would put an unpressable link back on the TV, so this test fails on it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const WEB = new URL("../../web/", import.meta.url).pathname;
const HOME = "hera-tv.js";
const OUTSIDE = [/["'`]_blank["'`]/, /\.target\s*=(?!=)/, /\bwindow\.open\s*\(/];

test("only kit.externalLink opens a new tab", async () => {
  const offenders = [];
  for (const file of (await readdir(WEB)).filter((name) => name.endsWith(".js") && name !== HOME)) {
    const lines = (await readFile(join(WEB, file), "utf8")).split("\n");
    lines.forEach((line, index) => {
      if (OUTSIDE.some((pattern) => pattern.test(line))) offenders.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], `use kit.externalLink instead:\n${offenders.join("\n")}`);
});

test("kit.externalLink is the one place in core that opens a new tab", async () => {
  const lines = (await readFile(join(WEB, HOME), "utf8")).split("\n");
  const opening = lines.filter((line) => /target:\s*"_blank"/.test(line));
  assert.equal(opening.length, 1, "hera-tv.js should set target=\"_blank\" only inside externalLink");
});
