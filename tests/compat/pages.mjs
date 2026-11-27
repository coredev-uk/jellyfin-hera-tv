// What the run looks at, and what must be true of each page once Hera has had its say.
//
// A spec is
//   name          the page's name in the summary and its screenshot
//   hash          where to go (the first spec of a pass is opened with a full load)
//   view          the id of Jellyfin's .page element that must be showing (a string, or a list of ids)
//   modules       the Hera modules that must have run on it (a module Jellyfin's markup broke is
//                 reported by status; one that never ran is not, so it is named here)
//   dom           what Hera must have drawn there, so a page Hera left alone fails even when every
//                 module reports ok: a selector that must match, { none } one that must not, or
//                 { notText: [selector, regex] } text that must not match
//   interactions  things a person does there, each throwing a message when Hera does not answer
//   skip          a reason the page cannot be visited, which fails the run (the fixtures are wrong)
//   warnInstead   the same, but only worth a warning
//   play          start the film from its page and keep it playing (see run.mjs)
//
// Page ids and markup are Jellyfin's, so they are the first thing to check when a run fails here
// with "shown as <something else>": the summary names what was showing.

// Core is several modules (hera-tv.js: hero, banner, overview, ribbon, ...), each reporting on its own.
const DETAIL_MODULES = ["banner", "overview", "ribbon", "trailer", "extras-detail", "notify-detail", "activity", "discover"];
const HOME_MODULES = ["hero", "home", "search", "stats", "activity", "discover", "notify", "control-center"];

const details = (id) => `#/details?id=${id}`;

// ---------- reading Jellyfin's selectors from Hera -----------------------------------------------

/**
 * Jellyfin's markup as Hera maps it (`HeraTV.jf`), so that a fix to a selector there is also the
 * fix here, and a test that cannot find its target says which key to look at.
 */
const selectorFor = async (page, key, what) => {
  const selector = await page.evaluate((name) => window.HeraTV?.jf?.[name] ?? null, key);
  if (!selector) throw new Error(`Hera's map of Jellyfin's markup (HeraTV.jf) has no ${key}, so the test cannot find ${what}`);
  return selector;
};

/**
 * Clicks the first element of a JF selector that is actually showing. A JF key can list Jellyfin's
 * modern and legacy markup together (the hidden one first in the document), and page.click would
 * wait on the first match for ever.
 */
const clickShown = async (page, selector, what) => {
  const handle = await page.evaluateHandle((sel) => [...document.querySelectorAll(sel)].find((node) => node.getClientRects().length > 0) ?? null, selector);
  const element = handle.asElement();
  if (!element) throw new Error(`no ${what} is showing (${selector})`);
  await element.click({ timeout: 10_000 });
};

// ---------- interactions ---------------------------------------------------------------------------

/** The search button in the header opens Hera's field. */
const openSearch = {
  name: "header search",
  async run(page) {
    const button = await selectorFor(page, "headerSearchButton", "the header's search button");
    await clickShown(page, button, "header search button");
    await page.waitForSelector(".hera-hs:not([hidden])", { timeout: 5_000 }).catch(() => {
      throw new Error("clicking the header's search button did not open Hera's search field (.hera-hs)");
    });
    await page.keyboard.press("Escape");
    await page.waitForSelector(".hera-hs", { state: "hidden", timeout: 5_000 }).catch(() => {
      throw new Error("Escape did not close Hera's search field");
    });
  },
};

/** The profile button opens Control Center, not Jellyfin's menu. */
const openControlCenter = {
  name: "profile menu",
  async run(page) {
    const button = await selectorFor(page, "profileButton", "the header's profile button");
    await clickShown(page, button, "profile button");
    await page.waitForSelector("dialog.hera-cc[open]", { timeout: 8_000 }).catch(() => {
      throw new Error("clicking the profile button did not open Hera's Control Center (dialog.hera-cc)");
    });
    await page.keyboard.press("Escape");
    await page.waitForSelector("dialog.hera-cc[open]", { state: "detached", timeout: 5_000 }).catch(() => {
      throw new Error("Escape did not close Control Center");
    });
  },
};

