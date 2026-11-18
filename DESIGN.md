---
name: Hera TV
description: The Apple TV app's look for Jellyfin's web client, with the household's request and download tools built in.
colors:
  background: "#000000"
  surface: "#121214"
  surface-2: "#1c1c1e"
  fill: "rgba(118, 118, 128, 0.24)"
  fill-strong: "rgba(118, 118, 128, 0.36)"
  hover: "rgba(255, 255, 255, 0.1)"
  glass: "rgba(30, 30, 34, 0.62)"
  glass-hover: "rgba(70, 70, 76, 0.85)"
  glass-light: "rgba(255, 255, 255, 0.14)"
  glass-edge: "rgba(255, 255, 255, 0.16)"
  label: "#ffffff"
  label-2: "rgba(235, 235, 245, 0.64)"
  label-3: "rgba(235, 235, 245, 0.52)"
  separator: "rgba(84, 84, 88, 0.55)"
  select: "#ffffff"
  select-hover: "rgba(255, 255, 255, 0.86)"
  on-select: "#000000"
  focus: "#ffffff"
  track: "rgba(255, 255, 255, 0.28)"
  light-background: "#ffffff"
  light-surface: "#f5f5f7"
  light-surface-2: "#ebebf0"
  light-fill: "rgba(120, 120, 128, 0.12)"
  light-glass: "rgba(238, 238, 243, 0.86)"
  light-label: "#1d1d1f"
  light-label-2: "rgba(60, 60, 67, 0.85)"
  light-label-3: "rgba(60, 60, 67, 0.78)"
  light-separator: "rgba(60, 60, 67, 0.18)"
  light-select: "#1d1d1f"
  light-on-select: "#ffffff"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Hera Inter, Segoe UI, Roboto, sans-serif"
    fontSize: "clamp(34px, 4vw, 56px)"
    fontWeight: 800
    lineHeight: 1.02
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Hera Inter, Segoe UI, Roboto, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.15
    letterSpacing: "-0.02em"
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Display, Hera Inter, Segoe UI, Roboto, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    letterSpacing: "-0.015em"
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Hera Inter, Segoe UI, Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.5
  body-large:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Hera Inter, Segoe UI, Roboto, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.45
  button:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Hera Inter, Segoe UI, Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Hera Inter, Segoe UI, Roboto, sans-serif"
    fontSize: "14px"
    fontWeight: 600
    lineHeight: 1.3
  subtitle:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Hera Inter, Segoe UI, Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1.35
  caption:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, Hera Inter, Segoe UI, Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "0.01em"
rounded:
  badge: "4px"
  small: "6px"
  row: "10px"
  card: "12px"
  wide: "14px"
  dialog: "16px"
  float: "20px"
  panel: "24px"
  sheet: "28px"
  capsule: "999px"
spacing:
  edge: "clamp(24px, 4vw, 72px)"
  gap: "20px"
components:
  button-primary:
    backgroundColor: "{colors.select}"
    textColor: "{colors.on-select}"
    typography: "{typography.button}"
    rounded: "{rounded.capsule}"
    padding: "0 26px 0 20px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.select-hover}"
  button-glass:
    backgroundColor: "{colors.glass}"
    textColor: "{colors.label}"
    typography: "{typography.button}"
    rounded: "{rounded.capsule}"
    size: "48px"
  button-glass-hover:
    backgroundColor: "{colors.glass-hover}"
  button-glass-pressed:
    backgroundColor: "{colors.select}"
    textColor: "{colors.on-select}"
  tab-bar:
    backgroundColor: "{colors.glass}"
    rounded: "{rounded.capsule}"
    padding: "4px"
  tab-active:
    backgroundColor: "{colors.select}"
    textColor: "{colors.on-select}"
    rounded: "{rounded.capsule}"
  card-art:
    backgroundColor: "{colors.surface-2}"
    rounded: "{rounded.card}"
  card-art-wide:
    backgroundColor: "{colors.surface-2}"
    rounded: "{rounded.wide}"
  card-badge:
    backgroundColor: "{colors.glass-hover}"
    textColor: "{colors.label}"
    typography: "{typography.caption}"
    rounded: "{rounded.capsule}"
    padding: "3px 8px"
  chip-quality:
    backgroundColor: "{colors.fill-strong}"
    textColor: "{colors.label}"
    typography: "{typography.caption}"
    rounded: "{rounded.badge}"
    padding: "0 6px"
    height: "18px"
  segmented:
    backgroundColor: "{colors.glass}"
    rounded: "{rounded.capsule}"
    padding: "3px"
  segmented-selected:
    backgroundColor: "{colors.select}"
    textColor: "{colors.on-select}"
    rounded: "{rounded.capsule}"
  input-search:
    backgroundColor: "{colors.fill}"
    textColor: "{colors.label}"
    rounded: "{rounded.capsule}"
    padding: "0 6px 0 14px"
    height: "44px"
  sheet:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.label}"
    rounded: "{rounded.sheet}"
---

# Design System: Hera TV

## Overview

**Creative North Star: "The Lights-Down Room"**

