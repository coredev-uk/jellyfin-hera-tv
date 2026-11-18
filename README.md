<img src="assets/logo.svg" alt="" width="100" align="left">

### Hera TV

[![Jellyfin 12.4](https://img.shields.io/badge/jellyfin-12.4-00A4DC?logo=jellyfin&logoColor=white)](https://jellyfin.org)
[![Image](https://img.shields.io/badge/image-ghcr.io%2Fcoredev--uk%2Fjellyfin--hera--tv-2496ED?logo=docker&logoColor=white)](https://github.com/coredev-uk/jellyfin-hera-tv/pkgs/container/jellyfin-hera-tv)
[![Build](https://github.com/coredev-uk/jellyfin-hera-tv/actions/workflows/build.yaml/badge.svg)](https://github.com/coredev-uk/jellyfin-hera-tv/actions/workflows/build.yaml)

A Jellyfin plugin that gives the web client the look of Apple's TV app, with Seerr, Sonarr, Radarr and SABnzbd built into the library.

[Features](#features) •
[Install](#install) •
[Configuration](#configuration) •
[Design](DESIGN.md) •
[Image](https://github.com/coredev-uk/jellyfin-hera-tv/pkgs/container/jellyfin-hera-tv)

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
| Player | A thin scrubber, a glass capsule of controls, and a tvOS-style pause screen |
| People | The role, the biography and a filmography from Seerr, with the library's titles first |
| Discover | Trending, popular and upcoming titles from Seerr, requestable from a title sheet |
| Extras | Ratings, where to watch, quality badges, hidden titles, and Maintainerr's "Leaving Soon" |
| Activity | Sonarr, Radarr and SABnzbd progress on the titles they're fetching |
| Statistics | A Dashboard page for admins with what's playing now, history, top users and titles, playback methods, devices and peak hours, and a page for everyone with only their own watching. History comes from the Playback Reporting plugin when it's installed. Concurrent streams, resolution, bitrate and transcoding are recorded by Hera TV itself once a minute, so they build up from the day it's installed |
| Dashboard | Jellyfin's admin pages in the same look, plus a settings page for the plugin |

[DESIGN.md](DESIGN.md) sets out each surface next to the Apple TV app it follows, and the departures.

</details>

## Install

The plugin is one DLL and its `meta.json`. Jellyfin loads it from `plugins/HeraTV` in its config folder.

**From the image.** `ghcr.io/coredev-uk/jellyfin-hera-tv:<commit>` carries the built plugin. Run it as an init container with Jellyfin's `/config` mounted, and it replaces `/config/plugins/HeraTV` with its own copy:

```yaml
initContainers:
  hera-tv:
    image: ghcr.io/coredev-uk/jellyfin-hera-tv:<commit>@sha256:<digest>
    volumeMounts:
      - name: config
        mountPath: /config
```

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

Requests go through the plugin's own endpoints, so no API key reaches the browser.

</details>

## Contributing

Report bugs and request features with [Issues](https://github.com/coredev-uk/jellyfin-hera-tv/issues). Read [DESIGN.md](DESIGN.md) and [PRODUCT.md](PRODUCT.md) before changing how anything looks.

## Licence

Hera TV is licensed under the GNU General Public License v3.0 only ([LICENSE](LICENSE)). It bundles [Inter](https://rsms.me/inter/) under the SIL Open Font License ([web/Inter-LICENSE.txt](web/Inter-LICENSE.txt)). It is not affiliated with Apple or Jellyfin.
