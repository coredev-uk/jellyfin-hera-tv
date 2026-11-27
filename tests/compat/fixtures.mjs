// Generates the media the compatibility run scans, in Jellyfin's naming, with no internet:
//
//   Films/Big Buck Bunny (2008)/Big Buck Bunny (2008).mkv      (+ .nfo, poster, backdrop, logo)
//   Films/Sintel (2010)/Sintel (2010).mkv
//   TV Shows/Pioneer One (2010)/Season 01/Pioneer One (2010) - S01E01.mkv  (and S01E02)
//
// The titles read as real ones but nothing is fetched: the synopsis, year and artwork come from
// the .nfo files and images beside the media, which Jellyfin reads locally. That gives Hera's
// pages a poster, a backdrop, a logo and an overview to lay out, as a real library would.
//
// Run on its own: `node fixtures.mjs <dir>` (needs ffmpeg on the PATH, or FFMPEG=/path/to/ffmpeg).
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SECONDS = 150; // longer than the soak in run.mjs, so the film is still playing when the server is judged

// One ffmpeg run makes every source file; the layout below copies them into place. VP9 and Opus
// because the Chromium that Playwright ships has no H.264 or AAC, so Jellyfin can direct-play
// them without transcoding.
export const ffmpegArgs = () => [
  "-y", "-loglevel", "error",
  "-f", "lavfi", "-i", `testsrc=size=320x180:rate=15:duration=${SECONDS}`,
  "-f", "lavfi", "-i", `sine=frequency=440:duration=${SECONDS}`,
  "-f", "lavfi", "-i", "testsrc2=size=200x300",
  "-f", "lavfi", "-i", "testsrc2=size=640x360",
  "-f", "lavfi", "-i", "testsrc=size=300x100",
  "-map", "0:v", "-map", "1:a", "-c:v", "libvpx-vp9", "-b:v", "80k", "-deadline", "realtime", "-cpu-used", "8",
  "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "24k", "-shortest", "video.mkv",
  "-map", "2:v", "-frames:v", "1", "poster.jpg",
  "-map", "3:v", "-frames:v", "1", "backdrop.jpg",
  "-map", "4:v", "-frames:v", "1", "logo.png",
];

const xml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const film = (title, year, plot, runtime) =>
  `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<movie>\n  <title>${xml(title)}</title>\n  <year>${year}</year>\n  <plot>${xml(plot)}</plot>\n  <runtime>${runtime}</runtime>\n  <genre>Animation</genre>\n  <mpaa>U</mpaa>\n  <actor>\n    <name>Hera Tester</name>\n    <role>Narrator</role>\n    <type>Actor</type>\n  </actor>\n</movie>\n`;

const show = (title, year, plot) =>
  `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<tvshow>\n  <title>${xml(title)}</title>\n  <year>${year}</year>\n  <plot>${xml(plot)}</plot>\n  <genre>Drama</genre>\n</tvshow>\n`;

const episode = (title, season, number, plot) =>
  `<?xml version="1.0" encoding="utf-8" standalone="yes"?>\n<episodedetails>\n  <title>${xml(title)}</title>\n  <season>${season}</season>\n  <episode>${number}</episode>\n  <plot>${xml(plot)}</plot>\n</episodedetails>\n`;

const FILMS = [
  ["Big Buck Bunny", 2008, "A giant rabbit takes revenge on three rodents who bully him."],
  ["Sintel", 2010, "A young woman searches for the dragon she raised from a cub."],
];

/** Writes the library into `dir` (Films/, TV Shows/) using `makeSources(workDir)` for the raw files. */
export const generate = async (dir, makeSources) => {
  const work = await mkdtemp(join(tmpdir(), "hera-fixtures-"));
  try {
    await makeSources(work);
    const put = async (folder, source, name) => copyFile(join(work, source), join(folder, name));

    for (const [title, year, plot] of FILMS) {
      const name = `${title} (${year})`;
      const folder = join(dir, "Films", name);
      await mkdir(folder, { recursive: true });
      await put(folder, "video.mkv", `${name}.mkv`);
      await put(folder, "poster.jpg", "poster.jpg");
      await put(folder, "backdrop.jpg", "backdrop.jpg");
      await put(folder, "logo.png", "logo.png");
      await writeFile(join(folder, `${name}.nfo`), film(title, year, plot, 1));
    }

    const series = join(dir, "TV Shows", "Pioneer One (2010)");
    const season = join(series, "Season 01");
    await mkdir(season, { recursive: true });
    await put(series, "poster.jpg", "poster.jpg");
    await put(series, "backdrop.jpg", "backdrop.jpg");
    await put(series, "logo.png", "logo.png");
    await writeFile(join(series, "tvshow.nfo"), show("Pioneer One", 2010, "The first Mars colonists lose contact with Earth."));
    for (const [number, title] of [[1, "Earthfall"], [2, "Landing"]]) {
      const name = `Pioneer One (2010) - S01E0${number}`;
      await put(season, "video.mkv", `${name}.mkv`);
      await writeFile(join(season, `${name}.nfo`), episode(title, 1, number, `Episode ${number} of the first season.`));
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
};

/** Spawns a command and rejects with its output when it fails. */
export const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${output}`))));
  });

/** The sources made by the ffmpeg on this machine. */
export const hostSources = (ffmpeg = process.env.FFMPEG || "ffmpeg") => (work) => run(ffmpeg, ffmpegArgs(), { cwd: work });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node fixtures.mjs <dir>");
    process.exit(2);
  }
  await generate(dir, hostSources());
  console.log(`Fixture media written to ${dir}`);
}
