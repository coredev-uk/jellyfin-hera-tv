// `node --test tests/compat`: the release checks must fail for the changes they are there to catch.
import assert from "node:assert/strict";
import { test } from "node:test";
import { checkRelease, checkSqlite, majorMinor, packageReferences, packageVersions, testedVersions } from "./versions.mjs";

const project = (controller, model = controller, sqlite = "10.0.14") => `
<Project><ItemGroup>
  <PackageReference Include="Jellyfin.Controller" Version="${controller}" ExcludeAssets="runtime" />
  <PackageReference Include="Jellyfin.Model" Version="${model}" ExcludeAssets="runtime" />
  <PackageReference Include="Microsoft.Data.Sqlite.Core" Version="${sqlite}" ExcludeAssets="runtime" />
</ItemGroup></Project>`;
const compat = (...versions) => `public static readonly string[] Tested = [${versions.map((v) => `"${v}"`).join(", ")}];`;

test("parsing", () => {
  assert.deepEqual(packageReferences(project("12.4.0")), { "Jellyfin.Controller": "12.4.0", "Jellyfin.Model": "12.4.0", "Microsoft.Data.Sqlite.Core": "10.0.14" });
  assert.deepEqual(packageVersions('<PackageVersion Include="Microsoft.Data.Sqlite" Version="10.0.14" />'), { "Microsoft.Data.Sqlite": "10.0.14" });
  assert.equal(majorMinor("12.4.0.0"), "12.4");
  assert.deepEqual(testedVersions(compat("12.4", "12.5")), ["12.4", "12.5"]);
});

test("a consistent release passes", () => {
  assert.deepEqual(checkRelease({ project: project("12.4.0"), meta: { targetAbi: "12.4.0.0" }, compatibility: compat("12.4") }), []);
});

test("a Controller bump that leaves targetAbi or Tested behind fails", () => {
  const problems = checkRelease({ project: project("12.5.0"), meta: { targetAbi: "12.4.0.0" }, compatibility: compat("12.4") });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /targetAbi is 12\.4\.0\.0/);
  assert.match(problems[1], /Tested is \[12\.4\] but Jellyfin\.Controller is 12\.5\.0/);
  assert.match(checkRelease({ project: project("12.4.0", "12.3.0"), meta: { targetAbi: "12.4.0.0" }, compatibility: compat("12.4") })[0], /Jellyfin\.Model is 12\.3\.0/);
});

test("Sqlite must be what Jellyfin ships", () => {
  const props = '<PackageVersion Include="Microsoft.Data.Sqlite" Version="10.0.14" />';
  assert.deepEqual(checkSqlite({ project: project("12.4.0"), props, tag: "v12.4" }), []);
  assert.match(checkSqlite({ project: project("12.4.0", "12.4.0", "10.0.15"), props, tag: "v12.4" })[0], /10\.0\.15 in the project file but Jellyfin v12\.4 ships 10\.0\.14/);
  assert.match(checkSqlite({ project: project("12.4.0"), props: "<Project />", tag: "v12.4" })[0], /does not pin Microsoft\.Data\.Sqlite\.Core/);
});
