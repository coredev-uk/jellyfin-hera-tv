# Compatibility test

Runs the built plugin inside a real Jellyfin server and drives the web client with Chromium. It
fails when Hera says a page is broken, so a Jellyfin release that changes the web client is caught
here and not on the server.

On each page it reads `window.HeraTV.health()` and fails if

- `window.HeraTV` is missing (the plugin's scripts did not run),
- `boot` is `safe` (Hera took itself off the tab),
- any module is `degraded` (a piece of Jellyfin's markup it needs is gone) or `disabled` (it kept throwing),
- a script under `/HeraTV/` throws (`pageerror`), or one of Hera's stylesheets or scripts answers 4xx or 5xx.

`boot: untested` (the server is a newer Jellyfin than the one Hera was built against), a module that
threw once and recovered, and errors from Jellyfin's own scripts are warnings, so the nightly run
against newer releases stays readable.

The pages are home, the Films library, a film, the series, an episode, the collection, search, the
Dashboard and the video player (the film is started and plays for 2 s). Each is screenshotted.

## Run it locally

You need docker or podman, Node 22 or later, and the plugin published to `out/`.

```sh
dotnet publish -c Release -o out            # in the repository root; needs the .NET 10 SDK
cd tests/compat
npm ci && npx playwright install chromium && node run.mjs --tag 12.4
```

`--tag` is the `jellyfin/jellyfin` image tag. Without it the script uses the release the plugin is
built for, the `Jellyfin.Controller` version in `Jellyfin.Plugin.HeraTv.csproj` (12.4.0 is `12.4`;
`node tag.mjs` prints it). Other options:

| Option | Default | |
| --- | --- | --- |
| `--plugin <dir>` | `../../out` | where `Jellyfin.Plugin.HeraTv.dll` is |
| `--out <dir>` | `results/` | where screenshots, `summary.json`, `summary.md` and `jellyfin.log` go |
| `--runtime <name>` | docker, else podman | the container runtime |
| `--keep` | off | leave the container running and the temporary folders in place |

`HERA_CHROMIUM=/path/to/chrome` runs that browser instead of Playwright's (useful where Playwright's
download does not run, such as NixOS). `FFMPEG=/path/to/ffmpeg` picks the ffmpeg that makes the media.

The exit status is 0 when every page is healthy and 1 otherwise. Rootless podman works.

## What it does

1. Starts `jellyfin/jellyfin:<tag>` on a free local port, running as you, with a temporary
   `/config` that holds the plugin in `plugins/HeraTV` (the DLL and `meta.json`), and a `/media`
   folder.
2. Makes the media (`fixtures.mjs`): two films in `Films` and one show with two episodes in
   `TV Shows`, named as Jellyfin expects (`Big Buck Bunny (2008)/Big Buck Bunny (2008).mkv`, `Pioneer
   One (2010)/Season 01/Pioneer One (2010) - S01E01.mkv`). The video is ffmpeg's `testsrc` at
   320×180 for 6 s, in VP9 and Opus because the Chromium that Playwright ships cannot decode
   H.264. ffmpeg comes from the host, or from the Jellyfin image when the host has none.
3. Sets the server up through its API (`server.mjs`): the startup wizard, both libraries, a wait
   for the scan, and a collection holding both films.
4. Signs the browser in, visits the pages (`run.mjs`) and writes `results/`.

Nothing is fetched from the internet. The libraries have online metadata providers switched off;
the synopsis and year come from `.nfo` files beside the media, and the poster, backdrop and logo
from image files, which Jellyfin reads locally. That gives Hera's pages artwork and text to lay
out, like a real library, and keeps the result the same on every run.

## Signing in

The browser is signed in by an access token, not through the login form. The script authenticates
over the API, then stores that session in `localStorage` (`jellyfin_credentials`) before the web
client starts, which is how the client remembers a real sign-in. Hera restyles the login page, so
going through the form would make every run depend on its markup, and a change there would hide the
pages under test. The login page is therefore not covered by this run.

## In GitHub Actions

`.github/workflows/compat.yaml` builds the plugin as the release does (`dotnet build -c Release`), then runs
this on every pull request, every push to main, on demand (`workflow_dispatch` takes a
`jellyfin_tag`) and nightly.

- Pull requests, pushes and manual runs test one tag: the release the plugin is built for, or the
  one asked for.
- The nightly run also tests `latest` and `unstable`. When one of those fails, a job opens (or
  updates) one issue titled `Compatibility: Jellyfin <tag>` with the summary, and closes it once the
  tag passes again.
- Each run uploads `results/` (screenshots, `summary.json`, the server log) as the artifact
  `compat-<tag>`, and the summary appears on the run's page.

## Reading a failure

`summary.md` lists what failed, for example:

```
- module "core" is degraded on itemDetailPage: Jellyfin has no detailRibbon (seen on film)
```

The name after "has no" is a key of `HeraTV.jf` in `web/hera-tv.js`, the one place that maps what
Hera needs to Jellyfin's selector. Look at the screenshot of that page and at the markup Jellyfin
now draws, and update the selector there. `jellyfin.log` is the server's own log; if Hera is
missing altogether, check it for a plugin that Jellyfin refused to load (`targetAbi` in
`meta.json`).