Hera TV is the household's Jellyfin library made to behave like the Apple TV app (tvOS 26 for the look, tv.apple.com for how a mouse uses it). It is a room with the lights down: a black ground, the artwork the only colour in it, and every control dimmed back until a hand reaches for it. The interface whispers and the artwork speaks. Type is white in three strengths, the selected thing is simply white, and glass appears only where tvOS puts it, on the chrome that floats over the picture.

The mood is hushed, cinematic and exact. Density is generous: one edge column (`{spacing.edge}`) for every title, row and first card, shelves of rounded artwork with titles under them, and nothing ornamental between them. Controls are quiet capsules that turn white when chosen. Depth is mostly flat, with artwork lifting on hover or focus, and one lifted level for floating cards and sheets. Light mode exists and mirrors every token, but anything whose text sits on artwork keeps the dark set, as the Apple TV app does.

It covers the desktop and TV layouts; phones keep Jellyfin's own layout, which the colours and type still restyle. The surface-by-surface comparison with the Apple TV app, the Plex-style extras and the rules for surviving Jellyfin updates follow the standard sections below.

**Key Characteristics:**
- A black ground with no accent colour; artwork carries every hue.
- White type in three strengths, never a fourth.
- Selection is the inverse of the ground: white with black text on dark, near-black with white text on light.
- Glass and blur on chrome only: the tab bar, secondary buttons, menus, the player.
- Rounded artwork that lifts 2px on hover and zooms 3% inside its frame; no tilt.
- Capsules for everything pressable that isn't artwork.

## Colors

A monochrome system on a black ground, named after Apple's own UI roles, where the artwork is the only colour on the screen.

### Primary
- **Selection** (`{colors.select}`, with `{colors.on-select}` on it): the focused tab, the primary button (Play, Request), a pressed glass button, the selected segment, the focus ring (`{colors.focus}`). On tvOS the selected thing is white; here too. Light mode inverts it to near-black (`{colors.light-select}`) with white text.

### Neutral
- **System Background** (`{colors.background}`): the page ground. Pure black, so artwork and its blurred ambient light do all the colouring.
- **Secondary System Background** (`{colors.surface}`): sheets, inset grouped lists, cards that hold text rather than artwork.
- **Tertiary System Background** (`{colors.surface-2}`): the placeholder behind artwork while it loads, and nested surfaces.
- **Label** (`{colors.label}`): titles and primary text.
- **Secondary Label** (`{colors.label-2}`): synopses, meta lines, subtitles under cards.
- **Tertiary Label** (`{colors.label-3}`): the quietest text (episode numbers, captions, placeholders). 52% is the lowest strength that still holds 4.5:1 on black.
- **Fill** (`{colors.fill}`) and **Strong Fill** (`{colors.fill-strong}`): flat control backgrounds (search fields, quality chips, the active row of a list).
- **Glass** (`{colors.glass}`, hover `{colors.glass-hover}`, edge `{colors.glass-edge}`): the translucent material of chrome, always with the 30px blur and a 1px top highlight.
- **Separator** (`{colors.separator}`): hairlines between list rows.
- **Track** (`{colors.track}`): the unfilled part of progress bars, scrubbers and pager dots.
- **Light set** (`{colors.light-background}`, `{colors.light-surface}`, `{colors.light-label}` and the rest): the same roles on a white page, Apple's light system colours.

### Named Rules
**The No Accent Rule.** Hera has no brand colour. White (near-black in light mode) is the only selection colour; anything coloured on screen came from the artwork.

**The Token Only Rule.** Components use the `--hera-*` scheme tokens and never raw white or black, so one scheme switch restyles everything, Jellyfin's own components included.