/** Pausing the film brings up Hera's pause screen once the controls have gone, then the film goes on. */
const pauseScreen = {
  name: "pause screen",
  async run(page) {
    await page.evaluate(() => document.querySelector("video")?.pause());
    await page.waitForSelector(".hera-pause", { timeout: 20_000 }).catch(() => {
      throw new Error("pausing the film did not bring up Hera's pause screen (.hera-pause) in 20 s");
    });
    await page.evaluate(() => document.querySelector("video")?.play());
    await page.waitForSelector(".hera-pause", { state: "detached", timeout: 10_000 }).catch(() => {
      throw new Error("the pause screen stayed up after the film resumed");
    });
  },
};

/**
 * On a TV the remote starts on the hero's Play button, Down leaves the hero for the rows below,
 * and Up comes back to it. Spatial navigation is Jellyfin's and the hero's own key handling is
 * Hera's; both have to agree.
 */
const remoteOnHome = {
  name: "remote keys on the hero",
  async run(page) {
    const where = () =>
      page.evaluate(() => {
        const active = document.activeElement;
        return { inHero: Boolean(active?.closest?.(".hera-hero")), what: active === document.body ? "nothing" : `${active.tagName.toLowerCase()}.${String(active.className).split(/\s+/)[0]}` };
      });
    await page.waitForFunction(() => document.activeElement?.closest?.(".hera-hero"), null, { timeout: 8_000 }).catch(async () => {
      throw new Error(`the remote did not start in the hero (focus is on ${(await where()).what})`);
    });
    let state = await where();
    for (let press = 0; press < 4 && state.inHero; press += 1) {
      await page.keyboard.press("ArrowDown");
      await page.waitForTimeout(400);
      state = await where();
    }
    if (state.inHero || state.what === "nothing") throw new Error(`Down did not leave the hero for the rows (focus is on ${state.what})`);
    for (let press = 0; press < 8 && !state.inHero; press += 1) {
      await page.keyboard.press("ArrowUp");
      await page.waitForTimeout(400);
      state = await where();
    }
    if (!state.inHero) throw new Error(`Up did not return to the hero (focus is on ${state.what})`);
  },
};

// ---------- the passes ------------------------------------------------------------------------------

/** Desktop layout, signed in as the administrator. The player is last: the film keeps playing while the server is checked. */
export const desktopPages = (data) => {
  const film = data.films[0];
  return [
    { name: "home", hash: "#/home", view: "indexPage", modules: HOME_MODULES, dom: [".hera-hero"], interactions: [openSearch, openControlCenter] },
    { name: "discover", hash: "#/home?hera=discover", view: "indexPage", modules: ["discover"], dom: ["[data-hera-discover]"] },
    { name: "requests", hash: "#/home?hera=requests", view: "indexPage", modules: ["activity"], dom: ["[data-hera-requests]"] },
    { name: "statistics", hash: "#/home?hera=stats", view: "indexPage", modules: ["stats"], dom: ["[data-hera-stats]"] },
    { name: "films-library", hash: `#/movies?topParentId=${data.filmsLibrary}&collectionType=movies`, view: "moviesPage" },
    {
      name: "collections-library",
      hash: `#/boxsets?topParentId=${data.collectionsLibrary}&collectionType=boxsets`,
      view: "boxsetsPage",
      modules: ["collections-browse"],
      // The run makes one collection, too few for Hera's grouped shelves, so Hera must leave
      // Jellyfin's own grid showing rather than an empty view.
      dom: [{ none: "html.hera-collections-on" }],
      skip: data.collectionsLibrary ? null : "Jellyfin made no Collections library for the collection the run created",
    },
    { name: "film", hash: details(film.Id), view: "itemDetailPage", modules: DETAIL_MODULES, dom: ["[data-hera-filled]", ".hera-detail-overview"] },
    { name: "series", hash: details(data.series.Id), view: "itemDetailPage", modules: DETAIL_MODULES, dom: [".hera-seasons"] },
    { name: "episode", hash: details(data.episode.Id), view: "itemDetailPage", modules: DETAIL_MODULES, dom: [".hera-seasons"] },
    { name: "collection", hash: details(data.collection), view: "itemDetailPage", modules: DETAIL_MODULES, dom: [".hera-boxset"] },
    {
      name: "person",
      hash: details(data.person?.Id),
      view: "itemDetailPage",
      modules: ["seerr"],
      warnInstead: data.person ? null : "Jellyfin made no person from the films' .nfo actors, so the person page was not visited",
    },
    { name: "search", hash: "#/search", view: "searchPage", modules: ["search"], dom: ["#searchPage.hera-search-page"] },
    { name: "preferences", hash: "#/mypreferencesmenu", view: "myPreferencesMenuPage", modules: ["settings"], dom: ["#myPreferencesMenuPage.hera-set-page"] },
    { name: "dashboard", hash: "#/dashboard", view: "dashboardPage" },
    {
      name: "plugin-settings",
      hash: "#/configurationpage?name=HeraTV",
      view: "HeraTvSettingsPage",
      dom: ["#heraCfg", { notText: ["#heraCfg", "Loading settings"] }, { none: "#heraCfg .is-error" }],
    },
    {
      name: "plugin-statistics",
      hash: "#/configurationpage?name=HeraStats",
      view: "HeraStatsPage",
      dom: ["#heraStats", { notText: ["#heraStats", "Loading statistics"] }, { none: "#heraStats .hera-stats-error" }],
    },
    // Starts the film from its page, plays it, and keeps it playing: see run.mjs.
    { name: "player", hash: details(film.Id), view: "videoOsdPage", modules: ["player", "pause", "postplay"], play: true, interactions: [pauseScreen] },
  ];
};

