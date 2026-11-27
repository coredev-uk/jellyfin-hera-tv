#!/usr/bin/env node
// Which Jellyfin.Controller the nightly run rebuilds Hera against:
//
//   node newest.mjs stable        # the newest release on NuGet (12.5.0)
//   node newest.mjs prerelease    # the newest prerelease, when it is newer than every release (12.6.0-rc1), else nothing
//
// Hera is built against one Jellyfin release (the project file) and runs on whatever the server has,
// so a member Jellyfin removed shows up on a live server as a MissingMethodException. Building
// against the newest packages turns that into a compile error found the night it is published.
import { fileURLToPath } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/;

/** Orders two SemVer 2 versions; a prerelease is older than its release, and its parts compare one by one. */
export const compare = (a, b) => {
  const [x, y] = [SEMVER.exec(a), SEMVER.exec(b)];
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let part = 1; part <= 3; part += 1) {
    if (Number(x[part]) !== Number(y[part])) return Number(x[part]) - Number(y[part]);
  }
  if (!x[4] || !y[4]) return x[4] ? -1 : y[4] ? 1 : 0;
  const [p, q] = [x[4].split("."), y[4].split(".")];
  for (let i = 0; i < Math.max(p.length, q.length); i += 1) {
    if (p[i] === undefined) return -1;
    if (q[i] === undefined) return 1;
    const numeric = [/^\d+$/.test(p[i]), /^\d+$/.test(q[i])];
    if (numeric[0] && numeric[1] && Number(p[i]) !== Number(q[i])) return Number(p[i]) - Number(q[i]);
    if (numeric[0] !== numeric[1]) return numeric[0] ? -1 : 1;
    if (p[i] !== q[i] && !(numeric[0] && numeric[1])) return p[i] < q[i] ? -1 : 1;
  }
  return 0;
};

/** The version to rebuild against for `kind`, or null when there is none (no prerelease newer than the releases). */
export const pick = (versions, kind) => {
  const valid = versions.filter((version) => SEMVER.test(version)).sort(compare);
  const releases = valid.filter((version) => !SEMVER.exec(version)[4]);
  const newestRelease = releases.at(-1) ?? null;
  if (kind === "stable") return newestRelease;
  const newestAny = valid.at(-1) ?? null;
  return newestAny && newestAny !== newestRelease ? newestAny : null;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const kind = process.argv[2];
  if (kind !== "stable" && kind !== "prerelease") {
    console.error("usage: node newest.mjs stable|prerelease");
    process.exit(2);
  }
  const response = await fetch("https://api.nuget.org/v3-flatcontainer/jellyfin.controller/index.json", { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`NuGet answered ${response.status}`);
  const { versions } = await response.json();
  console.log(pick(versions, kind) ?? "");
}
