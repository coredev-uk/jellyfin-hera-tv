<img src="assets/logo.svg" alt="" width="100" align="left">

### Hera TV

[![Jellyfin 12.4](https://img.shields.io/badge/jellyfin-12.4-00A4DC?logo=jellyfin&logoColor=white)](https://jellyfin.org)
[![Build](https://github.com/coredev-uk/jellyfin-hera-tv/actions/workflows/build.yaml/badge.svg)](https://github.com/coredev-uk/jellyfin-hera-tv/actions/workflows/build.yaml)

A Jellyfin plugin that gives the web client the look of Apple's TV app, with Seerr, Sonarr, Radarr and SABnzbd built into the library.

[Features](#features) •
[Install](#install) •
[Configuration](#configuration) •
[After a Jellyfin update](#after-a-jellyfin-update) •
[Design](DESIGN.md)

<br clear="left">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/hero-dark.webp">
  <img src="assets/hero-light.webp" alt="The Dark Knight Collection in Hera TV: the collection's key art behind its logo, '3 films · 2005–2012 · 7 hr 37 min', the synopsis and a white 'Play Batman Begins' button, then a Films shelf of the three films' key art, numbered in release order, with Batman Begins marked as next.">
</picture>

## Features

The plugin restyles Jellyfin's own pages and adds sections of its own. Jellyfin's React app and markup stay in place, and the native apps aren't affected. It covers the desktop and TV layouts, in dark and light.

<details>
<summary>Everything it changes</summary>

| Surface | What Hera TV does |
| --- | --- |
| Home | A full-bleed hero of unwatched titles that crossfades every 8 s, then rows that sit on the hero's blurred art |
| Navigation | A floating glass capsule of tabs, search in the header, and a profile menu |
| Films and TV shows | Key art fills the top with the logo, meta, synopsis and buttons, then one Episodes shelf with series tabs, wherever you are in a show |
| Collections | The films in release order on the Episodes shelf. Play starts the next one you haven't watched, and films the collection is missing sit in their place, ready to request |
| Collection shelves | Real Jellyfin collections that Hera TV builds every morning, so Swiftfin and Android TV see them too: universes, awards, streaming services, seasons, homegrown, decades, genres and more. The Collections page groups them into shelves, and the home page adds rows for what is new, popular and highly rated, and a service, two genres and a decade that change daily. Each group can be switched off, and a button builds them now |
| Player | A thin scrubber, a glass capsule of controls, and a tvOS-style pause screen |
| People | The role, the biography and a filmography from Seerr, with the library's titles first |
| Discover | Trending, popular and upcoming titles from Seerr, requestable from a title sheet |
| Extras | Ratings, where to watch, quality badges, hidden titles, and Maintainerr's "Leaving Soon" |
| Activity | Sonarr, Radarr and SABnzbd progress on the titles they're fetching |
| Notifications | A bell in the header, and "New" on titles, for your own requests (approved, downloading, ready to watch, declined), new episodes of shows you've watched in the last 90 days, and a daily summary of what arrived. Only while Jellyfin is open. Each person picks which kinds they get |
| Letterboxd | Each person links their own Letterboxd account in Settings, and the films they watch to the end in Jellyfin go into their diary, rewatches marked. They can switch it off, import earlier watches or disconnect. Needs a Letterboxd API key and secret, which an administrator adds on the Dashboard page |
| Statistics | A Dashboard page for admins with what's playing now, history, top users and titles, playback methods, devices and peak hours, and a page for everyone with only their own watching. History comes from the Playback Reporting plugin when it's installed. Concurrent streams, resolution, bitrate and transcoding are recorded by Hera TV itself once a minute, so they build up from the day it's installed |
| Dashboard | Jellyfin's admin pages in the same look, plus a settings page for the plugin |

[DESIGN.md](DESIGN.md) sets out each surface next to the Apple TV app it follows, and the departures.

</details>

## Install

The plugin is one DLL and its `meta.json`, in a folder of its own under `plugins` in Jellyfin's config folder.

**From the plugin catalogue.** In Jellyfin, open Dashboard → Plugins → Repositories, add a repository with this URL, then find Hera TV under Catalogue, install it and restart Jellyfin:

```
https://raw.githubusercontent.com/coredev-uk/jellyfin-hera-tv/manifest/manifest.json
```

Updates arrive the same way. Jellyfin's Update Plugins task installs a newer version from the catalogue, or you can update it by hand there, and a restart loads it.

<details>
<summary>Building it yourself, and installing by hand</summary>

```sh
dotnet build -c Release -o out
mkdir -p /config/plugins/HeraTV
cp out/Jellyfin.Plugin.HeraTv.dll meta.json web/Inter-LICENSE.txt /config/plugins/HeraTV/
```

Restart Jellyfin afterwards. The build needs the .NET 10 SDK. Warnings fail it.

</details>

## Configuration

Everything is on the plugin's page in the Dashboard. Environment variables take precedence over the Dashboard, so API keys can come from a secret and never have to be typed in.

<details>
<summary>Environment variables</summary>

| Variable | Sets |
| --- | --- |
| `HERATV_SEERR_URL`, `HERATV_SEERR_API_KEY` | Seerr, as the server reaches it |
| `HERATV_SEERR_PUBLIC_URL` | Seerr, as a browser reaches it (for "Open in Seerr") |
| `HERATV_SEERR_USERS` | Jellyfin username to Seerr user id (`alice=1,bob=3`), so requests are made as that Seerr user |
| `HERATV_MAINTAINERR_URL` | Maintainerr, for "Leaving Soon" |
| `HERATV_SONARR_URL`, `HERATV_SONARR_API_KEY`, `HERATV_SONARR_PUBLIC_URL` | Sonarr |
| `HERATV_RADARR_URL`, `HERATV_RADARR_API_KEY`, `HERATV_RADARR_PUBLIC_URL` | Radarr |
| `HERATV_SABNZBD_URL`, `HERATV_SABNZBD_API_KEY`, `HERATV_SABNZBD_PUBLIC_URL` | SABnzbd |
| `HERATV_LETTERBOXD_API_KEY`, `HERATV_LETTERBOXD_API_SECRET` | Letterboxd's API key and secret, so people can link their own accounts. Letterboxd only issues them to partners |

Requests go through the plugin's own endpoints, so no API key reaches the browser.

</details>

## After a Jellyfin update

Hera TV restyles and adds to Jellyfin's own web client, so a Jellyfin release can change something it leans on. The plugin is built so that costs a feature on one page, never a usable page, and so that someone hears about it.

**What CI checks.** Every pull request, and every push to main, runs Hera in a real Jellyfin (`.github/workflows/compat.yaml`, `tests/compat`) and fails unless:

- the plugin is Active and Jellyfin's log has no error with the plugin in its stack;
- every Hera endpoint answers as it should to an administrator, to an ordinary user and to nobody, with no 5xx;
- both of Hera's scheduled tasks run to the end, and Jellyfin is still up after a film has played for over a minute;
- on every page (home, Discover, Requests, Statistics, libraries, the collections library, films, series, episodes, collections, a person, search, preferences, the Dashboard, Hera's own two Dashboard pages and the player) no module is idle, partial, degraded or disabled, the bundle logged no console error, and Hera's own markup is on the page;
- the same holds in the TV layout at 1920×1080 driven with a remote's keys, on the sign-in page, and `?hera=off` really does take Hera off the tab;
- the header's search, the profile menu (Control Center) and the pause screen answer to a click or a pause.

Further checks on pull requests (`.github/workflows/build.yaml`) catch a misspelt or unused name in the scripts, a selector for Jellyfin's markup written outside the `JF` map, a stylesheet or module the server's manifest and the scripts disagree about, a Jellyfin.Controller whose major.minor differs from `meta.json`'s `targetAbi` or the releases listed in `Compatibility.Tested`, and a `Microsoft.Data.Sqlite` that differs from the one Jellyfin itself ships (the server supplies that assembly, and a different one stops the server). Merging needs the "Compatibility" check, which passes only when every compat run on the pull request passed; its name stays the same when the Jellyfin release under test changes. A release is published only after the compat run passed on its commit. Nightly, the same run goes against Jellyfin's `latest` and `unstable` images, as released and recompiled against the newest `Jellyfin.Controller` on NuGet, and one issue per tag, *Compatibility: Jellyfin latest* or *unstable*, collects what failed and closes itself when it passes again.

**What the Dashboard shows.** Dashboard → Plugins → Hera TV has a compatibility section: the Jellyfin version and the releases this build was tested on, when Hera last added itself to the web client's page, how many browsers have reported since the server started, any server feature that failed (stream sampling, the notification centre, the Letterboxd watcher, and so on, with when it began and how often), and a table of every module that is standing aside, only partly working or switched off, with the page, the piece of Jellyfin it is missing and who reported it. It says everything is fine only when a browser has actually checked in. The same faults are in Jellyfin's log, once at warning level and as errors when a feature gives up.

**If a page looks wrong.** Add `?hera=off` to its address (before or after the `#`) and Jellyfin shows its own page; `?hera=on` brings Hera back. That applies to one browser tab until it is closed. To take a part of Hera off for everyone while waiting for a fix, switch it off under Dashboard → Plugins → Hera TV → "Switch off a part of Hera" (or list it in `DisabledModules` in `plugins/configurations/Jellyfin.Plugin.HeraTv.xml`); browsers pick it up when they next load the page. A switched-off module is never registered, so its script, its click handlers and its stylesheet are all off. The module names are `hero`, `banner`, `overview`, `logo`, `ribbon`, `seasons`, `boxset`, `control-center`, `paddles`, `british`, `home`, `discover`, `player`, `pause`, `postplay`, `trailer`, `settings`, `login`, `search`, `seerr`, `extras`, `extras-detail`, `activity`, `stats`, `notify`, `notify-detail` and `collections-browse`; the Dashboard's table names the one that has a problem. The same page has a master switch that takes Hera off the web client altogether.

**Fixing a piece of Jellyfin that moved.** The Dashboard and the CI summary name the key, as in "Jellyfin has no `detailRibbon`".

1. Open the page in Jellyfin (with `?hera=off`) and find what that part of the page is called now.
2. Change the selector of that key in `JF_TABLE` in `web/hera-tv.js`. That is the only place Jellyfin's classes and ids are named: `npm run lint` fails on one written anywhere else. The entry also says whether the piece is on the page or in the header and whether the module cannot work without it (`required`), which decides whether a miss makes the module stand aside or only run partly.
3. If a CSS rule in `web/*.css` leaned on the old markup, fix it there; each module's stylesheet applies only while its module runs.
4. `npm ci && npm run lint && npm test` for the checks, and `node tests/compat/run.mjs` (see [tests/compat](tests/compat/README.md)) to run Hera against a real Jellyfin.
5. When it passes on the new release, add its major.minor to `Compatibility.Tested` in `Compatibility.cs`; a release for a newer Jellyfin also moves `targetAbi` in `meta.json` and the `Jellyfin.Controller` and `Jellyfin.Model` packages together, with the Sqlite packages set to what Jellyfin's `Directory.Packages.props` pins for that release.

## Contributing

Report bugs and request features with [Issues](https://github.com/coredev-uk/jellyfin-hera-tv/issues). Read [DESIGN.md](DESIGN.md) and [PRODUCT.md](PRODUCT.md) before changing how anything looks.

## Licence

Hera TV is licensed under the GNU General Public License v3.0 only ([LICENSE](LICENSE)). It bundles [Inter](https://rsms.me/inter/) under the SIL Open Font License ([web/Inter-LICENSE.txt](web/Inter-LICENSE.txt)). It is not affiliated with Apple or Jellyfin.