**The Dark Over Art Rule.** Text that sits on artwork (the home hero, detail banners, the player, sheet headers, Discover's feature) keeps the dark set in light mode, over its own scrim.

## Typography

**Display Font:** SF Pro Display (system on Apple devices), with self-hosted Inter ("Hera Inter") elsewhere
**Body Font:** SF Pro Text, with the same Inter fallback

**Character:** Apple's own pairing, set tight at large sizes and plain at small ones; the type never decorates, it labels.

### Hierarchy
- **Display** (800, clamp(34px, 4vw, 56px), 1.02, -0.03em): the home hero's title when a title has no logo artwork.
- **Headline** (700, 28px, 1.15, -0.02em): page titles in a library page's header row ("Collections", "Discover").
- **Title** (700, 22px, -0.015em): section and shelf titles ("Up Next", "Episodes").
- **Body** (400, 15px, 1.5): synopses, capped at 52ch in the hero and three lines on cards.
- **Body Large** (400, 17px, 1.45): the synopsis on the pause and post-play screens, and text typed into search fields.
- **Button** (600, 16px, 1): text in capsules.
- **Label** (600, 14px, 1.3): card titles and meta lines.
- **Subtitle** (500, 13px, 1.35): the line under a card's title and an episode's synopsis, in Secondary Label.
- **Caption** (700, 11px, 0.01em): badges and quality chips ("4K", "Awaiting Release").

Material Icons sit at 20px in small controls and 24px in 48px buttons.

The TV layout steps every size up (card titles 18px, page titles 36px, synopses 19 to 22px) for reading across a room.

### Named Rules
**The No Eyebrow Rule.** Nothing sits in small caps above a heading. An episode's number leads its title on the same line, in Tertiary Label.

**The Three Strengths Rule.** Text colour is Label, Secondary Label or Tertiary Label. Hierarchy comes from size and weight first, strength second, never from colour.

## Layout

One left edge for the whole page: `{spacing.edge}` (24px on a narrow window, 72px on a wide one). Every page title, shelf title and first card sits on it, and shelves bleed past it to the window's edge so rows read as continuing off screen. Cards in a shelf sit `{spacing.gap}` apart; posters are clamp(132px, 11.5vw, 196px) wide and wide cards clamp(240px, 22vw, 340px).

Rows scroll sideways, with hover paddles for a mouse and focus movement for a remote. Pages that are a browse of everything (the Collections page's groups, a collection's own films) wrap into a grid of the same card widths instead. The home page opens on a full-bleed hero whose foot the first shelf overlaps; detail pages open on a banner with the logo, meta, synopsis and buttons at its lower left, the buttons always 48px above the banner's foot. Library pages share a header row: the title at the left, its tools level with it at the right.

Breakpoints are few: the tab bar shortens its labels under 1440px; Jellyfin's own phone layout takes over under 900px; a collection's grid drops to one column under 720px. The TV layout (`.layout-tv`) is a mode, not a width: larger type, a white focus ring and remote navigation.

### Named Rules
**The One Edge Rule.** If it's a title or the first thing in a row, it starts on `{spacing.edge}`.

## Elevation & Depth

Mostly flat, with two exceptions. Chrome is glass (`{colors.glass}` plus a 30px blur and a 1px top highlight) floating over the picture. Content gains a shadow only when it lifts: artwork rises 2px with the lifted shadow on hover or focus, and floating cards, sheets and menus sit at that one lifted level. Behind detail pages and the home rows, the title's key art is blurred and dimmed into the ground, so the page sits in the light of the art rather than on a slab. When content scrolls under the tab bar it fades into the ground with a gradient, not a blur, so scrolling stays at full frame rate.

### Shadow Vocabulary
- **Rest** (`box-shadow: 0 10px 24px -10px rgba(0, 0, 0, 0.8)`): chrome at rest, such as the tab bar and paddles.
- **Lift** (`box-shadow: 0 24px 40px -14px rgba(0, 0, 0, 0.9)`): artwork on hover or focus, floating cards (Discover's feature), menus and sheets.
- **Glass edge** (`box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16)`): the top highlight on every glass surface.
- **Focus ring** (`box-shadow: 0 0 0 3px #fff` with Lift): a focused card on a remote, which also scales 6% in the TV layout.

### Named Rules
**The Glass Is Chrome Rule.** Blur belongs to the tab bar, secondary buttons, menus and the player. No card carries a standing backdrop-filter; badges and overlay buttons on artwork are solid translucent fills.

**The Lift Rule.** Content is flat at rest. A shadow is the answer to hover or focus, never a decoration.

## Shapes

Soft rectangles for artwork and capsules for controls. Posters and stills round at `{rounded.card}`, wide cards and Hera's menus at `{rounded.wide}`, Jellyfin's own dialogs and action sheets at `{rounded.dialog}`, floating glass cards (Up Next, the notification panel) at `{rounded.float}`, Discover's feature card at `{rounded.panel}` and sheets at `{rounded.sheet}`. Rows inside menus and lists take `{rounded.row}`, small fills inside controls `{rounded.small}`. Badges inside meta lines (certificates, quality chips) are nearly square at `{rounded.badge}`. Everything pressable that isn't artwork, from the tab bar to a quality switch, is a full capsule (`{rounded.capsule}`). People are circles. There are no borders on content; hairline separators appear only between rows of a list.

### Named Rules
**The Capsule Rule.** If you can press it and it isn't a picture, it's a capsule.

## Components

### Buttons
Quiet capsules that turn white when chosen.
- **Shape:** full capsule (`{rounded.capsule}`), 48px tall.
- **Primary:** Selection white with black text (`{components.button-primary}`), an icon then the verb: Play, Resume, Request, Play Next Episode. One per group.
- **Glass:** round 48px glass discs for secondary actions (info, favourite, shuffle), widened with a label when the action needs words ("More Info", "Trailer").
- **Hover / Focus:** primary dims to `{colors.select-hover}`; glass brightens to `{colors.glass-hover}`; a pressed toggle (a favourite) turns Selection white. Focus shows a 2px white outline 3px out. Every button presses to 95% on click.

### Chips
- **Badge:** Caption type in a glass-hover capsule at a card's corner ("In Library", "Awaiting Release", "New").
- **Quality chip:** Caption type on Strong Fill, nearly square (`{rounded.badge}`), in meta lines and on cards ("4K", "DV", "Atmos").
- **Certificate:** Caption type in a 1px Tertiary Label outline at `{rounded.badge}`, the board's own mark without Jellyfin's country prefix ("15", not "GB-15"), separated from the meta line by its dots like any other fact.
- **Score:** the source's mark then the number, both Secondary Label: the IMDb wordmark in heavy type; Rotten Tomatoes' tomato or splat (critics) and popcorn bucket upright or tipped (audience) as one-colour glyphs.

### Cards / Containers
- **Corner Style:** `{rounded.card}` for posters (2:3) and stills (16:9 at `{rounded.wide}`).
- **Background:** Tertiary System Background while the artwork loads.
- **Shadow Strategy:** none at rest; Lift on hover or focus, with the artwork zooming 3% inside the frame.
- **Border:** none.
- **Text:** title and subtitle under the artwork, left-aligned, never on it, except where a card's artwork is a logo or wordmark (streaming services).
- **Menu:** a 32px glass disc of three dots across, 8px in from the artwork's top right corner, shown on hover.

### Inputs / Fields
- **Style:** a Fill capsule 44px tall with a leading search glyph, no stroke.
- **Focus:** Strong Fill and a 2px white ring; the header's search field and Discover's both widen while in use.

### Navigation
- **Tab bar:** a floating glass capsule centred at the top; the active tab is a white capsule with black text, the rest Secondary Label. No bar behind it; the server's name stands at the left in white.
- **Segmented switch:** a glass capsule of options with the chosen one as the white pill (Groups | All, 1080p | 4K, series tabs).
- **Pager:** a glass capsule of dots where the active dot stretches and fills with progress (the home hero, Discover's feature), with paddles either side and a pause.

### Shelf
The signature component: a titled row of rounded artwork that scrolls sideways under hover paddles (44px glass discs at the card edges, level with the art), or wraps into a grid where the page is a browse of everything.

### Sheets and Overlays
- **Title sheet:** a centred Secondary System Background panel at `{rounded.sheet}` with the title's backdrop at its head under the dark set.
- **Pause screen and post-play:** the picture dims (or shrinks into the top left corner at the credits) and the title's logo, a line, the synopsis and a pair of capsules settle at the lower left; post-play adds a glass back arrow at the top left and, over a trailer, the player's own volume control (a speaker button and a white level) at the lower right.
- **Volume popup:** a glass capsule at the top right, under the header's discs, with the speaker glyph and a white level on the scrubber's track; raised by the wheel or a volume key, for the player and for a post-play trailer alike.
- **Trailer layer:** a title page's Trailer opens it over the whole screen: the title's backdrop dimmed on black until a trailer is playing, then that trailer at 16:9 with YouTube's own controls, post-play's back disc at the top left; Back, Escape or the trailer's end close it. Only trailers YouTube lets other sites play are offered (asked through `/HeraTV/trailers`), and a frame shows only once it is playing, so YouTube's "Video unavailable" page never does. A title with none loses its Trailer button.
- **Play disc:** every poster or still of something the library holds (Hera's rows, Jellyfin's, search, Seerr's In Your Library) shows the same 52px glass disc with a 28px glyph over a light frost on hover or focus.

## Do's and Don'ts

### Do:
- **Do** let artwork carry the colour: black ground, white type, Selection white for whatever is chosen.
- **Do** use only the `--hera-*` tokens, and re-declare the dark set (`.hera-dark`) wherever text sits on artwork.
- **Do** keep text to three strengths: Label, Secondary Label (64%) and Tertiary Label (52%).
- **Do** make every pressable non-artwork control a capsule, and press it to 95%.
- **Do** lift artwork 2px with the Lift shadow on hover and focus, zooming the image 3% inside its frame.
- **Do** keep focus visible everywhere: a white ring on dark, near-black on light; a 3px ring and 6% scale on a TV.
- **Do** honour reduced motion (no autoplay, no slides, crossfades only) and reduced transparency (no blur).
- **Do** use Material Icons for every glyph, except the score marks: Rotten Tomatoes' tomato, splat and popcorn are drawn in one colour as their own glyphs, since Material has none.

### Don't:
- **Don't** introduce an accent colour, gradient text or a brand hue; the violet Jellyfin mark is gone for that reason.
- **Don't** put glass or a standing backdrop-filter on a card, badge or overlay button.
- **Don't** tilt artwork under the pointer; tvOS's parallax reads as a gimmick with a mouse.
- **Don't** set an eyebrow label above a heading.
- **Don't** move an element when it's hovered; its artwork lifts and zooms, the element stays put.
- **Don't** use emoji.

---

The sections below are the working reference: how each surface maps to the Apple TV app, where Hera departs from it, what it adds from Plex, and how it survives Jellyfin updates.

## What the Apple TV app does, and what Hera TV takes from it

| Surface        | Apple TV app                                                                                                                                                                                                                                                         | Hera TV                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ground         | Pure black; artwork carries the colour. The Mac and iPad apps also have a light appearance: a white page, with artwork keeping its own dark scrim under the text                                                                                                     | `--hera-bg`: black in dark, white in light; no accent colour anywhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Text           | White in three strengths: label, secondary (~60%), tertiary (~30%)                                                                                                                                                                                                   | `--hera-label`, `--hera-label-2` (64%), `--hera-label-3` (52%: the lowest that holds 4.5:1 on black)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Selection      | White: the focused tab, the primary button and the focus ring are white with black text                                                                                                                                                                              | `--hera-select`: white with black text in dark, near-black with white text in light; a favourite's heart sits on the selection disc; on a TV only the focused control in a row is selected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Navigation     | A floating glass capsule of tabs, centred at the top; no bar behind it. Content scrolling under it softens into the ground (the tvOS 26 scroll-edge effect), never a hard-edged slab                                                                                 | The MUI app bar restyled into that capsule; the first link becomes Home; the server name is drawn at the left; once scrolled, a gradient under the bar fades content out beneath it (a gradient, not a blur, so scrolling stays at full frame rate)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Material       | Glass only on chrome: the tab bar, secondary buttons, menus, player controls                                                                                                                                                                                         | `--hera-glass` with a 30px blur, plus a 1px top highlight                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Home           | A full-bleed hero (key art, logo artwork, a meta line, a three-line synopsis, a white Play capsule, a round + button) that crossfades between titles; the first shelf peeks over its foot, and the rows below sit in the light of the art                            | Plugin-rendered hero of unwatched titles with key art, 8 s per title, previous/next either side of a pager whose active capsule fills with progress, and a pause. Below it, the rows rest on the current title's art, heavily blurred and dimmed (washed pale in light mode), crossfading with the hero; in dark the hero's foot dissolves into it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Shelves        | Rounded artwork, 12–16px radius, title below and left-aligned, no chrome                                                                                                                                                                                             | Cards restyled; the first artwork aligns with the section title; paddles appear on hover                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Show page      | Key art fills the top with the logo, meta, synopsis and buttons at its lower left; then a season picker over a horizontal shelf of episode stills, the same shelf wherever you are in the show                                                                       | The same order: banner, logo, meta, synopsis, buttons, then plugin-rendered series tabs over an episode shelf, then credits. Film, series, season and episode pages share one layout: the same series art in the banner, the buttons always 48px above the banner's foot (the text above them grows upwards), and the same blurred art as the ground below. Series, season and episode pages all show that one Episodes shelf first under the banner: a series opens on the series it's up to, a season on itself, an episode on its own series with itself marked by a quiet 2px edge; Jellyfin's season list and "More from Series N" carousel are hidden. Every episode still hovers the way every poster does: a light frost and a centred play disc. Moving between episodes from the shelf keeps your place (page scroll and shelf position), and a show's series, episodes and banner art are kept for a minute so the next page paints whole in its first frame, whether or not Jellyfin had it cached |
| Collections    | A bundle's key art and title, then its films in order on the same row of stills as a season's episodes; Play starts the first                                                                                                                                        | The collection's banner, then its Films in release order, in the Episodes grammar: wide key art with the film's logo, numbered, with the synopsis (up to three lines) and year · runtime (the certificate only when the films differ). The next film to watch carries the 2px edge, and the banner's Play names it and starts it ("Play Batman Begins", or Resume for one in progress). The banner's meta reads "3 films · 2005–2012 · 7 hr 37 min". Up to three films share the width (each at most 600px); four or more wrap into a grid, so a mouse, a trackpad and a remote reach every film. With Seerr, films the library lacks take their place in the order, dimmed with a Request disc, and open the title sheet; a linked user also gets "Request N Missing Films" by the title. Jellyfin's poster grid steps aside                                                                                                                                                                                                                               |
| Cast           | Round portraits, centred names                                                                                                                                                                                                                                       | `personCard` made circular                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Player         | A thin white scrubber that thickens on hover, monochrome controls, a dark scrim; tv.apple.com puts the title and a capsule of controls over the scrubber and the transport in the middle. Paused, tvOS shows the title, synopsis and time left over a dimmed picture. At the credits the picture shrinks into the top left corner over what comes next; a film's credits give way to a trailer | `web/hera-player.*`: always dark, in light mode too. The title ("S1, E3 · The Slump") and a glass capsule of controls sit over a full-width scrubber, with centred glass transport discs; menus opened from it are glass; Skip Intro rises above the capsule while the controls show; the volume popup is a glass capsule with a white level. After 3 s paused the pause screen dims the picture and shows the logo, episode line, synopsis, time left and "Ends at", Resume and Restart, and the cast. A key brings the OSD back; a mouse can travel to its buttons, and a click on the picture brings the OSD back, still paused. Post-play, at the credits (Intro Skipper's outro segment; for an episode without one, when Jellyfin raises Up Next): the playing picture shrinks into the top left corner and the next title fills the screen in the pause screen's type. An episode shows the next one's still and "Play Next Episode", which fills as the episode runs out when autoplay is on. A film shows the next unwatched film in its collection ("Next in The Dark Knight Collection"), or an unwatched one like it, and its trailer, once: the credits' music fades out as the trailer's comes up, the player's own volume control sits at the lower right and the wheel turns the trailer up and down with the same popup, 30 s in the credits fade from their corner and pause, and when the trailer ends the film's artwork takes the screen. A film never starts on its own. Play starts the next title through the server's PlayNow (an episode keeps Jellyfin's queue of the rest of the series). Watch Credits, the picture, Escape or the remote's Back give the credits back (sound and all); the back arrow at the top left leaves the player |
| Control Center | A glass panel of round-icon tiles that turn white when on, the signed-in profile at the top                                                                                                                                                                          | The profile button opens it: subtitles, autoplay, appearance and Recently Added tiles saved to the user's settings, Quick Connect, what is playing elsewhere, an admin library scan, and links; "All options" opens Settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Settings       | A split view: a sidebar of sections beside inset grouped lists of rows (icon, label, value, chevron or switch); changes apply at once                                                                                                                                | `web/hera-settings.*` replaces Jellyfin's settings menu with that: Profile, Appearance, Playback, Subtitles, Home and More, saving on change with a "Saved" capsule. Jellyfin's own settings pages and the admin Dashboard wear the same grouped cards and tokens. Layout, language and intro skipping are kept per browser, where Jellyfin keeps them, and the page says so                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Type           | SF Pro Display for headings, SF Pro Text for body; tight tracking on large sizes                                                                                                                                                                                     | System SF on Apple devices; self-hosted Inter (OFL) elsewhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Motion         | Spring-like ease-out; artwork lifts on focus                                                                                                                                                                                                                         | `cubic-bezier(.22,1,.36,1)`; entrances `--hera-slow`, exits `--hera-fast`; cards lift 2px and their artwork zooms 3% inside the frame; a hovered element never moves itself; buttons press to 95%; no tilt                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Departures

Each departure follows one of the rules this theme is built under.

- **No parallax tilt.** The tvOS focus engine tilts artwork under the thumb. With a mouse that reads as a gimmick, so cards lift and zoom inside the frame instead.
- **No eyebrow labels.** tvOS sets "EPISODE 3" in small caps above an episode's title. Here the number leads the title on the same line, set in tertiary grey.
- **The violet Jellyfin mark is gone.** The server's name stands in white at the left.

## Beyond Apple TV: what Plex does that Jellyfin didn't

The household came from Plex. These parts fill the gaps, in the same visual language. They live in separate files that register with the core (`HeraTV.register`) and share its card and row components (`HeraTV.kit.card`, `kit.shelf`).

| Surface      | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Files                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Home         | Up Next merges Continue Watching and Next Up, one per series. Then Jellyfin's Recently Added rows, Because You Watched / More Like rows, Leaving Soon, Your Requests and Trending to Request. Hera owns the page: every stock section except the slot holding Recently Added is hidden by a class of ours, whatever the person's home settings say                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `web/hera-home.*`                                                                                                           |
| Leaving Soon | Maintainerr's active collections, matched to the user's library by TMDB id: a home row and a "Leaving 9 Dec" chip on the item's page                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `web/hera-home.*`, `Integrations/`                                                                                          |
| Discover     | A Discover tab (`#/home?hera=discover`): the library pages' header row ("Discover" with the search field and Requests at the right), a feature card that takes turns through up to six trending titles the library lacks (the home hero's pager; "Trending Now", the release date if still to come, where a request stands, a Trailer button), then trending, popular and upcoming rows. Requested titles read as the download stack has them ("Awaiting Release", "Downloading"), not Seerr's "Processing". A title sheet with cast, trailer and Request (with a 1080p / 4K capsule for anyone Seerr lets pick a profile), plus per-series picking for TV, and a "Request Series 6–8" control on show pages missing series | `web/hera-discover.*`, `Integrations/`                                                                                      |
| Search       | The header's search button opens a glass field that grows leftwards out of the button, over the tab capsule, with a dropdown that updates on every key (Top Results, People, Episodes, Not in Your Library) and a pinned "See all results". The full page (`#/search?q=&in=`, so Back restores a search) also searches on every key, aborting superseded requests, with category chips, recent searches and every block on the `--hera-edge` column. On a TV the button opens the full page with a round on-screen keyboard. Jellyfin's own search markup is hidden, not removed                                                                                                                                                                                                                                                                                                           | `web/hera-search.*`                                                                                                         |
| Sign-in      | The server's name over one white "Sign in with HyperionID"; Quick Connect in glass; the break-glass password form behind a quiet "Sign in with a password" that opens in place. Jellyfin's own controls are reordered, not reimplemented, and every signed-out page shares the column                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `web/hera-login.*`                                                                                                          |
| Seerr        | Seerr extends the library: person pages gain the role, a bio with More, and a filmography (In Your Library first, then Films / TV Shows or Directed / Written, sortable), every title not in the library opening the title sheet to request it (series by series for TV). People only Seerr knows open at `#/home?hera=person&tmdb=<id>`. Film and series pages get "More Like This"; box sets list the collection's missing films with "Request N Missing Films"                                                                                                                                                                                                                                                                                                                                                                                        | `web/hera-seerr.*`, `Integrations/SeerrExtensionController.cs`, `Integrations/SeerrMapper.cs`                               |
| Server side  | `/HeraTV/discover/*` and `/HeraTV/leaving` call Seerr and Maintainerr from the server. The Seerr API key never reaches a browser, and requests are made as the user's own Seerr account. Users without a linked account can browse but not request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `Integrations/`                                                                                                             |
| Extras       | What Jellyfin Enhanced and Jellyfin Tweaks used to add, rebuilt. Film and series pages show IMDb and Rotten Tomatoes scores (critics and audience, each behind its source's mark; see Score), 4K / Dolby Vision / HDR / Dolby Atmos chips in the meta line and "Also on" streaming logos for the configured region (default GB), all from Seerr or the file's streams through the server. Posters and cards carry 4K / DV / HDR / Atmos chips, fetched in batches for the cards on screen. A card's "more" button, right click or (on a remote) long press offers "Remove from Up Next" or "Not Interested"; the choice is saved per user in the plugin's data folder, honoured by Home, Discover and search, and listed with Unhide in Settings > Home. Backdrops, detail banners and blurhash default on for a browser that has not chosen | `web/hera-extras.*`, `Integrations/ExtrasController.cs`                                                                     |
| Activity     | Where requests really stand, from Sonarr, Radarr and SABnzbd joined to Seerr by id: the Your Requests row, the title sheet and film and series pages show "Downloading 42% · 12 min left", "Searching", "Series 4: 6 of 10" or "Awaiting release" and refresh while visible; `#/home?hera=requests` (from Discover and Control Center) lists the user's requests, with the whole download queue and SABnzbd's speed for administrators. Quiet "Open in Seerr / Radarr / Sonarr / SABnzbd" pills sit on detail pages, the title sheet, request and download rows (Seerr for everyone, the rest for administrators only), built from the `*_PUBLIC_URL` settings. A service that is down just drops its state                                                                                                                                              | `web/hera-activity.*`, `Integrations/ArrActivity.cs`, `Integrations/ActivityController.cs`, `Integrations/ExternalLinks.cs` |
| Statistics   | Tautulli's job, in Hera's language. Dashboard → Statistics (admins): Now Playing cards with art, progress, Direct Play / Direct Stream / Transcoding and, for a transcode, source → output and the reasons in words, every 10 s while visible; then a 7 / 30 / 90 day / 1 year switch over a sentence saying what happened, plays per day (films solid, episodes hatched), a Monday-first 7×24 heatmap, who is watching, top films and TV shows, and playback method, clients and devices as share bars. History comes from Playback Reporting's database (read-only; without it, a sentence says to install it). Hera records what no one keeps, once a minute in its own `stats.db`: peak streams per day, direct vs transcoded time, and resolution and bitrate shares. `#/home?hera=stats` (Your Watching, from Control Center and Settings) is each person's own: the most-watched title's key art behind "This year you watched 41 hours, most of it …", top shows and films, when they watch, genres, a calendar year and streaks, as sentences rather than stat tiles. Days and hours are the server's local time | `Stats/`, `Configuration/herastats.*`, `web/hera-stats.*` |
| Notifications | A round bell beside search, with an unread count, opens a panel in Control Center's material: Today / This Week / Earlier, each notice with its art, a sentence and a time; arrivals carry a row of posters. Your requests ("Dune: Part Two is ready to watch", approved, downloading, declined, from Seerr joined to Sonarr and Radarr every 5 minutes; nothing on the first look, so no flood), new episodes of shows you've watched in the last 90 days (one notice per show per day, after the scan settles) and a daily "New today" at the server's chosen hour. Titles named by unread notices wear a "New" chip on cards and in the detail meta line until read. Each kind can be turned off per person in Settings, and the whole thing per server in Plugins → Hera TV; `POST /HeraTV/notifications/test` writes one of each for an admin | `Notifications/`, `Integrations/UserRequests.cs`, `web/hera-notify.*` |
| Collections | Kometa's work, without Plex. A nightly task (Build Hera TV collections, 04:00, or "Build collections now" in Plugins → Hera TV) keeps real collections in step so Swiftfin and Android TV see them too: Universes and Awards from curated TMDB snapshots (`Collections/Data`), Streaming from each title's GB providers via Seerr, Seasonal inside UK windows (Mothering Sunday and Easter computed) from TMDB keyword tags plus snapshots, Homegrown from production country, Decades, Genres, and, off by default, Studios, Networks and Certificates. Hera's sets carry a `hera-tv` tag, sort together after the household's own (`~NN Group Name`), are created only with at least two members and removed when they fall below or their season ends, take their poster and backdrop from their best member, and are never confused with anyone else's. The Collections tab becomes shelves per group (Seasonal first; Streaming and Networks as wide cards named for the service) with a Groups / All switch back to Jellyfin's grid. Home gains rows that change daily: Newly Released, Popular This Month (Playback Reporting), Highly Rated, the season's row, one streaming service ("On Netflix"), two genres, a decade, award winners, Homegrown and Trending Now | `Collections/`, `web/hera-collections.*`, `web/hera-home.js` |
| Setup        | A Dashboard page (Plugins → Hera TV, and an admin row in Settings) for Seerr, Maintainerr, Sonarr, Radarr and SABnzbd (URL, write-only key, Test connection), a Jellyfin-user to Seerr-user table, and server-wide switches for the Discover tab, Leaving Soon, Your Requests, Trending to Request, request progress, Also on, Ratings and Quality badges, plus the streaming region and the hero's count and interval. `HERATV_*` environment variables win: those fields show read-only with their value (never the key) and a Server environment pill. The switches reach the web client as `features` in `/HeraTV/integrations`                                                                                                                                                                                                                      | `Configuration/`, `Integrations/SettingsController.cs`                                                                      |
| Admin        | `web/hera-dashboard.css` (loaded last, every rule scoped to `body.dashboardDocument`) draws Jellyfin's MUI and legacy emby-* admin pages as one system: one content column from the sidebar's edge to the window's, left-aligned (forms 720px; tables, cards and the home page full width, capped at 1680px); a 22/18/15/13 type scale; 44px fields with the label above and help text in `--hera-label-3`; booleans as grouped switch rows. The home page is a grid: server facts and library counts in one band, compact device cards, one-line Activity and Alerts lists, and Paths as a table. The sidebar sits on one 16/12/46px grid (capsule inset, icon, label), sub-items aligned to their parent's label, for both the docked and the narrow-window drawer                                                                                     | `web/hera-dashboard.css`                                                                                                    |

## Appearance and tokens

Automatic follows the device; Light and Dark pin it. The choice is per user: it is saved in a display-preferences record of the plugin's own (`DisplayPreferences/hera`, client `heratv`), so it follows the user between browsers, and in localStorage, so an inline script in the page head paints the right scheme before anything renders. Control Center's Appearance tile and the Settings app both set it.

Colours are scheme tokens, custom properties on `:root` in `web/hera-tv.css`; components use nothing else. Dark is the default set, light is `:root[data-hera-scheme="light"]`. Anything whose text sits on artwork (the home hero, a detail page's banner and ribbon, Discover's feature card, the player) re-declares the dark set with `.hera-dark` or the selector list beside it, and `html.hera-art-top` does the same for the header while artwork sits under it. In light mode that artwork is a contained sheet: its own dark scrim under the text and a rounded 28px bottom edge, never a fade through grey into white; the first home shelf starts below the hero.

Episode and season banners use their series' backdrop, because a season's is often key art with the title printed in it. Page backdrops (Jellyfin's per-browser Backdrops setting) show as dimmed ambient art on library pages and Favourites; on detail pages the banner carries the art and the page below rests on the same backdrop, heavily blurred and dimmed (or washed pale in light mode), as the Apple TV app continues a title's key art down the page. The home hero always uses Hera's own art. Hovering a card that has a play action frosts its artwork lightly under the play disc; cast, crew and other cards without an action keep their artwork untouched. Nothing on a card carries a standing backdrop-filter (badges, indicators and overlay buttons are solid translucent fills): Jellyfin lays out every card's overlay at all times, and idle blur layers halved the frame rate. Names Jellyfin writes in American English are corrected in the browser: "Movies" to "Films", "Favorites" to "Favourites", "Shows" to "TV Shows".

The theme also sets Jellyfin 12's own `--jf-palette-*` and `--mui-palette-*` variables from the tokens, so stock components it doesn't style directly still pick up the palette in either scheme.

## Where it applies

| Client                                                   | Hera TV                                                                   |
| -------------------------------------------------------- | ------------------------------------------------------------------------- |
| Desktop browsers, Jellyfin Desktop                       | Yes                                                                       |
| LG webOS and other clients that load the server's web UI | Yes                                                                       |
| TV layout                                                | Larger type, white-ring focus, remote navigation into and out of the hero |
| Android TV, Swiftfin, Infuse                             | No: these use their own native interfaces                                 |

## Surviving Jellyfin updates

Hera restyles and adds to Jellyfin's own web client, so a Jellyfin release can change something it leans on. The rule is that an update may cost a feature, never a usable page:

| Layer | What happens when Jellyfin changes |
| --- | --- |
| Server | The index.html rewrite falls back to Jellyfin's own page on any error, so the web client always loads |
| Registry | The Jellyfin pieces Hera needs are named once, in `JF` in `web/hera-tv.js`; a rename is fixed there |
| Modules | Each module lists the pieces it needs on each page (`requires`). Missing after the page settles, the module stands aside on that page and Jellyfin's own version shows. Three failures in a row switch a module off for the session |
| Stock hidden | Jellyfin's own sections are hidden only behind a class Hera sets once its replacement is on the page (`hera-has-seasons`, `hera-has-boxset`, `hera-home`), so a replacement that fails to mount leaves the stock one showing |
| Whole client | No `ApiClient` 20 s after loading: Hera removes its stylesheets and stops, and Jellyfin looks as it does without the plugin |
| By hand | `?hera=off` in the address takes Hera off that tab until it closes; `?hera=on` brings it back |
| Reporting | Modules that stand aside or switch off report to the server; the Dashboard's Hera TV page lists them, with the Jellyfin version and the releases this build was tested on |
| Testing | `.github/workflows/compat.yaml` runs Hera against a real Jellyfin on every pull request, and nightly against `latest` and `unstable`, failing on any module that stands aside |
