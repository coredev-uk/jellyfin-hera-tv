# Compatibility test

Runs the built plugin inside a real Jellyfin server and drives the web client with Chromium. It
fails when Hera, or the server side of it, is not working, so a Jellyfin release that changes the
web client or the server is caught here and not on a server.

## What fails the run

On the server:

- the plugin is not `Active` in `/Plugins`;
- Jellyfin's log has an `[ERR]` or `[FTL]` entry with `Jellyfin.Plugin.HeraTv` in it (the first is quoted in `summary.md`), or any fatal entry;
- a Hera endpoint answers 5xx, or the wrong status: each is called once as the administrator and once as a second, ordinary user (`viewer`), and the open ones and the closed ones with no token (`checks.mjs` lists them and what each caller must get);
- either scheduled task (`HeraTvBuildCollections`, `HeraTvLetterboxd`) is missing or does not end `Completed` when run through `/ScheduledTasks`;
- `GET /HeraTV/health` lists a server feature that has failed or says the web client's page was never rewritten;
- Jellyfin stops answering, or the film that is playing is not in `/HeraTV/stats/now`, after the film has played for 75 s (`--soak`), so every one-minute loop on the server has ticked.

In the browser, on each page of each pass (`pages.mjs`):

- `window.HeraTV` is missing, `boot` is anything but `ok` or `untested` (`safe`, or stuck at `starting`);
- a module is `partial`, `degraded` or `disabled`, or has thrown at all, or a module the page needs (`modules` in its spec) is idle or did not run on that page;
- Hera's own scripts (the bundle) wrote a console error or warning, or threw (`pageerror`), or a stylesheet or script of Hera's answers 4xx, or anything under `/HeraTV/` answers 5xx;
- the page Jellyfin shows is not the one expected (`view`), `html.hera-on` or a required module's `html.hera-m-<module>` is missing, or what Hera must have drawn there (`dom`) is not on the page.

`boot: untested` (the server is a newer Jellyfin than the one Hera was built against) and errors from Jellyfin's own scripts are warnings, so the nightly run against newer releases stays readable.

## The passes

| Pass | What it does |
| --- | --- |
| Signed out | Opens Jellyfin with nobody signed in and expects `#loginPage.hera-login` |
| `?hera=off` | Opens the sign-in page with `?hera=off` and expects no Hera class, stylesheet or restyled page |
| TV | `localStorage.layout = "tv"` at 1920×1080. Home with the remote's keys (it starts on the hero's Play, Down leaves the hero, Up returns), a film, the series, the collection and preferences |
| Desktop | 1440×810, signed in as the administrator: home (then the header search opens `.hera-hs`, the profile button opens `.hera-cc`), Discover, Requests, Statistics, the Films and Collections libraries, a film, the series, an episode, the collection, a person, search, preferences, the Dashboard, Hera's two Dashboard pages, and the player. The film is started from its page, paused (expecting `.hera-pause`), resumed, and kept playing while the endpoints are called and the tasks run |

Each page is screenshotted. Seerr is a stand-in (`seerr-stub.mjs`) that the Jellyfin container reaches
through `HERATV_SEERR_URL`, so Discover and Requests are on and the requests behind them run; without
a Seerr to ask they switch themselves off.

## Run it locally

You need docker or podman, Node 22 or later, and the plugin built to `out/`.

