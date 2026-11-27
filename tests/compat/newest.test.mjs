// `node --test "tests/**/*.test.mjs"`: which Jellyfin.Controller the nightly run builds against.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compare, pick } from "./newest.mjs";

test("SemVer order: a prerelease is older than its release, and numbers compare as numbers", () => {
  assert.ok(compare("12.0.0-rc2", "12.0.0") < 0);
  assert.ok(compare("12.0.0-rc.7", "12.0.0-rc.10") < 0, "dotted numeric identifiers compare as numbers");
  assert.ok(compare("12.0.0-rc7", "12.0.0-rc10") > 0, "alphanumeric ones compare as text, as NuGet orders them");
  assert.ok(compare("12.10.0", "12.4.0") > 0);
  assert.ok(compare("12.4.0-rc1", "12.4.0-beta2") > 0);
  assert.equal(compare("12.4.0", "12.4.0"), 0);
});

const NUGET = ["12.0.0-rc2", "12.0.0-rc10", "12.0.0-rc7", "12.0.0", "12.3.0", "12.4.0", "10.11.8"];

test("the newest release, and a prerelease only when it is newer than every release", () => {
  assert.equal(pick(NUGET, "stable"), "12.4.0");
  assert.equal(pick(NUGET, "prerelease"), null);
  assert.equal(pick([...NUGET, "12.5.0-rc1", "12.5.0-rc2"], "prerelease"), "12.5.0-rc2");
  assert.equal(pick([...NUGET, "12.5.0-rc1", "12.5.0"], "stable"), "12.5.0");
  assert.equal(pick([...NUGET, "12.5.0-rc1", "12.5.0"], "prerelease"), null);
});
