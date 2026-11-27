#!/usr/bin/env node
// Checks that the places that name the Jellyfin this build is for agree, and that the plugin
// leans on the same Sqlite as the server it will run in:
//
//   node versions.mjs                 # all checks; the Sqlite one reads Jellyfin's file from GitHub
//   node versions.mjs --offline       # without that one
//   node versions.mjs --props <file>  # the Sqlite check against a local Directory.Packages.props
//
// 1. The major.minor of Jellyfin.Controller in the project file, which is the Jellyfin the compat
//    run starts, equals the major.minor of meta.json's targetAbi (Jellyfin loads a plugin on any
//    server at or above its targetAbi, so a lower one lets an older server install this build) and
//    is one of Compatibility.Tested (otherwise every client reports Hera as running on an untested Jellyfin).
// 2. Jellyfin.Model is the same version as Jellyfin.Controller.
// 3. Microsoft.Data.Sqlite.Core and any SQLitePCLRaw package in the project file are the version
//    Jellyfin's own Directory.Packages.props pins for that release (its Git tag, v12.4 for 12.4.0). The server supplies those assemblies,
//    and a plugin built against a newer one fails to load them (FileNotFoundException), which stops
//    the whole server when a background service touches it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (name) => readFileSync(`${root}${name}`, "utf8");

/** `<PackageReference Include="X" Version="1.2.3" …/>` entries as { name: version }. */
export const packageReferences = (text) =>
  Object.fromEntries([...text.matchAll(/<PackageReference\s+Include="([^"]+)"\s+Version="([^"]+)"/g)].map((m) => [m[1], m[2]]));

/** `<PackageVersion Include="X" Version="1.2.3" />` entries of a Directory.Packages.props, as { name: version }. */
export const packageVersions = (text) =>
  Object.fromEntries([...text.matchAll(/<PackageVersion\s+Include="([^"]+)"\s+Version="([^"]+)"/g)].map((m) => [m[1], m[2]]));

/** The major.minor of a version string such as 12.4.0 or 12.4.0.0. */
export const majorMinor = (version) => {
  const match = /^(\d+)\.(\d+)/.exec(version ?? "");
  return match ? `${match[1]}.${match[2]}` : null;
};

/** The strings in `Tested = [ "12.4", … ]` of Compatibility.cs. */
export const testedVersions = (source) => {
  const match = /Tested\s*=\s*\[([^\]]*)\]/.exec(source);
  return match ? [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : null;
};

/** What the three places say about the Jellyfin release; returns the problems. */
export const checkRelease = ({ project, meta, compatibility }) => {
  const problems = [];
  const references = packageReferences(project);
  const controller = references["Jellyfin.Controller"];
  const model = references["Jellyfin.Model"];
  if (!controller) return ["the project file has no Jellyfin.Controller package"];

  const wanted = majorMinor(controller);
  if (model !== controller) problems.push(`Jellyfin.Model is ${model ?? "missing"} but Jellyfin.Controller is ${controller}; they ship together`);

  const abi = majorMinor(meta.targetAbi);
  if (abi !== wanted) problems.push(`meta.json targetAbi is ${meta.targetAbi} (${abi}) but Jellyfin.Controller is ${controller} (${wanted}); change targetAbi to ${wanted}.0.0`);

  const tested = testedVersions(compatibility);
  if (!tested) problems.push("could not find the Tested array in Compatibility.cs (it must stay one array on one line)");
  else if (!tested.includes(wanted)) problems.push(`Compatibility.Tested is [${tested.join(", ")}] but Jellyfin.Controller is ${controller}; add "${wanted}" once Hera has been checked against it`);
  return problems;
};

/** The Sqlite packages of the project file against what Jellyfin pins; returns the problems. */
export const checkSqlite = ({ project, props, tag }) => {
  const problems = [];
  const pinned = packageVersions(props);
  const mine = Object.entries(packageReferences(project)).filter(([name]) => /^(Microsoft\.Data\.Sqlite|SQLitePCLRaw)/.test(name));
  if (!mine.some(([name]) => name.startsWith("Microsoft.Data.Sqlite"))) return ["the project file has no Microsoft.Data.Sqlite package: this check no longer covers what the plugin reads"];

  for (const [name, version] of mine) {
    // The server pins the full provider; the plugin compiles against its core, which ships in the same release.
    const theirs = pinned[name] ?? (name === "Microsoft.Data.Sqlite.Core" ? pinned["Microsoft.Data.Sqlite"] : undefined);
    if (theirs === undefined) problems.push(`Jellyfin ${tag} does not pin ${name}; the project file's ${version} may not be what the server has`);
    else if (theirs !== version) problems.push(`${name} is ${version} in the project file but Jellyfin ${tag} ships ${theirs}; the server's own assembly is the only one that loads, so they must match`);
  }
  return problems;
};

/**
 * Jellyfin's file for a release. Its Git tags have been v12.4 for the first release of a minor and
 * could be v12.4.1 for a patch, so the full version is tried first and then its major.minor.
 * Returns { tag, text }.
 */
const fetchProps = async (version) => {
  const candidates = [...new Set([`v${version}`, `v${majorMinor(version)}`])];
  let last;
  for (const tag of candidates) {
    const url = `https://raw.githubusercontent.com/jellyfin/jellyfin/${tag}/Directory.Packages.props`;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
        if (response.ok) return { tag, text: await response.text() };
        last = new Error(`${url} answered ${response.status}`);
        if (response.status === 404) break;
      } catch (error) {
        last = error;
      }
      await new Promise((done) => setTimeout(done, attempt * 2000));
    }
  }
  throw last;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { offline: { type: "boolean", default: false }, props: { type: "string" } } });
  const project = read("Jellyfin.Plugin.HeraTv.csproj");
  const controller = packageReferences(project)["Jellyfin.Controller"];
  const problems = checkRelease({ project, meta: JSON.parse(read("meta.json")), compatibility: read("Compatibility.cs") });

  if (!values.offline) {
    const { tag, text } = values.props ? { tag: `v${controller}`, text: readFileSync(values.props, "utf8") } : await fetchProps(controller);
    problems.push(...checkSqlite({ project, props: text, tag }));
  }

  for (const problem of problems) console.error(`::error::${problem}`);
  if (problems.length) process.exit(1);
  console.log(`Jellyfin ${controller}: targetAbi, Tested${values.offline ? "" : " and Sqlite"} agree`);
}