/** The TV layout at 1920x1080 (Jellyfin's own `layout` setting), driven with the keys a remote sends. */
export const tvPages = (data) => {
  const film = data.films[0];
  const tv = ["html.layout-tv"];
  return [
    { name: "tv-home", hash: "#/home", view: "indexPage", modules: HOME_MODULES, dom: [...tv, ".hera-hero"], interactions: [remoteOnHome] },
    { name: "tv-film", hash: details(film.Id), view: "itemDetailPage", modules: DETAIL_MODULES, dom: [...tv, "[data-hera-filled]", ".hera-detail-overview"] },
    { name: "tv-series", hash: details(data.series.Id), view: "itemDetailPage", modules: DETAIL_MODULES, dom: [...tv, ".hera-seasons"] },
    { name: "tv-collection", hash: details(data.collection), view: "itemDetailPage", modules: DETAIL_MODULES, dom: [...tv, ".hera-boxset"] },
    { name: "tv-preferences", hash: "#/mypreferencesmenu", view: "myPreferencesMenuPage", modules: ["settings"], dom: [...tv, "#myPreferencesMenuPage.hera-set-page"] },
  ];
};

/** Nobody signed in: Jellyfin's sign-in page, restyled by Hera. */
export const signedOutPages = () => [
  { name: "login", hash: "", view: "loginPage", signedOut: true, modules: ["login"], dom: ["#loginPage.hera-login"] },
];

/** `?hera=off`, the way out when an update leaves a page unusable: Hera must take itself off the tab. */
export const offSpec = { name: "hera-off", hash: "?hera=off#/login", view: "loginPage" };

/**
 * With `DisabledModules = ["discover"]`: Discover's address must leave home as it is, and nothing of
 * Discover (its class on <html>, its tab, its view) may exist, while the rest of Hera runs.
 */
export const disabledPages = () => [
  {
    name: "discover-disabled",
    hash: "#/home?hera=discover",
    view: "indexPage",
    modules: ["hero", "home", "search"],
    dom: [".hera-hero", { none: "html.hera-m-discover" }, { none: "html.hera-discover-on" }, { none: "[data-hera-discover]" }, { none: ".hera-discover-tab" }],
    checks: [
      async (page) => {
        const names = await page.evaluate(() => window.HeraTV?.health?.().modules.map((m) => m.name) ?? []);
        return names.includes("discover") ? "Discover is in the health report although it is in DisabledModules (it must never be registered)" : null;
      },
    ],
  },
];