```sh
dotnet build -c Release -o out              # in the repository root; needs the .NET 10 SDK
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
| `--soak <seconds>` | 75 | how long the film plays before the server is judged |
| `--allow-no-playback` | off | the browser cannot play VP9 (a distribution's Chromium): the pause screen and the stream are not checked, and the run says so |

`HERA_CHROMIUM=/path/to/chrome` runs that browser instead of Playwright's (useful where Playwright's
download does not run, such as NixOS). `FFMPEG=/path/to/ffmpeg` picks the ffmpeg that makes the media.

The exit status is 0 when everything holds and 1 otherwise. Rootless podman works.

## What it does

1. Starts `jellyfin/jellyfin:<tag>` on a free local port, running as you, with a temporary
   `/config` that holds the plugin in `plugins/HeraTV` (the DLL and `meta.json`), a `/media`
   folder, and the Seerr stand-in's address in `HERATV_SEERR_*`.
2. Makes the media (`fixtures.mjs`): two films in `Films` (with an actor in their `.nfo`, which
   makes a person page) and one show with two episodes in `TV Shows`, named as Jellyfin expects
   (`Big Buck Bunny (2008)/Big Buck Bunny (2008).mkv`, `Pioneer One (2010)/Season 01/Pioneer One (2010) - S01E01.mkv`).
   The video is ffmpeg's `testsrc` at 320×180 for 150 s, in VP9 and Opus because the Chromium that
   Playwright ships cannot decode H.264. ffmpeg comes from the host, or from the Jellyfin image when
   the host has none.
3. Sets the server up through its API (`server.mjs`): the startup wizard, both libraries, a wait
   for the scan, a collection holding both films, and a second user with no administrator rights.
4. Checks the server and signs the browser in, visits the pages (`run.mjs`) and writes `results/`.

Nothing is fetched from the internet. The libraries have online metadata providers switched off;
the synopsis and year come from `.nfo` files beside the media, and the poster, backdrop and logo
from image files, which Jellyfin reads locally.

## Signing in

The browser is signed in by an access token, not through the login form. The script authenticates
over the API, then stores that session in `localStorage` (`jellyfin_credentials`) before the web
client starts, which is how the client remembers a real sign-in. The sign-in page itself is covered
by the signed-out pass (Hera restyles it and it must still be there); signing in through its form
is not exercised, since the form is Jellyfin's markup and the run would then depend on it.

## The checks' own tests

`judge.mjs` (what counts as broken), `versions.mjs`, `manifest.mjs`, `newest.mjs` and the lint rule in
`tests/lint` have tests that need no browser or server: `npm test` at the repository root. A verdict
that cannot fail is no check, so each of them is tried against a broken input.

## In GitHub Actions

`.github/workflows/compat.yaml` builds the plugin as the release does (`dotnet build -c Release`),
then runs this on every pull request, every push to main, on demand (`workflow_dispatch` takes a
`jellyfin_tag`) and nightly. `release.yaml` waits for the run on main and publishes only if it passed.

- Pull requests, pushes and manual runs test one tag: the release the plugin is built for, or the
  one asked for.
- The nightly run also tests `latest` and `unstable`, twice: this build as released, and a build
  recompiled against the newest `Jellyfin.Controller` and `Jellyfin.Model` on NuGet (`newest.mjs`;
  the newest release for `latest`, a prerelease newer than every release for `unstable`). A compile
  error is reported as `build-failure.mjs` writes it. When any of these fail, a job opens (or updates)
  one issue titled `Compatibility: Jellyfin <tag>` with both summaries, and closes it once they pass.
- Each run uploads `results/` (screenshots, `summary.json`, the server log) as the artifact
  `compat-<tag>` (`compat-<tag>-rebuilt` for the recompiled one), and the summary appears on the run's page.
- The check to require on pull requests is the job named `Jellyfin <tag>` (for the tested release).

## Reading a failure

`summary.md` lists what failed, for example:

```
- module "core" is degraded on itemDetailPage, Jellyfin has no detailRibbon (.detailRibbon) (first seen on film)
```

The name after "has no" is a key of `HeraTV.jf` (`JF_TABLE` in `web/hera-tv.js`), the one place that
maps what Hera needs to Jellyfin's selectors. Look at the screenshot of that page and at the markup
Jellyfin now draws, and update the selector there. A failure that says "expected page X, but Y is
showing" or "Hera drew nothing at <selector>" names a page id or a Hera class in `pages.mjs`; a
change in Jellyfin's page ids is fixed there. `jellyfin.log` is the server's own log, and
`summary.md` quotes the first error from the plugin in it; if Hera is missing altogether, check it
for a plugin that Jellyfin refused to load (`targetAbi` in `meta.json`, or a Sqlite that differs from the server's).
