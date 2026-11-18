// The Jellyfin release this build of Hera is tested against, read from the plugin itself so the
// compatibility run and the plugin can never disagree: the Jellyfin.Controller version in the
// project file (12.4.0) as a Docker Hub tag (12.4).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export const testedTag = () => {
  const project = readFileSync(`${repoRoot}Jellyfin.Plugin.HeraTv.csproj`, "utf8");
  const match = project.match(/Include="Jellyfin\.Controller"\s+Version="(\d+)\.(\d+)\.\d+/);
  if (!match) throw new Error("No Jellyfin.Controller version in Jellyfin.Plugin.HeraTv.csproj");
  return `${match[1]}.${match[2]}`;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(testedTag());
