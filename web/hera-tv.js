/*
 * Hera TV: the Apple TV app's behaviour for Jellyfin 12's web client.
 *  - Home: a full-bleed hero of unwatched titles with logo artwork, crossfading on a timer
 *    that pauses on hover, focus, a hidden tab or the pause button.
 *  - Series pages: season tabs over a horizontal shelf of episode stills, as tv.apple.com.
 *  - Detail pages: logo artwork stands in for the title.
 * Everything talks to the server through the page's own ApiClient; playback goes through the
 * server's remote-control endpoint aimed at this browser's own session, so the stock player opens.
 */
(() => {
  "use strict";

  if (window.HeraTV) {
    window.HeraTV.teardown();
  }

  const root = document.documentElement;

  // `?hera=off` (in the address, or after the # as Jellyfin's routes put it) takes Hera off this
  // tab until it is closed, and `?hera=on` brings it back: the way out if an update ever leaves a
  // page unusable. Off, the stylesheets go and nothing below runs.
  try {
    const asked = new URLSearchParams(window.location.search).get("hera") ?? new URLSearchParams(window.location.hash.split("?")[1] || "").get("hera");
    if (asked === "off") sessionStorage.setItem("hera-off", "1");
    if (asked === "on") sessionStorage.removeItem("hera-off");
    if (sessionStorage.getItem("hera-off") === "1") {
      document.querySelectorAll("link[data-hera-tv]").forEach((node) => node.remove());
      [...root.classList].filter((name) => name === "hera" || name.startsWith("hera-")).forEach((name) => root.classList.remove(name));
      root.removeAttribute("data-hera-scheme");
      console.info("[Hera TV:core] off for this tab; add ?hera=on to the address to bring it back");
      return;
    }
  } catch {
    /* no sessionStorage: carry on */
  }

  // hera-on switches on the core stylesheets and hera-m-<module> each module's (the bundler gates
  // every rule behind one of them). The server's head script puts them on before first paint, so
  // nothing draws unstyled while this script loads; from here core only takes them away: in safe
  // mode, while a module stands aside or is off, and for modules the plugin's settings have
  // switched off since the page was served. hera-on is added again here for a page served without it.
  root.classList.add("hera", "hera-on");

  const state = {
    config: { heroItemCount: 8, heroIntervalSeconds: 8, disabledModules: [] },
    ready: false, // the server's settings have arrived and registered modules are running
    disabled: new Set(), // modules switched off in the plugin's settings
    heroItems: null,
    heroUser: null,
    heroLoad: null,
    heroFetchedAt: 0,
    hero: null,
    cleanups: [],
  };

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ---------- Jellyfin's own markup and storage, in one place --------------------------------
  // Every selector into Jellyfin's web client lives here, so an update that renames something is
  // fixed once, and the Dashboard can name the piece that went missing. Each entry is
  // [selector, scope, required]. "page" keys are looked for inside the page showing (a hidden,
  // cached page never satisfies one); "chrome" keys live outside any page. A required key that
  // kit.jf can't find makes the calling module report partial; an optional one is allowed to be
  // absent (a film with no logo). Modules also list keys in their `requires`, which is stronger:
  // until they are there the module doesn't run on that page.
  const JF_TABLE = {
    page: [".page:not(.hide)", "chrome", false],
    pageRoot: [".page", "chrome", true],
    appBar: [".MuiAppBar-root", "chrome", false],
    appBarTabs: [".MuiAppBar-root > .MuiToolbar-root:first-child > .MuiStack-root", "chrome", false],
    appBarTitle: [".MuiAppBar-root .MuiTypography-h2", "chrome", false],
    legacyHeader: [".skinHeader", "chrome", false],
    // The admin Dashboard's own document and header: its app bar has no search button, by design.
    dashboardDocument: [".dashboardDocument", "chrome", false],
    // The avatar button of Jellyfin's React header (its aria-controls is the id of the user menu it opens) and the legacy header's.
    profileButton: ['.MuiAppBar-root button[aria-controls="app-user-menu"], .headerUserButton', "chrome", false],
    libraryMenu: ["#library-view-menu", "chrome", false],
    branding: ["#cssBranding", "chrome", false],
    scroller: [".emby-scroller", "chrome", false],
    videoOsdPage: ["#videoOsdPage", "chrome", false],
    homePage: ["#indexPage", "chrome", false],
    homeTab: ["#homeTab", "page", true],
    homeSections: ["#homeTab .homeSectionsContainer", "page", false],
    homeSection: [".homeSectionsContainer .verticalSection:not(.hide)", "page", false],
    homeOfficialRating: [".mediaInfoOfficialRating", "page", false],
    sectionTitle: ["h2.sectionTitle", "page", false],
    verticalSection: [".verticalSection", "page", false],
    card: [".card", "page", false],
    cardArt: [".cardScalable, .cardImageContainer", "page", false],
    detailRibbon: [".detailRibbon", "page", true],
    detailRibbonInfo: [".detailRibbon .infoWrapper", "page", false],
    detailButtons: [".mainDetailButtons", "page", true],
    detailPlay: [".mainDetailButtons .btnPlay", "page", false],
    detailButtonContent: [".detailButton-content", "page", false],
    detailPrimary: [".detailPagePrimaryContent", "page", true],
    detailSection: [".detailPagePrimaryContent .detailSection", "page", true],
    detailMisc: [".itemMiscInfo-primary", "page", true],
    detailBanner: ["#itemBackdrop", "page", true],
    detailLogo: [".detailLogo", "page", true],
    detailSecondary: [".detailPageSecondaryContainer", "page", true],
    miscInfo: [".itemMiscInfo", "page", false],
    miscAllItems: [".itemMiscInfo .mediaInfoItem", "page", false],
    miscItems: [".itemMiscInfo-primary .mediaInfoItem", "page", false],
    miscRating: [".itemMiscInfo .mediaInfoOfficialRating", "page", false],
    videoOsd: [".videoOsdBottom", "page", true],
    prefsLinks: [".readOnlyContent a.listItem-border", "page", true],
    loginForm: [".manualLoginForm", "page", true],
    loginStack: [".margin-auto-y", "page", true],
    loginActions: [".readOnlyContent", "page", false],
    loginUsers: [".visualLoginForm", "page", false],
    // The Collections library page (#boxsetsPage): the box holding the alphabet picker and grid.
    libraryBody: [".libraryPage .padded-bottom-page", "page", true],
    headerTabsSlider: [".headerTabs .emby-tabs-slider", "chrome", false],
    headerTabButton: [".headerTabs .emby-tab-button", "chrome", false],
    personNameContainer: [".nameContainer", "page", false],
    seerrChildrenContent: ["#childrenContent", "page", false],
    seerrChildrenSections: ["#childrenContent > .verticalSection", "page", false],
    seerrStockCard: [".card[data-id]", "page", false],
    seerrListChildren: ["#listChildrenCollapsible", "page", false],
    seerrSimilar: ["#similarCollapsible", "page", false],
    extrasStockCards: ['.card[data-id][data-type="Movie"], .card[data-id][data-type="Series"], .card[data-id][data-type="Episode"], .card[data-id][data-type="Video"]', "page", false],
    extrasCardArt: [".cardScalable", "page", false],
    extrasCardProgress: [".itemProgressBar", "page", false],
    extrasDetailContent: [".detailPagePrimaryContent .detailSectionContent", "page", false],
    extrasEndsAt: [".endsAt", "page", false],
    playerOsdControls: [".osdControls", "page", true],
    playerOsdButtons: [".osdControls .buttons", "page", false],
    playerVideo: [".videoPlayerContainer video", "chrome", false],
    playerFrame: [".videoPlayerContainer", "chrome", true],
    playerUpNext: [".upNextDialog:not(.hide)", "chrome", false],
    playerDialog: [".dialogContainer .dialog", "chrome", false],
    detailTrailerButton: [".btnPlayTrailer", "page", false],
    headerSearchButton: ['.MuiAppBar-root a[href="#/search"], .skinHeader a[href="#/search"], .headerSearchButton', "chrome", false],
    searchHeader: [".MuiAppBar-root, .skinHeader", "chrome", false],
    legacyHeaderTabs: [".skinHeader .headerTabs", "chrome", false],
    loginPage: ["#loginPage", "page", false],
    loginStandalone: [".standalonePage", "page", false],
    loginHidden: [".hide", "page", false],
    loginDisclaimer: [".loginDisclaimerContainer", "page", false],
    loginDisclaimerBox: [".loginDisclaimer", "page", false],
    loginQuick: [".btnQuick", "page", false],
    loginForgot: [".btnForgotPassword", "page", false],
    loginSubmit: [".button-submit", "page", false],
    loginSelectServer: [".btnSelectServer", "page", false],
    loginUsername: ["#txtManualName", "page", false],
    loginPassword: ["#txtManualPassword", "page", false],
    loginSso: [".sso-login button", "page", false],
    loginDialog: [".formDialog", "chrome", false],
    loginQuickDialog: ["#quickConnectAlert", "chrome", false],
    loginDialogText: [".dialogContentInner .text", "chrome", false],
    prefsMenu: [".readOnlyContent", "page", false],
    prefsLinkLabel: [".listItemBodyText", "page", false],
    prefsLinkIcon: [".listItemIcon", "page", false],
    prefsAdmin: [".adminSection", "page", false],
    prefsSubpage: [".userPreferencesPage", "page", false],
    prefsSubpageBody: [":scope > .padded-left", "page", false],
    appBarEnd: [".MuiAppBar-root > .MuiToolbar-root:first-child > .MuiBox-root:last-child", "chrome", false],
    notifyCard: [".card[data-id]", "page", false],
    notifyCardArt: [".cardScalable", "page", false],
  };
  const JF = Object.freeze(Object.fromEntries(Object.entries(JF_TABLE).map(([key, [selector]]) => [key, selector])));
  const JF_META = Object.freeze(Object.fromEntries(Object.entries(JF_TABLE).map(([key, [, place, required]]) => [key, Object.freeze({ scope: place, required })])));

  // Jellyfin's own localStorage keys, by the name its settings code uses; each says which
  // jellyfin-web module it mirrors, so a rename there is found by reading one list. "user" keys are
  // stored as <user id>-<name>.
  const JF_STORAGE = Object.freeze({
    // The ApiClient's saved sign-ins (jellyfin-apiclient, credentials provider).
    credentials: { key: "jellyfin_credentials", user: false },
    // The device id (src/components/apphost.js).
    deviceId: { key: "_deviceId2", user: false },
    // The layout choice: appSettings.get("layout") in src/components/layoutManager.js.
    layout: { key: "layout", user: false },
    // Per-user settings (src/scripts/settings/userSettings.js, through appSettings's <user>-<name> keys).
    language: { key: "language", user: true },
    enableBackdrops: { key: "enableBackdrops", user: true },
    detailsBanner: { key: "detailsBanner", user: true },
    blurhash: { key: "blurhash", user: true },
    segmentTypeAction: { key: "segmentTypeAction", user: true },
  });
  const storageName = (name, user) => {
    const base = name.split("__")[0];
    const entry = JF_STORAGE[base];
    if (!entry || entry.user !== user) console.warn("[Hera TV:core] " + name + " is not a known Jellyfin " + (user ? "user" : "device") + " storage key (JF_STORAGE)");
    const key = entry ? entry.key + name.slice(base.length) : name;
    return user ? userId() + "-" + key : key;
  };

  // ---------- errors: where they came from -------------------------------------------------
  // The bundle is every script joined; its wrapper hands over each file's first line (HeraBundle),
  // so a frame in hera-bundle.js (or the old-TV hera-bundle-legacy.js) reads as the file and line it
  // came from.
  const bundleFiles = window.HeraBundle?.files ?? [];
  const BUNDLE_FRAME = /hera-bundle(?:-legacy)?\.js(?:\?[^:\s)]*)?:(\d+):(\d+)/;
  const firstHeraFrame = (error) => {
    for (const line of String(error?.stack || "").split("\n")) {
      const hit = BUNDLE_FRAME.exec(line);
      if (!hit) continue;
      const row = Number(hit[1]);
      let file = null;
      for (const entry of bundleFiles) if (entry[1] <= row) file = entry;
      return file ? file[0] + ":" + (row - file[1] + 1) + ":" + hit[2] : "hera-bundle.js:" + row + ":" + hit[2];
    }
    return null;
  };
  /** A failure as one line: the message and the first place in Hera's own code it passed through. */
  const formatError = (error) => {
    const message = String(error?.message || error).slice(0, 250);
    const frame = firstHeraFrame(error);
    return frame ? message + " (" + frame + ")" : message;
  };

  // ---------- small tools for modules ---------------------------------------------------------

  /** Listeners and other clean-up for one lifetime: dispose() runs them newest first and the scope can be used again. */
  const scope = () => {
    let cleanups = [];
    return {
      listen(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        const off = () => target.removeEventListener(type, handler, options);
        cleanups.push(off);
        return off;
      },
      add(fn) {
        cleanups.push(fn);
        return fn;
      },
      dispose() {
        const run = cleanups;
        cleanups = [];
        for (let i = run.length - 1; i >= 0; i--) {
          try {
            run[i]();
          } catch (error) {
            console.warn("[Hera TV:core] clean-up failed", error);
          }
        }
      },
    };
  };

  /**
   * Answers kept for `ttl` ms, at most `max` of them. get() shares one in-flight load between callers;
   * a failure is forgotten at once; peek() is the settled value, or undefined; expired entries go
   * whenever the cache grows past its size.
   */
  const ttlCache = ({ ttl, max = 100 }) => {
    const entries = new Map(); // key -> { at, promise, value, settled }
    const trim = (now) => {
      if (entries.size <= max) return;
      for (const [key, entry] of entries) if (now - entry.at >= ttl) entries.delete(key);
      for (const key of entries.keys()) {
        if (entries.size <= max) break;
        entries.delete(key);
      }
    };
    return {
      get(key, loader) {
        const now = Date.now();
        const held = entries.get(key);
        if (held && now - held.at < ttl) return held.promise;
        const entry = { at: now, promise: null, value: undefined, settled: false };
        entry.promise = new Promise((resolve) => resolve(loader())).then(
          (value) => {
            entry.value = value;
            entry.settled = true;
            return value;
          },
          (error) => {
            if (entries.get(key) === entry) entries.delete(key);
            throw error;
          },
        );
        entries.set(key, entry);
        trim(now);
        return entry.promise;
      },
      peek(key) {
        const held = entries.get(key);
        return held?.settled && Date.now() - held.at < ttl ? held.value : undefined;
      },
      delete: (key) => entries.delete(key),
      clear: () => entries.clear(),
    };
  };

  const textTools = {
    /** "1 film", "3 films": the count (with its thousands separators) and the word that fits it. */
    plural: (n, one, many = one + "s") => n.toLocaleString() + " " + (n === 1 ? one : many),
    /** "9 December 2026" from a yyyy-mm-dd date. */
    longDate: (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" }),
  };

  // Back, as a keyboard, a webOS remote (461) and a Tizen remote (10009) send it.
  const BACK_KEYS = new Set(["Escape", "Backspace", "GoBack", "BrowserBack"]);
  const keyTools = { isBack: (event) => BACK_KEYS.has(event.key) || event.keyCode === 461 || event.keyCode === 10009 };

  // ---------- the classes Hera puts on <html> --------------------------------------------------
  // Core alone writes the view classes, from three facts: the home tab is showing, a detail page's
  // banner is, or a module's own full-page view has taken the page over (Discover, Requests, Your
  // Watching, a person). While one has, Jellyfin's home content and backdrop step aside (one block
  // in hera-tv.css, keyed on html.hera-view-taken) and the home hero's classes are off.
  const view = { home: false, detailArt: false, taken: null };
  const applyView = () => {
    if (health.boot === "safe") return; // Hera is off for this tab; late work must not put its classes back
    root.classList.toggle("hera-view-taken", !!view.taken);
    if (view.taken) root.dataset.heraTaken = view.taken.name;
    else delete root.dataset.heraTaken;
    root.classList.toggle("hera-home", view.home && !view.taken);
    root.classList.toggle("hera-art-top", view.detailArt || !!view.taken?.art);
  };
  const setView = (patch) => {
    Object.assign(view, patch);
    applyView();
  };
  /** Takes the page over for `name`; calling it again with the same name updates `art` (whether artwork runs under the header). */
  const takeView = (name, { art = false } = {}) => setView({ taken: { name, art } });
  /** Gives the page back, if `name` still has it. */
  const releaseView = (name) => {
    if (view.taken?.name === name) setView({ taken: null });
  };
  const clearRootClasses = () => {
    [...root.classList].filter((name) => name === "hera" || name.startsWith("hera-")).forEach((name) => root.classList.remove(name));
    root.removeAttribute("data-hera-scheme");
    root.removeAttribute("data-hera-view");
    root.removeAttribute("data-hera-taken");
    Object.assign(view, { home: false, detailArt: false, taken: null });
  };

  // ---------- helpers -----------------------------------------------------------------

  const api = () => window.ApiClient;
  const userId = () => api()?.getCurrentUserId?.();

  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : value);
    }
    for (const child of [].concat(children)) {
      if (child) node.append(child);
    }
    return node;
  };

  // The material-icons class is the icon font's; hera-icon is how Hera finds its own icons again.
  const icon = (name) => el("span", { class: "material-icons hera-icon", "aria-hidden": "true", text: name });

  // A link out of Jellyfin (Seerr, YouTube, a streaming service, Letterboxd) opens a new tab, and a
  // TV has nowhere to open one: the Jellyfin apps for webOS, Android TV and the TV browsers either
  // do nothing or strand the person outside Jellyfin. In the TV layout such a link is left out, or,
  // with { fallback }, drawn as that element with the same class and content but nothing to press.
  // Every external link goes through here (tests/lint checks no other code sets target="_blank").
  const externalLink = (attrs, children = [], { fallback = null } = {}) => {
    if (root.classList.contains("layout-tv")) {
      if (!fallback) return null;
      // Nothing to press: no address, no tooltip promising one, no label saying it opens a tab.
      return el(fallback, { ...attrs, href: null, title: null, "aria-label": null }, children);
    }
    return el("a", { ...attrs, target: "_blank", rel: "noopener noreferrer" }, children);
  };

  const getJSON = (path, params) => api().getJSON(api().getUrl(path, params));

  // One fetch of an item, whoever asks: a title page's banner, overview, shelf and modules all
  // want the same Users/{user}/Items/{id} at once. Kept for half a minute.
  const itemCache = ttlCache({ ttl: 30 * 1000, max: 100 });
  const fetchItem = (id) => itemCache.get(userId() + ":" + id, () => api().getItem(userId(), id));

  // Quality 80: indistinguishable from 90 at card and banner sizes, about a third fewer bytes.
  const imageUrl = (itemId, type, opts = {}) =>
    api().getScaledImageUrl(itemId, { type, quality: 80, ...opts });

  const runtime = (ticks) => {
    if (!ticks) return null;
    const minutes = Math.round(ticks / 600000000);
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h ? `${h} hr${m ? ` ${m} min` : ""}` : `${m} min`;
  };

  // A certificate as the country's own board writes it: "GB-15" is "15". Jellyfin keeps the
  // country prefix on everything outside the US; TV-, PG- and NC- are US ratings, not countries.
  const certificate = (rating) => (rating ? rating.replace(/^(?!(?:TV|PG|NC)-)[A-Z]{2}-(?=\S)/, "") : rating);

  const shuffle = (list) => {
    const out = list.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  };

  const go = (hash) => {
    window.location.hash = hash;
  };

  // Play on this browser by sending the server's PlayNow command to our own session. Looked up
  // each time: a server restart gives this browser a new session, and a remembered id would send
  // the command nowhere.
  const ownSession = async () => {
    const sessions = (await getJSON("Sessions", { deviceId: api().deviceId() })) ?? [];
    return (sessions.find((s) => s.UserId === userId()) ?? sessions[0])?.Id ?? null;
  };

  const play = async (item) => {
    // A card may know only an id (and perhaps a kind): the item itself says what to resume.
    if (!item.Type || (item.Type !== "Series" && !item.UserData)) item = await api().getItem(userId(), item.Id);
    let target = item;
    if (item.Type === "Series") {
      const next = await getJSON("Shows/NextUp", { seriesId: item.Id, userId: userId(), limit: 1 });
      target = next?.Items?.[0];
      if (!target) {
        const first = await getJSON(`Shows/${item.Id}/Episodes`, { userId: userId(), limit: 1 });
        target = first?.Items?.[0];
      }
    }
    if (!target) return go(`#/details?id=${item.Id}`);
    const id = await ownSession();
    if (!id) return go(`#/details?id=${target.Id}`);
    const params = { playCommand: "PlayNow", itemIds: target.Id };
    const position = target.UserData?.PlaybackPositionTicks;
    if (position) params.startPositionTicks = position;
    await api().ajax({ type: "POST", url: api().getUrl(`Sessions/${id}/Playing`, params) });
  };

  /** A card's Play, for anything the library holds: `kit.card({ action: playAction(item) })`. */
  const playAction = (item) => ({
    icon: "play_arrow",
    label: `Play ${item.Name}`,
    run: () => track("core", play(item)),
  });

  const toggleFavourite = async (item, button) => {
    const next = !(item.UserData?.IsFavorite ?? false);
    await api().updateFavoriteStatus(userId(), item.Id, next);
    item.UserData = { ...(item.UserData || {}), IsFavorite: next };
    button.setAttribute("aria-pressed", String(next));
    button.querySelector(".hera-icon").textContent = next ? "favorite" : "favorite_border";
    button.setAttribute("aria-label", next ? "Remove from Favourites" : "Add to Favourites");
  };

  // ---------- appearance ----------------------------------------------------------------
  // Automatic follows the device; Light and Dark pin it. The choice is saved in a display-
  // preferences record of its own (so it follows the user between browsers, and Jellyfin's own
  // settings saves never overwrite it) and in localStorage, so the next load paints in the
  // right scheme before the server answers. hera-tv.css keys every colour off data-hera-scheme.

  const APPEARANCES = [
    ["auto", "Automatic"],
    ["light", "Light"],
    ["dark", "Dark"],
  ];
  const APPEARANCE_KEY = "hera-appearance";
  const lightQuery = window.matchMedia?.("(prefers-color-scheme: light)");
  const storedAppearance = () => {
    try {
      return localStorage.getItem(APPEARANCE_KEY);
    } catch {
      return null;
    }
  };
  const prefsUrl = () => api().getUrl("DisplayPreferences/hera", { userId: userId(), client: "heratv" });

  const appearance = {
    pref: APPEARANCES.some(([key]) => key === storedAppearance()) ? storedAppearance() : "auto",
    listeners: new Set(),
    scheme() {
      if (this.pref === "light" || this.pref === "dark") return this.pref;
      return lightQuery?.matches ? "light" : "dark";
    },
    label(pref = this.pref) {
      return APPEARANCES.find(([key]) => key === pref)?.[1] || "Automatic";
    },
    apply() {
      const scheme = this.scheme();
      root.dataset.heraScheme = scheme;
      document.querySelector('meta[name="theme-color"]')?.setAttribute("content", scheme === "light" ? "#ffffff" : "#000000");
      this.listeners.forEach((fn) => fn(this.pref, scheme));
    },
    remember(pref) {
      this.pref = pref;
      try {
        localStorage.setItem(APPEARANCE_KEY, pref);
      } catch {
        /* private mode: the server copy still holds it */
      }
      this.apply();
    },
    async load() {
      const prefs = await api().getJSON(prefsUrl()).catch(() => null);
      const pref = prefs?.CustomPrefs?.[APPEARANCE_KEY];
      if (APPEARANCES.some(([key]) => key === pref) && pref !== this.pref) this.remember(pref);
    },
    async set(pref) {
      if (!APPEARANCES.some(([key]) => key === pref)) return;
      this.remember(pref);
      const prefs = (await api().getJSON(prefsUrl()).catch(() => null)) || { Id: "hera", Client: "heratv" };
      prefs.CustomPrefs = { ...prefs.CustomPrefs, [APPEARANCE_KEY]: pref };
      await api().ajax({ type: "POST", url: prefsUrl(), data: JSON.stringify(prefs), contentType: "application/json" });
    },
    /** Calls `fn(pref, scheme)` on every change; returns the unsubscribe. */
    subscribe(fn) {
      this.listeners.add(fn);
      return () => this.listeners.delete(fn);
    },
  };

  // A person's own Hera switches (post-play, its trailers), kept beside the appearance in the same
  // display-preferences record, so they follow the person between browsers. Read once per user.
  const prefs = {
    user: null,
    loaded: null,
    load() {
      if (this.user !== userId() || !this.loaded) {
        this.user = userId();
        this.loaded = api()
          .getJSON(prefsUrl())
          .then((record) => record?.CustomPrefs || {})
          .catch(() => ({}));
      }
      return this.loaded;
    },
    /** Resolves to the switch's value: true unless the person turned it off. */
    async on(key) {
      return (await this.load())[key] !== "false";
    },
    async set(key, on) {
      const record = (await api().getJSON(prefsUrl()).catch(() => null)) || { Id: "hera", Client: "heratv" };
      record.CustomPrefs = { ...record.CustomPrefs, [key]: String(on) };
      await api().ajax({ type: "POST", url: prefsUrl(), data: JSON.stringify(record), contentType: "application/json" });
      this.loaded = Promise.resolve(record.CustomPrefs);
    },
  };

  // ---------- shared kit for modules ----------------------------------------------------
  // hera-home.js and hera-discover.js load after this file and build on these pieces, so every
  // row, card and request in the client looks and behaves the same.

  /** Calls the plugin's own API as the signed-in user. */
  const hera = (path, { method = "GET", query, body } = {}) =>
    api().ajax({
      type: method,
      url: api().getUrl(`HeraTV/${path}`, query),
      data: body === undefined ? undefined : JSON.stringify(body),
      contentType: body === undefined ? undefined : "application/json",
      dataType: "json",
    });

  // Which integrations the server has, and whether this user is linked to Seerr; one fetch per user.
  let integrationsFor = null;
  let integrationsLoad = null;
  const integrations = () => {
    if (integrationsFor !== userId()) {
      integrationsFor = userId();
      integrationsLoad = hera("integrations").catch(() => ({ seerr: false, seerrLinked: false, maintainerr: false }));
    }
    return integrationsLoad;
  };

  /**
   * One card for every row: poster (2:3) or wide (16:9) artwork with an optional badge and
   * progress bar, title and subtitle below. `href` makes it a link; `onClick` a button.
   * `action` ({ icon, label, run }) is what the card does from where it sits (Play, for anything
   * the library holds): hovered or focused, its artwork frosts under a glass disc, as Jellyfin's
   * own posters and the episode stills do. On a link the disc is a button that runs it; on a card
   * that already runs it when pressed, the disc is only a picture of it.
   */
  const card = ({ href, onClick, image, shape = "poster", title, subtitle, badge, badgeTone, progress, label, action }) => {
    // The disc is a picture of the action, never a second control: a button inside the card's own
    // link is invalid and doubles the Tab stops. A pointer pressing it runs the action instead of
    // following the link; a keyboard opens the title and plays from there.
    let disc = null;
    if (action) {
      disc = el("span", { class: "hera-btn hera-btn--glass hera-card__play", "aria-hidden": "true" }, icon(action.icon));
      if (href) {
        disc.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          action.run(e);
        });
      }
    }
    const art = el("span", { class: "hera-card__art" }, [
      image
        ? el("img", { src: image, alt: "", loading: "lazy", decoding: "async" })
        : el("span", { class: "hera-card__fallback", text: title }),
      badge ? el("span", { class: `hera-card__badge${badgeTone ? ` hera-card__badge--${badgeTone}` : ""}`, text: badge }) : null,
      progress > 0
        ? el("span", { class: "hera-card__progress" }, el("span", { style: `width:${Math.min(100, Math.max(3, progress))}%` }))
        : null,
      action ? el("span", { class: "hera-card__frost", "aria-hidden": "true" }) : null,
      disc,
    ]);
    const text = [
      title ? el("span", { class: "hera-card__title", text: title }) : null,
      subtitle ? el("span", { class: "hera-card__subtitle", text: subtitle }) : null,
    ];
    const attrs = { class: `hera-card hera-card--${shape}${action ? " has-action" : ""}`, "aria-label": label || [title, subtitle].filter(Boolean).join(", ") };
    if (href) return el("a", { ...attrs, href }, [art, ...text]);
    const button = el("button", { ...attrs, type: "button" }, [art, ...text]);
    if (onClick) button.addEventListener("click", onClick);
    return button;
  };

  /**
   * A titled horizontal row of cards. `id` makes it replaceable: mounting a row with the same id
   * swaps the old one in place. Its paddles come from `paddlesFor`, as every sideways row's do.
   */
  const shelf = ({ id, title, href, cards, shape = "poster" }) => {
    const track = el("div", { class: `hera-shelf hera-shelf--${shape}` }, cards);
    const heading = el("h2", { class: "sectionTitle sectionTitle-cards hera-row__title", text: title });
    return el("section", { class: "hera-row verticalSection", "data-hera-row": id || null, "aria-label": title }, [
      el("div", { class: "hera-row__head" }, [
        href
          ? el("a", { class: "hera-row__link", href }, [heading, icon("chevron_right")])
          : heading,
      ]),
      el("div", { class: "hera-row__viewport" }, track),
    ]);
  };

  // ---------- paddles --------------------------------------------------------------------
  // tv.apple.com's shelf paddles: while a pointer is over a sideways row, a glass chevron sits at
  // each end it can still scroll towards, on the edge of the cards and level with their artwork,
  // and moves the row on most of a page. Every such row gets them, Hera's and Jellyfin's alike
  // (Recently Added, Episodes, Cast & Crew); they are made the first time a pointer comes over
  // the row. A remote or a keyboard moves focus through the cards instead and the row follows
  // it, so the paddles stay out of the tab order and off the TV layout.
  const SCROLLERS = `.hera-shelf, ${JF.scroller}`;
  const ART = `.hera-card__art, .hera-episode__still, ${JF.cardArt}, img`;
  const PADDLE = 44;

  const paddlesFor = (track) => {
    const host = track.parentElement;
    if (!host) return null;
    if (getComputedStyle(host).position === "static") host.classList.add("hera-paddle-host");
    host.classList.add("hera-paddled");
    const title = track.closest(`section, ${JF.verticalSection}`)?.querySelector("h2, h3")?.textContent.trim() || "row";
    const paddle = (dir) =>
      el(
        "button",
        {
          type: "button",
          tabindex: "-1",
          class: `hera-row__paddle hera-row__paddle--${dir}`,
          "aria-label": dir === "prev" ? `Scroll ${title} back` : `Scroll ${title} on`,
          onclick: () =>
            track.scrollBy({
              left: (dir === "prev" ? -1 : 1) * track.clientWidth * 0.85,
              behavior: reduceMotion.matches ? "auto" : "smooth",
            }),
        },
        icon(dir === "prev" ? "chevron_left" : "chevron_right"),
      );
    const prev = paddle("prev");
    const next = paddle("next");
    const sync = () => {
      prev.hidden = track.scrollLeft <= 4;
      next.hidden = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
    };
    const place = () => {
      const box = track.getBoundingClientRect();
      const frame = host.getBoundingClientRect();
      const art = track.querySelector(ART)?.getBoundingClientRect();
      const style = getComputedStyle(track);
      const middle = art?.height ? art.top + art.height / 2 : box.top + box.height / 2;
      const start = Math.max(4, box.left + parseFloat(style.paddingLeft) - PADDLE / 2);
      const end = Math.min(window.innerWidth - PADDLE - 4, box.right - parseFloat(style.paddingRight) - PADDLE / 2);
      prev.style.top = next.style.top = `${Math.round(middle - frame.top - PADDLE / 2)}px`;
      prev.style.left = `${Math.round(start - frame.left)}px`;
      next.style.left = `${Math.round(end - frame.left)}px`;
      sync();
    };
    track.addEventListener("scroll", sync, { passive: true });
    // A row redrawn in place (another series' episodes) leaves its old track's paddles behind.
    host.querySelectorAll(":scope > .hera-row__paddle").forEach((old) => old.remove());
    host.append(prev, next);
    track.heraPaddles = { place };
    return track.heraPaddles;
  };

  const onPaddleHover = (event) => {
    if (event.pointerType === "touch" || root.classList.contains("layout-tv")) return;
    const track = event.target.closest?.(SCROLLERS);
    if (!track || !/auto|scroll/.test(getComputedStyle(track).overflowX)) return;
    (track.heraPaddles || paddlesFor(track))?.place();
  };

  /** Puts a row where `place` says, replacing a previous row with the same id. */
  const mountRow = (row, place) => {
    const id = row.dataset.heraRow;
    const old = id ? document.querySelector(`[data-hera-row="${CSS.escape(id)}"]`) : null;
    if (old) old.replaceWith(row);
    else place(row);
    return row;
  };

  /** A short date, as tvOS writes them: "9 Dec". */
  const shortDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { day: "numeric", month: "short" });

  const modules = []; // running: registered and not switched off in the plugin's settings
  const pending = []; // registered before the server's settings arrived

  // ---------- compatibility ------------------------------------------------------------
  // What Hera leans on in Jellyfin's own web client is listed in JF (top of this file), so a
  // Jellyfin update that renames something is fixed there once. Each module names the pieces it
  // needs on each kind of page (`requires`); when one is missing after the page has settled, that
  // module stands aside on that page and stock Jellyfin shows, instead of a half-built page, and the
  // Dashboard's Hera TV page says which piece went missing. A module that looks something up
  // through kit.jf and doesn't find it reports itself partial; one that keeps throwing is switched
  // off for the session. If the web client itself is unrecognisable (no ApiClient, or one without
  // the methods Hera calls), Hera removes its stylesheets and stops: Jellyfin then looks exactly as
  // it does without the plugin. `?hera=off` in the address does the same by hand, for this tab.
  const ERROR_LIMIT = 3;
  const SETTLE_MS = 2500;

  // The ApiClient methods Hera cannot start without, and the ones only one feature uses.
  const API_REQUIRED = ["getCurrentUserId", "getUrl", "ajax", "getJSON", "getItem", "getScaledImageUrl", "deviceId", "accessToken"];
  const API_OPTIONAL = ["getCurrentUser", "updateUserConfiguration", "updateFavoriteStatus", "updateUserPassword", "uploadUserImage", "deleteUserImage"];

  const health = {
    boot: "starting", // starting | ok | untested | safe
    reason: null,
    jellyfin: null,
    tested: null,
    modules: new Map(), // name -> see moduleHealth
  };
  const moduleHealth = (name) => {
    if (!health.modules.has(name)) {
      health.modules.set(name, {
        status: "idle", // idle | ok | partial | degraded | disabled
        missing: [],
        page: null,
        errors: 0,
        streak: 0, // throws in a row, for the three-strikes switch-off
        lastError: null,
        registered: false,
        live: false, // active last time refresh looked: a change to active delivers the current route to the module
        aside: false, // standing aside on the page showing now: its stylesheet and interceptors go quiet
        runs: 0,
        lastPage: null,
        ranOn: new Set(),
        byPage: new Map(), // page id -> what was missing there, until a later pass on it finds it all
        soft: new Set(), // kit.jf lookups that found nothing since the last pass
        failures: 0, // throws and tracked rejections since the last pass
        self: null, // what the module said about itself through kit.report
      });
    }
    return health.modules.get(name);
  };
  const isActive = (name) => {
    const m = health.modules.get(name);
    return !!m?.registered && !m.aside && m.status !== "disabled" && health.boot !== "safe";
  };
  const moduleEntry = (name, m) => ({ name, status: m.status, missing: m.missing, page: m.page, errors: m.errors, lastError: m.lastError });
  /** Everything known, idle modules too (`HeraTV.health()`); what goes to the server leaves the idle ones out. */
  const healthSnapshot = () => ({
    boot: health.boot,
    reason: health.reason,
    jellyfin: health.jellyfin,
    tested: health.tested,
    modules: [...health.modules].map(([name, m]) => ({ ...moduleEntry(name, m), runs: m.runs, lastPage: m.lastPage, ranOn: [...m.ranOn] })),
  });
  const currentPageId = () => document.querySelector(JF.page)?.id || null;

  // A module's published status is the worst thing still true of it: a piece missing on a page it
  // hasn't since run cleanly on, a throw, a lookup that found nothing, or what it said itself.
  const refresh = (name) => {
    const m = moduleHealth(name);
    if (m.status !== "disabled") {
      const stuck = m.byPage.entries().next().value;
      if (stuck || m.self?.status === "degraded") {
        const [page, missing] = stuck ?? [m.self.page, m.self.missing];
        Object.assign(m, { status: "degraded", page, missing: [...missing] });
      } else if (m.self?.status === "partial" || m.soft.size || m.failures) {
        Object.assign(m, { status: "partial", page: m.self?.page ?? m.lastPage ?? currentPageId(), missing: [...new Set([...(m.self?.missing ?? []), ...m.soft])] });
      } else if (m.runs || m.self?.status === "ok") {
        Object.assign(m, { status: "ok", page: null, missing: [] });
      } else {
        Object.assign(m, { status: "idle", page: null, missing: [] });
      }
    }
    const active = isActive(name);
    root.classList.toggle("hera-m-" + name, active);
    syncIntercepts(name);
    // A module that comes back from standing aside missed the route it stood aside on: it gets it now.
    if (active !== m.live) {
      m.live = active;
      if (active) deliverCurrent(name);
    }
    reportHealth();
  };

  // A change worth telling the server about is sent once, a moment later, with everything else that
  // changed meanwhile. The first full pass of a session is always sent: it is the browser checking
  // in, even when everything is well, and a later healthy report replaces this browser's own
  // earlier problem on the server (the server keys entries by module and reporter).
  let reportTimer = 0;
  let reported = "";
  const reporterId = () => {
    try {
      return String(api()?.deviceId?.() || localStorage.getItem(JF_STORAGE.deviceId.key) || "unknown");
    } catch {
      return "unknown";
    }
  };
  const reportBody = () => {
    const snapshot = healthSnapshot();
    return {
      reporter: reporterId(),
      boot: snapshot.boot,
      reason: snapshot.reason,
      jellyfin: snapshot.jellyfin,
      tested: snapshot.tested,
      page: root.dataset.heraView || null,
      // Only modules that ran or reported: an idle one says nothing about this Jellyfin.
      modules: snapshot.modules.filter((m) => m.status !== "idle").map(({ name, status, missing, page, errors, lastError }) => ({ name, status, missing, page, errors, lastError })),
    };
  };
  function reportHealth() {
    clearTimeout(reportTimer);
    reportTimer = setTimeout(() => {
      if (!api() || !userId() || health.boot === "starting" || health.boot === "safe") return;
      const body = reportBody();
      const key = JSON.stringify([body.boot, body.modules.map((m) => [m.name, m.status, m.missing])]);
      if (key === reported) return;
      reported = key;
      hera("health", { method: "POST", body }).catch(() => {
        if (reported === key) reported = "";
      });
    }, 3000);
  }

  // Counts a failure of async work (a fetch behind a row, a card's Play) against the module, which
  // then reports partial until its next clean pass. It never counts towards the three strikes.
  const noteFailure = (name, error) => {
    const m = moduleHealth(name);
    m.errors += 1;
    m.failures += 1;
    m.lastError = formatError(error);
    console.error("[Hera TV:" + name + "]", error);
    refresh(name);
  };
  /** Watches a promise for `name`: resolves to its value, or to undefined after counting its failure. Never rejects. */
  const track = (name, promise) =>
    Promise.resolve(promise).catch((error) => {
      noteFailure(name, error);
    });

  const noteMiss = (name, key) => {
    const m = moduleHealth(name);
    if (m.soft.has(key)) return;
    m.soft.add(key);
    console.warn("[Hera TV:" + name + "] Jellyfin has no " + (JF[key] ?? key) + " where it was expected");
    refresh(name);
  };
  // The one way for a module to look at Jellyfin's markup. Page-scoped keys are looked for inside
  // the page showing (a hidden, cached page never satisfies one) unless a root is given.
  const jfLookup = (module, key, from, all) => {
    const selector = JF[key];
    const meta = JF_META[key];
    let found;
    if (!selector) {
      found = all ? [] : null;
    } else if ((!from || from === document) && meta.scope === "page") {
      const base = document.querySelector(JF.page) ?? document;
      const self = base !== document && base.matches(selector) ? base : null;
      found = all ? (self ? [self] : []).concat([...base.querySelectorAll(selector)]) : (self ?? base.querySelector(selector));
    } else {
      const scopeRoot = from ?? document;
      found = all ? [...scopeRoot.querySelectorAll(selector)] : scopeRoot.querySelector(selector);
    }
    if ((all ? !found.length : !found) && (meta?.required ?? true)) noteMiss(module, key);
    return found;
  };
  const jfFirst = (module, key, from) => jfLookup(module, key, from, false);
  const jfAll = (module, key, from) => jfLookup(module, key, from, true);

  /** For a module with no onView (or one that knows better than a pass does): says how it is getting on. */
  const report = (name, status, detail) => {
    if (!["ok", "partial", "degraded", "idle"].includes(status)) return;
    const m = moduleHealth(name);
    const given = typeof detail === "string" ? { error: detail } : (detail ?? {});
    m.self = { status, missing: given.missing ?? [], page: given.page ?? currentPageId() };
    if (given.error) m.lastError = String(given.error).slice(0, 300);
    m.aside = status === "degraded";
    refresh(name);
  };

  // Capture-phase listeners that must stand down when their module does: attached while it is
  // running, detached while it is standing aside or switched off, and gone for good with its
  // unsubscribe.
  const intercepts = new Set();
  const attach = (entry, on) => {
    if (on === entry.attached) return;
    entry.attached = on;
    if (on) entry.target.addEventListener(entry.type, entry.handler, entry.options);
    else entry.target.removeEventListener(entry.type, entry.handler, entry.options);
  };
  function syncIntercepts(name) {
    const on = isActive(name);
    for (const entry of intercepts) if (entry.module === name) attach(entry, on);
  }
  const intercept = (module, target, type, handler, options = {}) => {
    const entry = { module, target, type, handler, options: { ...options, capture: true }, attached: false };
    intercepts.add(entry);
    attach(entry, isActive(module));
    return () => {
      attach(entry, false);
      intercepts.delete(entry);
    };
  };

  const missingOn = (page, keys) => keys.filter((key) => !(JF[key] && (JF_META[key].scope === "page" ? page : document).querySelector(JF[key])));

  // Jellyfin draws a page in pieces; a piece counts as missing only once the page has had a
  // moment to settle and it still isn't there.
  const waitForPieces = (page, keys) =>
    new Promise((resolve) => {
      if (!keys.length || !missingOn(page, keys).length) return resolve([]);
      const observer = new MutationObserver(() => {
        if (missingOn(page, keys).length) return;
        finish();
      });
      const timer = setTimeout(() => finish(), SETTLE_MS);
      const finish = () => {
        observer.disconnect();
        clearTimeout(timer);
        resolve(missingOn(page, keys));
      };
      observer.observe(page, { childList: true, subtree: true });
    });

  const requiresFor = (module, page) => [...(module.requires?.[page.id] ?? []), ...(module.requires?.["*"] ?? [])];

  /**
   * Runs one module on a page: probes what it needs first, and keeps count of what it throws.
   * `settled` carries what one showing of a page has already waited for and not found, so the
   * modules after the first don't each wait again for the same missing piece. Returns false when
   * the page went away while it waited (`stale`), so the caller stops there. A module with no
   * onView isn't run: it reports through kit.report.
   */
  const runModule = async (module, page, context, settled = new Set(), stale = () => false) => {
    if (!module.onView) return true;
    const m = moduleHealth(module.name);
    if (m.status === "disabled") return true;
    const keys = requiresFor(module, page);
    const known = keys.filter((key) => settled.has(key));
    const missing = known.length ? [...known, ...missingOn(page, keys.filter((key) => !settled.has(key)))] : await waitForPieces(page, keys);
    if (stale()) return false;
    missing.forEach((key) => settled.add(key));
    if (missing.length) {
      if (m.byPage.get(page.id)?.join() !== missing.join()) {
        console.warn("[Hera TV:" + module.name + "] standing aside on " + page.id + ": Jellyfin has no " + missing.map((key) => JF[key]).join(", "));
      }
      m.byPage.set(page.id, missing);
      m.aside = true;
      refresh(module.name);
      return true;
    }
    m.byPage.delete(page.id);
    m.aside = false;
    m.soft.clear();
    m.failures = 0;
    m.self = null;
    try {
      await module.onView(page, context);
      m.runs += 1;
      m.lastPage = page.id;
      m.ranOn.add(page.id);
      m.streak = 0;
      m.aside = m.self?.status === "degraded";
    } catch (error) {
      console.error("[Hera TV:" + module.name + "]", error);
      m.errors += 1;
      m.failures += 1;
      m.streak += 1;
      m.lastError = formatError(error);
      if (m.streak >= ERROR_LIMIT) {
        console.warn("[Hera TV:" + module.name + "] switched off for this session after " + ERROR_LIMIT + " failures in a row");
        m.status = "disabled";
        stopModule(module);
      }
    }
    refresh(module.name);
    return true;
  };

  /** Takes Hera off this tab entirely: its stylesheets, its classes, its modules. */
  const safeMode = (reason) => {
    if (health.boot === "safe") return;
    health.boot = "safe";
    health.reason = reason;
    console.warn("[Hera TV:core] off for this tab: " + reason);
    document.querySelectorAll("link[data-hera-tv], style[data-hera-tv]").forEach((node) => node.remove());
    window.HeraTV?.teardown();
    reportSafe();
  };

  // Safe mode usually means the ApiClient can't be trusted to report through, so this goes to the
  // server directly, signed with the token Jellyfin keeps for the signed-in user.
  const reportSafe = () => {
    try {
      const credentials = JSON.parse(localStorage.getItem(JF_STORAGE.credentials.key) || "{}");
      const token = credentials.Servers?.find((server) => server.AccessToken)?.AccessToken;
      if (!token) return;
      fetch(new URL("../HeraTV/health", document.baseURI), {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `MediaBrowser Token="${token}"` },
        body: JSON.stringify(reportBody()),
      }).catch(() => {});
    } catch {
      /* nothing to report with */
    }
  };

  // Which Jellyfin releases this build was tested against, and which one this server runs.
  const checkVersion = async () => {
    try {
      const response = await fetch(new URL("../HeraTV/compat", document.baseURI));
      if (!response.ok) return;
      const compat = await response.json();
      health.jellyfin = compat.jellyfin ?? null;
      health.tested = compat.tested ?? null;
      if (health.boot === "starting" || health.boot === "ok") health.boot = compat.supported === false ? "untested" : "ok";
      if (health.boot === "untested") {
        console.warn(`[Hera TV:core] Jellyfin ${health.jellyfin} is newer than the releases this build was tested on (${(health.tested || []).join(", ")})`);
      }
      reportHealth();
    } catch {
      /* the server answers this for every page; without it, carry on */
    }
  };

  // ---------- stylesheet order ---------------------------------------------------------
  // Jellyfin appends its theme and plugin styles after ours at runtime; keep ours last so
  // equal-specificity rules resolve in our favour without !important everywhere.

  const keepStylesheetLast = () => {
    const links = () => [...document.querySelectorAll('link[data-hera-tv][rel="stylesheet"]')];
    if (!links().length) return;
    let queued = false;
    const move = () => {
      queued = false;
      const custom = document.querySelector(JF.branding);
      const anchor = custom && custom.parentNode === document.head ? custom : null;
      const ours = links();
      const last = ours[ours.length - 1];
      // Already in place: ours are contiguous, in order, and last (or just before branding).
      const inPlace = anchor ? last.nextElementSibling === anchor : document.head.lastElementChild === last;
      if (inPlace && ours.every((link, i) => i === 0 || ours[i - 1].nextElementSibling === link)) return;
      for (const link of ours) {
        if (anchor) document.head.insertBefore(link, anchor);
        else document.head.append(link);
      }
    };
    const observer = new MutationObserver(() => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(move);
      }
    });
    observer.observe(document.head, { childList: true });
    move();
    state.cleanups.push(() => observer.disconnect());
  };

  // ---------- home hero ----------------------------------------------------------------

  // Titles are per profile: a different signed-in user never sees the last one's list.
  const loadHeroItems = async () => {
    const user = userId();
    const fresh = state.heroUser === user && Date.now() - state.heroFetchedAt < 10 * 60 * 1000;
    if (state.heroItems && fresh) return state.heroItems;
    const result = await getJSON(`Users/${user}/Items`, {
      IncludeItemTypes: "Movie,Series",
      Recursive: true,
      ImageTypes: "Backdrop,Logo",
      IsPlayed: false,
      SortBy: "DateCreated",
      SortOrder: "Descending",
      Limit: 40,
      Fields: "Overview,Genres,OfficialRating,CommunityRating,RunTimeTicks,ProductionYear,ChildCount,BackdropImageTags,ImageTags,UserData",
    });
    // ImageTypes matches items with any of the types; the hero needs the backdrop.
    const items = (result?.Items ?? []).filter((item) => item.BackdropImageTags?.length);
    state.heroItems = shuffle(items).slice(0, state.config.heroItemCount);
    state.heroUser = user;
    state.heroFetchedAt = Date.now();
    return state.heroItems;
  };

  // No slide's art loads with the page: the hero hands the slide showing and the next one their
  // src once it is first on screen (Hero.reveal), and each further slide as it comes up next. Lazy
  // loading can't defer them, as the slides are stacked in the viewport; and a page opened straight
  // on Discover keeps the hero hidden, so its art waits until Home is shown.
  const heroSlide = (item, index, total) => {
    const isSeries = item.Type === "Series";
    const resumable = !isSeries && item.UserData?.PlaybackPositionTicks > 0;
    const dpr = window.devicePixelRatio || 1;
    const backdrop = imageUrl(item.Id, "Backdrop", {
      maxWidth: Math.min(2560, Math.round(window.innerWidth * dpr)),
      tag: item.BackdropImageTags?.[0],
    });
    // Sized to the logo's tallest box (.hera-hero__logo max-height), not a guessed width.
    const logoSrc = item.ImageTags?.Logo ? imageUrl(item.Id, "Logo", { maxHeight: Math.round(170 * dpr), tag: item.ImageTags.Logo }) : null;
    const logo = logoSrc
      ? el("img", { class: "hera-hero__logo", alt: item.Name, "data-src": logoSrc, decoding: "async" })
      : el("h2", { class: "hera-hero__title", text: item.Name });

    const meta = el("p", { class: "hera-hero__meta" }, [
      el("span", { text: isSeries ? "TV Show" : "Film" }),
      item.Genres?.length ? el("span", { text: item.Genres.slice(0, 2).join(", ") }) : null,
      item.ProductionYear ? el("span", { text: String(item.ProductionYear) }) : null,
      isSeries
        ? item.ChildCount
          ? el("span", { text: `${item.ChildCount} ${item.ChildCount === 1 ? "Season" : "Seasons"}` })
          : null
        : runtime(item.RunTimeTicks)
          ? el("span", { text: runtime(item.RunTimeTicks) })
          : null,
      item.OfficialRating ? el("span", { class: "hera-badge", text: certificate(item.OfficialRating) }) : null,
    ]);

    const favourite = item.UserData?.IsFavorite ?? false;
    const favButton = el(
      "button",
      {
        type: "button",
        class: "hera-btn hera-btn--glass",
        "aria-pressed": String(favourite),
        "aria-label": favourite ? "Remove from Favourites" : "Add to Favourites",
        title: "Favourites",
      },
      icon(favourite ? "favorite" : "favorite_border"),
    );
    favButton.addEventListener("click", () => track("hero", toggleFavourite(item, favButton)));

    return el(
      "article",
      {
        class: "hera-hero__slide",
        "aria-roledescription": "slide",
        "aria-label": `${index + 1} of ${total}: ${item.Name}`,
        "data-index": index,
      },
      [
        el("img", { class: "hera-hero__backdrop", "data-src": backdrop, alt: "", decoding: "async" }),
        el("div", { class: "hera-hero__content" }, [
          logo,
          meta,
          item.Overview ? el("p", { class: "hera-hero__overview", text: item.Overview }) : null,
          el("div", { class: "hera-hero__actions" }, [
            el(
              "button",
              {
                type: "button",
                class: "hera-btn hera-btn--primary",
                onclick: () => track("hero", play(item)),
              },
              [icon("play_arrow"), el("span", { text: resumable ? "Resume" : "Play" })],
            ),
            el(
              "button",
              {
                type: "button",
                class: "hera-btn hera-btn--glass",
                "aria-label": `More about ${item.Name}`,
                title: "Details",
                onclick: () => go(`#/details?id=${item.Id}`),
              },
              icon("info_outline"),
            ),
            favButton,
          ]),
        ]),
      ],
    );
  };

  // The ambient ground: the current title's art, blurred and dimmed, fixed behind the page (see
  // .hera-ambient in hera-tv.css). The home hero and every detail page feed it, so the rows under
  // a hero and the credits under a banner sit in the same light on every kind of page. Two layers
  // crossfade so a change of title never flashes the ground.
  const ambient = {
    node: null,
    show(src) {
      if (!src) return;
      if (!this.node?.isConnected) {
        this.node = el("div", { class: "hera-ambient", "aria-hidden": "true" }, [
          el("div", { class: "hera-ambient__layer" }),
          el("div", { class: "hera-ambient__layer" }),
        ]);
        document.body.prepend(this.node);
      }
      const [a, b] = this.node.children;
      const shown = a.classList.contains("is-on") ? a : b.classList.contains("is-on") ? b : null;
      if (shown?.dataset.src === src) return;
      const incoming = shown === a ? b : a;
      incoming.dataset.src = src;
      incoming.style.backgroundImage = `url("${src.replace(/"/g, "%22")}")`;
      incoming.classList.add("is-on");
      shown?.classList.remove("is-on");
    },
    hide() {
      this.node?.querySelectorAll(".hera-ambient__layer.is-on").forEach((layer) => layer.classList.remove("is-on"));
    },
    remove() {
      this.node?.remove();
      this.node = null;
    },
  };

  // Wakes a slide's deferred art (heroSlide). Returns the backdrop.
  const wakeSlide = (slide) => {
    for (const img of slide?.querySelectorAll("img[data-src]:not([src])") ?? []) img.src = img.dataset.src;
    return slide?.querySelector(".hera-hero__backdrop");
  };

  // The timer is the selected dot's fill (a CSS animation, hera-tv.css .hera-hero__dot): its
  // animationend advances the slide, and holding the carousel pauses it. Nothing runs per frame.
  class Hero {
    constructor(items) {
      this.items = items;
      this.index = 0;
      this.userPaused = false;
      this.holds = new Set();
      this.interval = state.config.heroIntervalSeconds * 1000;
      this.build();
    }

    hold(reason, on) {
      if (on) this.holds.add(reason);
      else this.holds.delete(reason);
      this.node.classList.toggle("is-held", this.userPaused || this.holds.size > 0);
    }

    build() {
      const total = this.items.length;
      this.slides = this.items.map((item, i) => heroSlide(item, i, total));
      this.dots = this.items.map((item, i) =>
        el("button", {
          type: "button",
          role: "tab",
          tabindex: "-1",
          class: "hera-hero__dot",
          "aria-label": item.Name,
          "aria-selected": "false",
          onclick: () => this.show(i, true),
        }),
      );
      this.toggle = el(
        "button",
        {
          type: "button",
          class: "hera-btn hera-btn--glass hera-hero__toggle",
          "aria-label": "Pause featured titles",
          onclick: () => this.setUserPaused(!this.userPaused),
        },
        icon("pause"),
      );
      this.node = el(
        "section",
        { class: "hera-hero", "aria-roledescription": "carousel", "aria-label": "Featured" },
        [
          el("div", { class: "hera-hero__slides", "aria-live": "off" }, this.slides),
          total > 1
            ? el("div", { class: "hera-hero__controls" }, [
                el(
                  "button",
                  {
                    type: "button",
                    class: "hera-hero__paddle",
                    // Pointer affordance: keyboards and remotes step with the pager's arrow keys.
                    tabindex: "-1",
                    "aria-label": "Previous title",
                    onclick: () => this.show(this.index - 1, true),
                  },
                  icon("chevron_left"),
                ),
                el("div", { class: "hera-hero__pager focuscontainer-x", role: "tablist", "aria-label": "Featured titles" }, this.dots),
                el(
                  "button",
                  {
                    type: "button",
                    class: "hera-hero__paddle",
                    tabindex: "-1",
                    "aria-label": "Next title",
                    onclick: () => this.show(this.index + 1, true),
                  },
                  icon("chevron_right"),
                ),
                this.toggle,
              ])
            : null,
        ],
      );

      this.node.style.setProperty("--hera-hero-interval", `${this.interval}ms`);
      this.node.addEventListener("pointerenter", () => this.hold("hover", true));
      this.node.addEventListener("pointerleave", () => this.hold("hover", false));
      // On a TV the remote rests on Play, so only focus on the pager holds the timer there.
      this.node.addEventListener("focusin", (e) => {
        this.hold("focus", !root.classList.contains("layout-tv") || !!e.target.closest(".hera-hero__controls"));
      });
      this.node.addEventListener("focusout", (e) => {
        if (!this.node.contains(e.relatedTarget)) this.hold("focus", false);
      });
      this.node.addEventListener("animationend", (e) => {
        if (e.animationName === "hera-hero-progress" && e.target === this.dots[this.index]) this.show(this.index + 1, false);
      });
      this.node.addEventListener("keydown", (e) => {
        if ((e.key === "ArrowRight" || e.key === "ArrowLeft") && e.target.closest(".hera-hero__pager")) {
          e.preventDefault();
          e.stopPropagation();
          // Left past the first title returns to the buttons rather than wrapping around.
          if (e.key === "ArrowLeft" && this.index === 0) {
            this.node.querySelector(".hera-hero__slide.is-active .hera-hero__actions")?.lastElementChild?.focus();
          } else {
            this.show(this.index + (e.key === "ArrowRight" ? 1 : -1), true);
          }
        }
        // Right from the last action reaches the pager: the two sit far apart on one row,
        // which Jellyfin's spatial navigation skips.
        const actions = e.target.closest(".hera-hero__actions");
        if (e.key === "ArrowRight" && actions && e.target === actions.lastElementChild) {
          e.preventDefault();
          e.stopPropagation();
          this.dots[this.index]?.focus();
        }
        // Down leaves the hero for the first shelf, as on tvOS; Jellyfin's spatial navigation
        // otherwise stays among the stacked slides.
        if (e.key === "ArrowDown") {
          const page = this.node.closest(JF.pageRoot);
          // A comma list, not :is(): older webOS Chromium lacks :is, and querySelector returns the
          // first match in document order either way.
          const card = page?.querySelector(`${JF.homeSection} ${JF.card}, ${JF.homeSection} .hera-card`);
          if (card) {
            e.preventDefault();
            e.stopPropagation();
            card.focus();
            card.scrollIntoView({ block: "center", behavior: reduceMotion.matches ? "auto" : "smooth" });
          }
        }
      });
      // Up from the first shelf returns to the hero's Play button.
      this.onKeyUp = (e) => {
        if (e.key !== "ArrowUp" || !this.node.isConnected) return;
        const section = e.target.closest?.(JF.homeSection);
        const first = this.node.closest(JF.pageRoot)?.querySelector(JF.homeSection);
        if (!section || section !== first) return;
        e.preventDefault();
        e.stopPropagation();
        this.node.querySelector(".hera-hero__slide.is-active .hera-btn--primary")?.focus();
        window.scrollTo({ top: 0, behavior: reduceMotion.matches ? "auto" : "smooth" });
      };
      document.addEventListener("keydown", this.onKeyUp, true);
      this.visibility = new IntersectionObserver(([entry]) => {
        if (entry.isIntersecting) this.reveal();
        this.hold("offscreen", !(entry.isIntersecting && entry.intersectionRatio > 0.4));
      }, { threshold: [0, 0.4, 1] });
      this.visibility.observe(this.node);
      this.onVisibility = () => this.hold("hidden", document.hidden);
      document.addEventListener("visibilitychange", this.onVisibility);

      // The first slide shows when the hero is first on screen (reveal), fading in once its art
      // has decoded; `ready` settles then, so the TV layout's focus lands on a drawn Play.
      this.ready = new Promise((resolve) => (this.onReveal = resolve));
      this.setUserPaused(reduceMotion.matches);
    }

    setUserPaused(paused) {
      this.userPaused = paused;
      this.toggle.setAttribute("aria-label", paused ? "Play featured titles" : "Pause featured titles");
      this.toggle.querySelector(".hera-icon").textContent = paused ? "play_arrow" : "pause";
      this.hold("user", paused);
    }

    // The first time the hero is on screen: the slide showing and the next one get their art, and
    // the slide fades in as show() would for any other.
    reveal() {
      if (this.seen) return;
      this.seen = true;
      this.onReveal(this.show(this.index, false));
    }

    async show(index, fromUser, immediate = false) {
      const total = this.slides.length;
      const target = (index + total) % total;
      const token = (this.token = (this.token || 0) + 1);
      // Crossfade only to a decoded backdrop, so the fade never reveals a half-drawn image.
      const img = this.seen ? wakeSlide(this.slides[target]) : null;
      if (!immediate && img && !img.complete) {
        await Promise.race([img.decode().catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
        if (token !== this.token) return;
      }
      // A remote rests on Play. The slide it sits on goes inert when the next takes over, which
      // would drop focus to the page; carry it to the same control on the new slide.
      const held = document.activeElement;
      const heldSlide = held && this.slides.find((slide) => slide.contains(held));
      const heldAt = heldSlide ? [...heldSlide.querySelectorAll(".hera-hero__actions > *")].indexOf(held) : -1;
      this.index = target;
      this.slides.forEach((slide, i) => {
        const active = i === this.index;
        slide.classList.toggle("is-active", active);
        slide.toggleAttribute("inert", !active);
      });
      this.dots.forEach((dot, i) => {
        dot.setAttribute("aria-selected", String(i === this.index));
        // One Tab stop for the pager; the arrow keys step through it.
        dot.tabIndex = i === this.index ? 0 : -1;
      });
      // Clicking the selected dot restarts its fill: deselect it for one style pass first.
      const dot = this.dots[this.index];
      if (dot) {
        dot.setAttribute("aria-selected", "false");
        void dot.offsetWidth;
        dot.setAttribute("aria-selected", "true");
      }
      if (fromUser && document.activeElement?.classList.contains("hera-hero__dot")) {
        this.dots[this.index].focus();
      }
      if (heldSlide && heldSlide !== this.slides[this.index] && heldAt >= 0) {
        this.slides[this.index].querySelectorAll(".hera-hero__actions > *")[heldAt]?.focus({ preventScroll: true });
      }
      if (this.seen) wakeSlide(this.slides[(this.index + 1) % total]);
      this.paintAmbient();
    }

    paintAmbient() {
      const img = this.slides[this.index]?.querySelector(".hera-hero__backdrop");
      ambient.show(img?.currentSrc || img?.src);
    }

    destroy() {
      this.guard?.disconnect();
      this.visibility.disconnect();
      document.removeEventListener("visibilitychange", this.onVisibility);
      document.removeEventListener("keydown", this.onKeyUp, true);
      this.node.remove();
    }
  }

  // Favourites is a second tab of the same page: the hero's dark header and the hidden page backdrop
  // belong to the home tab alone, so the class follows which tab is showing.
  const heroTabObserver = { observer: null };
  const watchHomeTab = (tab) => {
    heroTabObserver.observer?.disconnect();
    const sync = () => setView({ home: tab.classList.contains("is-active") });
    heroTabObserver.observer = new MutationObserver(sync);
    heroTabObserver.observer.observe(tab, { attributes: true, attributeFilter: ["class"] });
    sync();
  };

  const mountHero = async (page) => {
    const tab = page.querySelector(JF.homeTab);
    const sections = jfFirst("hero", "homeSections", page);
    if (!tab || !sections) return;
    watchHomeTab(tab);
    if (state.hero && state.heroUser !== userId()) {
      state.hero.destroy();
      state.hero = null;
    }
    if (state.hero && tab.contains(state.hero.node)) return;
    // viewshow and the hashchange fallback both land here; one fetch serves both.
    state.heroLoad ??= loadHeroItems().finally(() => {
      state.heroLoad = null;
    });
    const items = await state.heroLoad;
    if (state.hero && tab.contains(state.hero.node)) return;
    if (!items.length || !page.isConnected || page.classList.contains("hide")) {
      setView({ home: false });
      return;
    }
    state.hero?.destroy();
    const hero = (state.hero = new Hero(items));
    tab.insertBefore(hero.node, tab.firstChild);
    // Jellyfin redraws the home tab when it comes back to it, which can sweep the hero out of
    // the tab after it was mounted; put it back at the top.
    hero.guard = new MutationObserver(() => {
      if (hero.node.parentNode === tab || !tab.isConnected || page.classList.contains("hide")) return;
      tab.insertBefore(hero.node, tab.firstChild);
    });
    hero.guard.observe(tab, { childList: true });
    // On a TV the remote starts on Play, as tvOS starts on the hero's primary action.
    if (root.classList.contains("layout-tv") && window.scrollY < 80) {
      const focusPlay = () => state.hero?.node.querySelector(".hera-hero__slide.is-active .hera-btn--primary")?.focus();
      hero.ready.then(focusPlay);
      // Jellyfin's own autofocus can run after us and leave focus on the body.
      setTimeout(() => {
        if (document.activeElement === document.body) focusPlay();
      }, 500);
    }
  };

  // ---------- series seasons ------------------------------------------------------------

  // One wide card for every shelf of stills: a show's episodes, a collection's films, and (from
  // hera-seerr.js) the films a collection is missing. The centred disc is the card's action: Play
  // for what the library holds, Request for what it doesn't. A card without a page to open is a
  // button that runs that action; its disc is then only a picture of it.
  const shelfCard = ({ href = null, image = null, logo = null, numbered = false, number = null, name, overview, meta, progress = 0, played = false, action, className = "", label = null }) => {
    // A picture of the action, as on the poster cards (see `card`).
    const disc = el("span", { class: "hera-btn hera-btn--glass hera-episode__play", "aria-hidden": "true" }, icon(action.icon));
    if (href) {
      disc.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        action.run(e);
      });
    }
    const card = el(
      href ? "a" : "button",
      {
        class: ["hera-episode", played ? "is-played" : "", className].filter(Boolean).join(" "),
        href,
        type: href ? null : "button",
        "aria-label": label,
      },
      [
        el("span", { class: logo ? "hera-episode__still has-logo" : "hera-episode__still" }, [
          image ? el("img", { src: image, alt: "", loading: "lazy", decoding: "async" }) : null,
          logo ? el("img", { class: "hera-episode__logo", src: logo, alt: "", loading: "lazy", decoding: "async" }) : null,
          progress && !played ? el("span", { class: "hera-episode__progress" }, el("span", { style: `width:${Math.max(3, progress)}%` })) : null,
          disc,
        ]),
        el("span", { class: "hera-episode__name" }, [
          // A numbered shelf counts its cards in CSS, so a card added in its place renumbers the rest.
          numbered ? el("b", { class: "hera-episode__number" }) : number != null ? el("b", { text: String(number) }) : null,
          document.createTextNode(name),
        ]),
        overview ? el("span", { class: "hera-episode__overview", text: overview }) : null,
        meta ? el("span", { class: "hera-episode__meta", text: meta }) : null,
      ],
    );
    if (!href) card.addEventListener("click", (e) => action.run(e));
    return card;
  };

  const episodeCard = (episode) =>
    shelfCard({
      href: `#/details?id=${episode.Id}`,
      image: episode.ImageTags?.Primary ? imageUrl(episode.Id, "Primary", { maxWidth: 640, tag: episode.ImageTags.Primary }) : null,
      number: episode.IndexNumber,
      name: episode.Name,
      overview: episode.Overview,
      meta: [runtime(episode.RunTimeTicks), episode.PremiereDate ? new Date(episode.PremiereDate).getFullYear() : null].filter(Boolean).join(" · "),
      progress: episode.UserData?.PlayedPercentage,
      played: episode.UserData?.Played,
      action: { icon: "play_arrow", label: `Play ${episode.Name}`, run: () => track("seasons", play(episode)) },
    });

  // Moving between episodes of a show opens a new detail page each time (Jellyfin keeps a few in
  // its view cache, which is why some came back instantly and others redrew from nothing). What
  // a page needs from the show (its series, the series list, each series' episodes, the banner
  // art) is kept here for a minute, so a new page paints the banner and the Episodes shelf in its
  // first frame instead of after three round trips. itemHints answers "what is this id?" for
  // anything the shelf has already shown, so even the first item lookup is skipped.
  const SHOW_TTL = 60 * 1000;
  const showCache = new Map(); // seriesId -> { at, seasons, nextUp, episodes: Map(seasonId -> promise) }
  const itemHints = new Map(); // itemId -> { Id, Type, SeriesId, SeasonId }
  const artCache = new Map(); // itemId or seriesId -> { banner, ambient }
  let shelfNavigation = null; // { seriesId, y, left, at } while moving between episodes from the shelf
  const showData = (seriesId) => {
    let entry = showCache.get(seriesId);
    if (!entry || Date.now() - entry.at > SHOW_TTL || entry.user !== userId()) {
      const failed = () => showCache.delete(seriesId);
      entry = {
        at: Date.now(),
        user: userId(),
        seasons: getJSON(`Shows/${seriesId}/Seasons`, { userId: userId() }).catch((error) => (failed(), Promise.reject(error))),
        nextUp: getJSON("Shows/NextUp", { seriesId, userId: userId(), limit: 1 }).catch(() => null),
        episodes: new Map(),
      };
      showCache.set(seriesId, entry);
    }
    return entry;
  };
  // After moving between episodes from the shelf, put the reader back where they were: same shelf
  // position, same scroll. Runs for a freshly drawn page (from the shelf's first paint) and for
  // one Jellyfin brings back from its view cache (from onView). Jellyfin scrolls a shown page to
  // the top a frame later, and the page below the shelf may still be loading (so it can't scroll
  // that far yet), so this keeps trying for a moment, and stops as soon as the reader scrolls.
  const restoreShelfPlace = (page) => {
    const memo = shelfNavigation;
    if (!memo || Date.now() - memo.at > 4000) return false;
    const section = page.querySelector(".hera-seasons");
    const hint = itemHints.get(itemIdFromHash());
    if (!section || hint?.Type !== "Episode" || hint.SeriesId !== memo.seriesId) return false;
    shelfNavigation = null;
    section.querySelector(".hera-shelf")?.scrollTo({ left: memo.left, behavior: "instant" });
    let stopped = false;
    const stop = () => (stopped = true);
    const events = ["wheel", "touchstart", "keydown", "mousedown"];
    events.forEach((type) => window.addEventListener(type, stop, { once: true, passive: true }));
    const until = Date.now() + 1500;
    const land = () => {
      if (stopped || Date.now() > until) {
        events.forEach((type) => window.removeEventListener(type, stop));
        return;
      }
      if (Math.abs(window.scrollY - memo.y) > 2) window.scrollTo({ top: memo.y, behavior: "instant" });
      setTimeout(() => requestAnimationFrame(land), 120);
    };
    requestAnimationFrame(() => requestAnimationFrame(land));
    return true;
  };

  const seasonEpisodes = (seriesId, seasonId) => {
    const entry = showData(seriesId);
    if (!entry.episodes.has(seasonId)) {
      entry.episodes.set(
        seasonId,
        getJSON(`Shows/${seriesId}/Episodes`, { seasonId, userId: userId(), Fields: "Overview,PremiereDate" }).then((result) => {
          for (const episode of result?.Items ?? []) {
            itemHints.set(episode.Id, { Id: episode.Id, Type: "Episode", SeriesId: seriesId, SeasonId: episode.SeasonId ?? seasonId });
          }
          return result;
        }),
      );
    }
    return entry.episodes.get(seasonId);
  };

  // The same Episodes section, in the same place (first after the banner), on a series, a season
  // and an episode page, as the Apple TV app has one episode shelf with series tabs wherever you
  // are in a show. A series opens on the series it's up to; a season on itself; an episode on its
  // own series, scrolled to it and marked as the one you're on. Jellyfin's own lists (a season's
  // vertical list, an episode's "More from Series N" carousel) step aside for it.
  const mountSeasons = async (page, itemId) => {
    const existing = page.querySelector(".hera-seasons");
    if (existing?.dataset.item === itemId) return;
    existing?.remove();
    page.classList.remove("hera-has-seasons");
    const item = itemHints.get(itemId) ?? (await fetchItem(itemId));
    if (!item || !["Series", "Season", "Episode"].includes(item.Type)) return;
    const seriesId = item.Type === "Series" ? item.Id : item.SeriesId;
    if (!seriesId) return;
    itemHints.set(itemId, { Id: item.Id, Type: item.Type, SeriesId: seriesId, SeasonId: item.SeasonId });
    const show = showData(seriesId);
    const [seasonsResult, nextUp] = await Promise.all([show.seasons, show.nextUp]);
    const seasons = seasonsResult?.Items ?? [];
    for (const season of seasons) itemHints.set(season.Id, { Id: season.Id, Type: "Season", SeriesId: seriesId });
    if (!seasons.length || page.querySelector(".hera-seasons") || itemIdFromHash() !== itemId) return;

    const nextEpisode = nextUp?.Items?.[0];
    const openSeasonId = item.Type === "Season" ? item.Id : item.Type === "Episode" ? item.SeasonId : nextEpisode?.SeasonId;
    const focusEpisodeId = item.Type === "Episode" ? item.Id : nextEpisode?.Id;
    // The banner's Play names the episode it starts, as Apple TV's does.
    if (item.Type === "Series" && nextEpisode?.IndexNumber != null) {
      const verb = nextEpisode.UserData?.PlaybackPositionTicks > 0 ? "Resume" : "Play";
      labelPlay(page, itemId, `${verb} S${nextEpisode.ParentIndexNumber ?? 1}, E${nextEpisode.IndexNumber}`);
      page.heraPlayTarget = { id: itemId, item: nextEpisode };
      installPlayOverride(page);
    }
    const startIndex = Math.max(0, seasons.findIndex((s) => s.Id === openSeasonId));
    const shelf = el("div", { class: "hera-shelf", role: "tabpanel" });
    // Picking another episode from the shelf is browsing, not leaving: the new page opens where
    // the old one was (same scroll, same shelf position) instead of at the top, every time, rather
    // than only when Jellyfin happened to have the page cached.
    shelf.addEventListener("click", (event) => {
      if (!event.target.closest(".hera-episode") || event.target.closest(".hera-episode__play")) return;
      shelfNavigation = { seriesId, y: window.scrollY, left: shelf.scrollLeft, at: Date.now() };
    });
    const tabs = seasons.map((season, i) =>
      el("button", {
        type: "button",
        role: "tab",
        class: "hera-seasons__tab",
        "aria-selected": "false",
        text: season.Name,
        onclick: () => select(i),
      }),
    );
    // On a TV, Up from an episode reaches the season tabs rather than skipping past them.
    shelf.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowUp" || tabs.length < 2 || !root.classList.contains("layout-tv")) return;
      event.preventDefault();
      event.stopPropagation();
      (tabs.find((tab) => tab.getAttribute("aria-selected") === "true") ?? tabs[0]).focus();
    });

    const select = async (i) => {
      tabs.forEach((tab, j) => tab.setAttribute("aria-selected", String(i === j)));
      shelf.setAttribute("aria-label", seasons[i].Name);
      const result = await seasonEpisodes(seriesId, seasons[i].Id);
      if (tabs[i].getAttribute("aria-selected") !== "true") return;
      shelf.replaceChildren(...(result?.Items ?? []).map(episodeCard));
      const target = focusEpisodeId && shelf.querySelector(`a[href$="${focusEpisodeId}"]`);
      if (target && item.Type === "Episode") {
        target.classList.add("is-current");
        target.setAttribute("aria-current", "page");
      }
      if (restoreShelfPlace(page)) return;
      shelf.scrollTo({ left: target ? target.offsetLeft - shelf.offsetLeft : 0, behavior: "instant" });
    };

    const section = el("section", { class: "hera-seasons verticalSection", "aria-label": "Episodes", "data-item": itemId }, [
      el("div", { class: "hera-seasons__head" }, [
        el("h2", { class: "hera-seasons__title", text: "Episodes" }),
        seasons.length > 1 ? el("div", { class: "hera-seasons__tabs focuscontainer-x", role: "tablist" }, tabs) : null,
      ]),
      shelf,
    ]);

    // Episodes come straight after the hero, before the credits, as tv.apple.com orders a show.
    const primary = jfFirst("seasons", "detailPrimary", page);
    if (!primary) return;
    primary.insertBefore(section, primary.firstChild);
    page.classList.add("hera-has-seasons");
    await select(startIndex);
  };

  // ---------- collections ---------------------------------------------------------------

  // A collection is its films in release order, on the same shelf as a show's episodes (the Apple
  // TV app puts a bundle's films and a season's episodes on the same kind of row): wide stills
  // with the film's logo, numbered, with synopsis and meta. The next film to watch carries the
  // quiet edge, and the banner's Play starts it ("Play Batman Begins", or "Resume …"). Films the
  // library lacks join the shelf in their place from hera-seerr.js, through kit.collectionShelf.
  const boxSets = new WeakMap(); // page -> { itemId, ready: Promise<shelf handle | null> }

  const dateOf = (item) => (item.PremiereDate || (item.ProductionYear ? `${item.ProductionYear}-01-01` : "")).slice(0, 10);

  // In progress first, as Up Next does; else the first one not watched; else the first.
  const nextInOrder = (items) =>
    items.find((item) => item.UserData?.PlaybackPositionTicks > 0 && !item.UserData?.Played) ??
    items.find((item) => !item.UserData?.Played) ??
    items[0];

  const filmCard = (item, { rating = true, numbered = true } = {}) => {
    const backdrop = item.BackdropImageTags?.[0];
    const tags = item.ImageTags ?? {};
    const image = backdrop
      ? imageUrl(item.Id, "Backdrop", { maxWidth: 720, tag: backdrop })
      : tags.Thumb
        ? imageUrl(item.Id, "Thumb", { maxWidth: 720, tag: tags.Thumb })
        : tags.Primary
          ? imageUrl(item.Id, "Primary", { maxWidth: 720, tag: tags.Primary })
          : null;
    const card = shelfCard({
      href: `#/details?id=${item.Id}`,
      image,
      // A thumb usually has the title painted on; the logo goes only over plain key art.
      logo: backdrop && tags.Logo ? imageUrl(item.Id, "Logo", { maxWidth: 360, tag: tags.Logo }) : null,
      numbered,
      name: item.Name,
      overview: item.Overview,
      meta: [item.ProductionYear, runtime(item.RunTimeTicks), rating ? certificate(item.OfficialRating) : null].filter(Boolean).join(" · "),
      progress: item.UserData?.PlayedPercentage,
      played: item.UserData?.Played,
      action: { icon: "play_arrow", label: `Play ${item.Name}`, run: () => track("boxset", play(item)) },
    });
    card.dataset.date = dateOf(item);
    return card;
  };

  // What hera-seerr.js needs to put a missing film on the shelf: the shelf, its head (for the
  // Request button) and a way to place a card by release date. Cards without a date go last.
  // A page keeps one handle: a redraw points it at the new section, so whatever holds the handle
  // (a Request in flight, a Seerr fetch still loading) lands on the shelf that is on screen.
  const boxSetHandle = (section, shelf) => {
    const handle = {
      section,
      shelf,
      head: section.querySelector(".hera-seasons__head"),
      adopt(nextSection, nextShelf) {
        handle.section = nextSection;
        handle.shelf = nextShelf;
        handle.head = nextSection.querySelector(".hera-seasons__head");
      },
      // Up to three films fill the width between them; four or more wrap into a grid.
      refit() {
        const count = handle.shelf.children.length;
        handle.shelf.toggleAttribute("data-few", count < 4);
        handle.shelf.style.setProperty("--hera-few", String(Math.max(2, count)));
      },
      place(card, date) {
        card.dataset.date = date || "";
        const after = date ? [...handle.shelf.children].find((other) => !other.dataset.date || other.dataset.date > date) : null;
        handle.shelf.insertBefore(card, after ?? null);
        handle.refit();
      },
    };
    return handle;
  };

  const fitBoxSetMeta = (page, items, noun, mixedRatings = false) => {
    // Jellyfin's one certificate for the lot would contradict films that carry their own.
    if (mixedRatings) page.querySelector(JF.miscRating)?.remove();
    const parts = [...page.querySelectorAll(JF.miscItems)];
    const count = parts.find((part) => /^\d+ items?$/.test(part.textContent.trim()));
    if (count) count.textContent = `${items.length} ${noun}${items.length === 1 ? "" : "s"}`;
    const years = items.map((item) => item.ProductionYear).filter(Boolean);
    const year = parts.find((part) => /^\d{4}$/.test(part.textContent.trim()));
    if (!year || !years.length) return;
    const first = Math.min(...years);
    const last = Math.max(...years);
    year.textContent = first === last ? String(first) : `${first}–${last}`;
    if (noun !== "film" || year.nextElementSibling?.classList.contains("hera-boxset-runtime")) return;
    const total = runtime(items.reduce((sum, item) => sum + (item.RunTimeTicks || 0), 0));
    if (total) year.after(el("div", { class: "mediaInfoItem hera-boxset-runtime", text: total }));
  };

  // The banner's Play names what it starts ("Play Batman Begins", "Resume S1, E5"), as Apple TV's
  // does. `itemId` is the page the label belongs to, so a page Jellyfin reuses never keeps another's.
  const labelPlay = (page, itemId, label) => {
    const button = page.querySelector(JF.detailPlay);
    const content = button?.querySelector(JF.detailButtonContent);
    if (!content) return;
    if (label) {
      if (content.dataset.heraTitle === undefined) {
        content.dataset.heraTitle = button.title;
        content.dataset.heraAria = button.getAttribute("aria-label") ?? "";
      }
      content.dataset.heraLabel = label;
      content.dataset.heraLabelItem = itemId;
      button.setAttribute("aria-label", label);
      button.title = label;
    } else if (content.dataset.heraTitle !== undefined) {
      button.title = content.dataset.heraTitle;
      if (content.dataset.heraAria) button.setAttribute("aria-label", content.dataset.heraAria);
      else button.removeAttribute("aria-label");
      delete content.dataset.heraLabel;
      delete content.dataset.heraLabelItem;
      delete content.dataset.heraTitle;
      delete content.dataset.heraAria;
    }
  };

  // Jellyfin's Play on a collection plays every film from the first, and on a series its own idea of
  // where to start; Hera's starts the title the label names (`page.heraPlayTarget`).
  const installPlayOverride = (page) => {
    if (page.heraPlayOverride) return;
    page.heraPlayOverride = true;
    page.addEventListener(
      "click",
      (event) => {
        const button = event.target.closest?.(JF.detailPlay);
        const target = page.heraPlayTarget;
        if (!button || !target || target.id !== itemIdFromHash()) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        track("core", play(target.item));
      },
      true,
    );
  };

  const buildBoxSet = async (page, itemId, previous) => {
    const item = await fetchItem(itemId);
    if (item?.Type !== "BoxSet") return null;
    const result = await getJSON(`Users/${userId()}/Items`, {
      ParentId: itemId,
      SortBy: "PremiereDate,ProductionYear,SortName",
      SortOrder: "Ascending",
      Fields: "Overview,PremiereDate,OfficialRating",
    });
    // Jellyfin sorts films without a date first; they belong at the end of the order.
    const all = result?.Items ?? [];
    const items = [...all.filter((child) => dateOf(child)), ...all.filter((child) => !dateOf(child))];
    const drawn = page.querySelector(".hera-boxset");
    if (!items.length || itemIdFromHash() !== itemId || (drawn && drawn.dataset.item !== itemId)) return null;

    // A collection Hera built from a group (On Paramount+, Netflix) is a set of titles, not a franchise:
    // no order, no next film, no Play that names one.
    const grouped = !!item.Tags?.includes("hera-tv");
    const films = items.every((child) => child.Type === "Movie");
    const shows = items.every((child) => child.Type === "Series");
    const title = films ? "Films" : shows ? "TV Shows" : "In This Collection";
    const next = nextInOrder(items);
    // One certificate for the lot is already in the banner's meta; per film only when they differ.
    const rating = new Set(items.map((child) => child.OfficialRating || "")).size > 1;
    const shelf = el("div", { class: "hera-shelf", "aria-label": title });
    for (const child of items) {
      const card = filmCard(child, { rating, numbered: !grouped });
      if (!grouped && child === next) card.classList.add("is-current");
      shelf.append(card);
    }
    const section = el("section", { class: "hera-boxset verticalSection", "aria-label": title, "data-item": itemId }, [
      el("div", { class: "hera-seasons__head" }, el("h2", { class: "hera-seasons__title", text: title })),
      shelf,
    ]);
    const primary = jfFirst("boxset", "detailPrimary", page);
    if (!primary) return null;
    // Coming back to the page redraws the grid in place (watched films, the next one, Play), so
    // nothing jumps; what hera-seerr.js added (missing films, Request) moves across with it, and
    // so does the remote's focus.
    const stale = page.querySelector(".hera-boxset");
    const handle = stale && previous ? previous : boxSetHandle(section, shelf);
    if (stale) {
      const focused = stale.contains(document.activeElement) ? document.activeElement : null;
      const focusedHref = focused?.getAttribute("href");
      handle.adopt(section, shelf);
      for (const card of stale.querySelectorAll('.hera-shelf > [data-hera-seerr="collection"]')) handle.place(card, card.dataset.date);
      for (const node of stale.querySelectorAll('.hera-seasons__head > [data-hera-seerr="collection"]')) handle.head.append(node);
      for (const node of stale.querySelectorAll(':scope > [data-hera-seerr="collection"]')) section.append(node);
      handle.refit();
      stale.replaceWith(section);
      const refocus = focusedHref ? shelf.querySelector(`a[href="${CSS.escape(focusedHref)}"]`) : focused?.isConnected ? focused : null;
      refocus?.focus({ preventScroll: true });
    } else {
      handle.refit();
      primary.insertBefore(section, primary.firstChild);
    }
    page.classList.add("hera-has-boxset");
    fitBoxSetMeta(page, items, films ? "film" : shows ? "TV show" : "title", rating);
    if (grouped) {
      page.heraPlayTarget = null;
      labelPlay(page, itemId, null);
    } else {
      const verb = next.UserData?.PlaybackPositionTicks > 0 && !next.UserData?.Played ? "Resume" : "Play";
      page.heraPlayTarget = { id: itemId, item: next };
      labelPlay(page, itemId, `${verb} ${next.Name}`);
      installPlayOverride(page);
    }
    return handle;
  };

  const mountBoxSet = (page, itemId) => {
    const known = boxSets.get(page);
    // Same collection: reuse what is drawing or was drawn a moment ago (a show of the page runs
    // this twice); otherwise draw again, in place, so a page Jellyfin brings back is current.
    if (known?.itemId === itemId && (!known.settled || (Date.now() - known.at < 2000 && known.handle?.section.isConnected))) return known.ready;
    const same = known?.itemId === itemId;
    if (!same) {
      page.querySelector(".hera-boxset")?.remove();
      page.classList.remove("hera-has-boxset");
      page.heraPlayTarget = null;
    }
    const entry = { itemId, settled: false, handle: null };
    entry.ready = buildBoxSet(page, itemId, same ? known.handle : null)
      .catch((error) => {
        noteFailure("boxset", error);
        return null;
      })
      .then((handle) => {
        entry.settled = true;
        entry.at = Date.now();
        entry.handle = handle;
        return handle;
      });
    boxSets.set(page, entry);
    return entry.ready;
  };

  /** The collection shelf on `page` for `itemId` once it is drawn, or null if there is none. */
  const collectionShelf = (page, itemId) => {
    const known = boxSets.get(page);
    return known?.itemId === itemId ? known.ready : Promise.resolve(null);
  };

  // ---------- detail pages --------------------------------------------------------------

  // The banner needs artwork even when the user's "details banner" setting is off.
  // Jellyfin resolves an episode's or season's backdrop to the nearest ancestor that has one, and
  // a season's is often the studio's key art with the title baked in. Under Hera's own logo that
  // prints the title twice, so episodes and seasons take their series' backdrop instead, and fall
  // back to their own only when the series has none.
  const bannerArt = async (item) => {
    const series = item.SeriesId && (item.Type === "Episode" || item.Type === "Season") ? await fetchItem(item.SeriesId) : null;
    if (series?.BackdropImageTags?.length) return { id: series.Id, tag: series.BackdropImageTags[0] };
    if (item.BackdropImageTags?.length) return { id: item.Id, tag: item.BackdropImageTags[0] };
    if (item.ParentBackdropImageTags?.length) return { id: item.ParentBackdropItemId, tag: item.ParentBackdropImageTags[0] };
    return null;
  };

  // Paints the banner and the ambient ground from a { banner, ambient } pair of image URLs.
  const paintBanner = (page, banner, itemId, urls) => {
    page.classList.remove("hera-no-backdrop");
    setView({ detailArt: true });
    banner.dataset.heraFilled = itemId;
    banner.style.backgroundImage = `url("${urls.banner}")`;
    banner.dataset.heraAmbient = urls.ambient;
    ambient.show(urls.ambient);
  };

  const fillBanner = async (page, itemId) => {
    const banner = jfFirst("banner", "detailBanner", page);
    if (!banner) return;
    if (banner.dataset.heraFilled === itemId) {
      // Back on a page already drawn: the ambient may be showing another title's art.
      if (banner.dataset.heraAmbient) ambient.show(banner.dataset.heraAmbient);
      return;
    }
    // Jellyfin drew its own banner (mobile layout): leave it.
    if (!banner.dataset.heraFilled && /url\(/.test(getComputedStyle(banner).backgroundImage)) {
      page.classList.remove("hera-no-backdrop");
      setView({ detailArt: true });
      return;
    }
    // Known art (this item, or the series of an episode or season the shelf has shown) paints
    // in the page's first frame; the lookup below only confirms or corrects it.
    const hint = itemHints.get(itemId);
    const known = artCache.get(itemId) ?? (hint?.SeriesId ? artCache.get(hint.SeriesId) : null);
    if (known) paintBanner(page, banner, itemId, known);
    const item = await fetchItem(itemId);
    if (itemIdFromHash() !== itemId) return;
    page.classList.toggle("hera-person", item?.Type === "Person");
    const art = item ? await bannerArt(item) : null;
    if (itemIdFromHash() !== itemId) return;
    if (!art) {
      // No artwork (people, books, bare collections): no banner; the portrait or cover shows.
      page.classList.add("hera-no-backdrop");
      setView({ detailArt: false });
      banner.dataset.heraFilled = itemId;
      banner.style.backgroundImage = "";
      ambient.hide();
      return;
    }
    const width = Math.min(2560, Math.round(window.innerWidth * (window.devicePixelRatio || 1)));
    // The page below the banner rests on the same art (one source for series, season and
    // episode alike), not on Jellyfin's page backdrop, which follows the season's key art.
    const urls = {
      banner: imageUrl(art.id, "Backdrop", { maxWidth: width, tag: art.tag }),
      ambient: imageUrl(art.id, "Backdrop", { maxWidth: 960, tag: art.tag }),
    };
    artCache.set(itemId, urls);
    if (item.SeriesId && art.id === item.SeriesId) artCache.set(item.SeriesId, urls);
    if (banner.style.backgroundImage !== `url("${urls.banner}")`) paintBanner(page, banner, itemId, urls);
  };

  // Series, season, episode and film pages differ in how much sits over the banner (a title, a
  // meta line, an overview of one to three lines, buttons). The ribbon is pulled up by exactly its
  // own height plus a fixed foot, so the buttons land the same distance above the banner's edge
  // on every one of them. --hera-ribbon-h feeds --hera-detail-overlay in hera-tv.css.
  const ribbonObservers = new WeakMap();
  // A new page starts from the last page's height, which for the next episode of the same show
  // is almost always right, instead of from a half-built ribbon (title only, no buttons yet).
  let lastRibbonHeight = 0;
  const fitRibbon = (page) => {
    const ribbon = jfFirst("ribbon", "detailRibbon", page);
    if (!ribbon || ribbonObservers.has(ribbon)) return;
    if (lastRibbonHeight && !page.style.getPropertyValue("--hera-ribbon-h")) {
      page.style.setProperty("--hera-ribbon-h", `${lastRibbonHeight}px`);
    }
    const measure = () => {
      // Until Jellyfin has drawn the buttons the ribbon is incomplete; measuring it then would
      // pull the content up and drop it again a moment later.
      const buttons = ribbon.querySelector(JF.detailButtons);
      if (!buttons || buttons.offsetHeight === 0) return;
      const parts = [...ribbon.children].filter((child) => child.offsetParent !== null && child.offsetHeight > 0);
      if (!parts.length) return;
      const top = parts[0].getBoundingClientRect().top;
      const bottom = Math.max(...parts.map((part) => part.getBoundingClientRect().bottom));
      const height = Math.ceil(bottom - top);
      if (height <= 0) return;
      lastRibbonHeight = height;
      if (page.style.getPropertyValue("--hera-ribbon-h") !== `${height}px`) {
        page.style.setProperty("--hera-ribbon-h", `${height}px`);
      }
    };
    const observer = new ResizeObserver(() => requestAnimationFrame(measure));
    const watch = () => [...ribbon.children].forEach((child) => observer.observe(child));
    watch();
    // Jellyfin swaps the ribbon's children between items; keep watching the new ones.
    const children = new MutationObserver(watch);
    children.observe(ribbon, { childList: true });
    ribbonObservers.set(ribbon, observer);
    state.cleanups.push(() => {
      observer.disconnect();
      children.disconnect();
      ribbonObservers.delete(ribbon);
      page.style.removeProperty("--hera-ribbon-h");
    });
    measure();
  };

  // Removes the synopsis and its "More".
  const dropOverview = (info) => {
    info.querySelectorAll(".hera-detail-overview, .hera-detail-more").forEach((node) => node.remove());
  };

  // The synopsis is clamped to three lines; "More" opens the rest and shows only while something is
  // hidden (the button's look is in hera-seerr.css, with the person page's own).
  const addMore = (text) => {
    // hera-detail-more marks it as the synopsis's own, so the person page's clean-up leaves it be.
    const button = el("button", { type: "button", class: "hera-readmore hera-detail-more", "aria-expanded": "false", text: "More", hidden: true });
    button.addEventListener("click", () => {
      const open = text.classList.toggle("is-open");
      button.setAttribute("aria-expanded", String(open));
      button.textContent = open ? "Less" : "More";
    });
    text.after(button);
    const observer = new ResizeObserver(() => {
      if (!text.isConnected) return observer.disconnect();
      if (!text.classList.contains("is-open")) button.hidden = text.scrollHeight <= text.clientHeight + 1;
    });
    observer.observe(text);
  };

  // The synopsis belongs with the title and buttons, over the artwork, as on tvOS; the stock
  // copy further down is hidden while ours is in place.
  const mountOverview = async (page, itemId) => {
    const info = jfFirst("overview", "detailRibbonInfo", page);
    if (!info) return;
    const existing = info.querySelector(".hera-detail-overview");
    if (existing?.dataset.item === itemId) return;
    dropOverview(info);
    page.classList.remove("hera-has-overview");
    const item = await fetchItem(itemId);
    if (!item?.Overview || itemIdFromHash() !== itemId) return;
    // A second call may have finished first while this one waited.
    dropOverview(info);
    const text = el("p", { class: "hera-detail-overview", "data-item": itemId, text: item.Overview });
    info.append(text);
    page.classList.add("hera-has-overview");
    addMore(text);
  };

  // One observer per logo element: Jellyfin reuses the page, and onView runs on every show.
  const logoObservers = new WeakMap();
  const markLogo = (page) => {
    const logo = jfFirst("logo", "detailLogo", page);
    const update = () => {
      const has = !!logo && !logo.classList.contains("hide") && /url\(/.test(logo.style.backgroundImage || "");
      page.classList.toggle("hera-has-logo", has);
    };
    update();
    if (logo && !logoObservers.has(logo)) {
      const observer = new MutationObserver(update);
      observer.observe(logo, { attributes: true, attributeFilter: ["style", "class"] });
      logoObservers.set(logo, observer);
      state.cleanups.push(() => {
        observer.disconnect();
        logoObservers.delete(logo);
      });
    }
  };

  // ---------- control center ------------------------------------------------------------
  // The profile button opens a tvOS-style Control Center instead of Jellyfin's menu: who is
  // signed in, the playback preferences people actually change, Quick Connect for signing in a
  // TV, what is playing elsewhere, and (for admins) a library scan. "All options" opens the
  // stock menu, so nothing Jellyfin or another plugin adds to it is lost.

  const SUBTITLE_MODES = [
    ["Smart", "Smart"],
    ["Always", "Always on"],
    ["OnlyForced", "Forced only"],
    ["None", "Off"],
    ["Default", "Default"],
  ];

  const isProfileButton = (target) => target.closest?.(JF.profileButton);

  const controlCenter = {
    dialog: null,
    bypass: false,
    user: null,

    async open(trigger) {
      this.trigger = trigger;
      this.user = await api().getCurrentUser();
      this.dialog?.remove();
      this.dialog = this.render();
      document.body.append(this.dialog);
      this.dialog.showModal();
      // The first control is a setting, not Sign out: a second Enter must never leave the page.
      this.dialog.querySelector(".hera-cc__tile")?.focus();
      track("control-center", this.refreshSessions());
    },

    close() {
      if (!this.dialog) return;
      this.dialog.close();
    },

    async saveConfig(change) {
      const user = await api().getCurrentUser();
      const config = { ...user.Configuration, ...change };
      await api().updateUserConfiguration(user.Id, config);
      this.user = { ...user, Configuration: config };
    },

    tile({ icon: name, label, value, pressed, onclick }) {
      const valueNode = el("span", { class: "hera-cc__tile-value", text: value });
      const button = el(
        "button",
        {
          type: "button",
          class: "hera-cc__tile",
          "aria-pressed": pressed === undefined ? undefined : String(pressed),
        },
        [icon(name), el("span", { class: "hera-cc__tile-label", text: label }), valueNode],
      );
      button.addEventListener("click", () => onclick(button, valueNode));
      return button;
    },

    render() {
      const user = this.user;
      const config = user.Configuration || {};
      const admin = !!user.Policy?.IsAdministrator;

      const avatar = user.PrimaryImageTag
        ? el("img", {
            class: "hera-cc__avatar",
            alt: "",
            src: api().getUrl(`Users/${user.Id}/Images/Primary`, { tag: user.PrimaryImageTag, maxWidth: 160, quality: 90 }),
          })
        : el("span", { class: "hera-cc__avatar", "aria-hidden": "true", text: (user.Name || "?").slice(0, 1).toUpperCase() });

      const subtitleIndex = Math.max(0, SUBTITLE_MODES.findIndex(([mode]) => mode === config.SubtitleMode));
      const tiles = [
        this.tile({
          icon: "closed_caption",
          label: "Subtitles",
          value: SUBTITLE_MODES[subtitleIndex][1],
          pressed: config.SubtitleMode !== "None",
          onclick: async (button, value) => {
            const current = SUBTITLE_MODES.findIndex(([mode]) => mode === this.user.Configuration.SubtitleMode);
            const [mode, text] = SUBTITLE_MODES[(Math.max(0, current) + 1) % SUBTITLE_MODES.length];
            await this.saveConfig({ SubtitleMode: mode });
            value.textContent = text;
            button.setAttribute("aria-pressed", String(mode !== "None"));
          },
        }),
        this.tile({
          icon: "skip_next",
          label: "Autoplay",
          value: config.EnableNextEpisodeAutoPlay ? "Next episode" : "Off",
          pressed: !!config.EnableNextEpisodeAutoPlay,
          onclick: async (button, value) => {
            const next = !this.user.Configuration.EnableNextEpisodeAutoPlay;
            await this.saveConfig({ EnableNextEpisodeAutoPlay: next });
            value.textContent = next ? "Next episode" : "Off";
            button.setAttribute("aria-pressed", String(next));
          },
        }),
        this.tile({
          icon: appearance.scheme() === "light" ? "light_mode" : "dark_mode",
          label: "Appearance",
          value: appearance.label(),
          onclick: async (button, value) => {
            const index = APPEARANCES.findIndex(([key]) => key === appearance.pref);
            const [next] = APPEARANCES[(index + 1) % APPEARANCES.length];
            await appearance.set(next);
            value.textContent = appearance.label();
            button.querySelector(".hera-icon").textContent = appearance.scheme() === "light" ? "light_mode" : "dark_mode";
          },
        }),
        this.tile({
          icon: "new_releases",
          label: "Recently Added",
          value: config.HidePlayedInLatest ? "Unwatched only" : "Everything",
          pressed: !!config.HidePlayedInLatest,
          onclick: async (button, value) => {
            const next = !this.user.Configuration.HidePlayedInLatest;
            await this.saveConfig({ HidePlayedInLatest: next });
            value.textContent = next ? "Unwatched only" : "Everything";
            button.setAttribute("aria-pressed", String(next));
          },
        }),
        admin
          ? this.tile({
              icon: "sync",
              label: "Libraries",
              value: "Scan for new media",
              onclick: async (button, value) => {
                button.disabled = true;
                value.textContent = "Scanning…";
                await api().ajax({ type: "POST", url: api().getUrl("Library/Refresh") });
                value.textContent = "Scan started";
              },
            })
          : null,
      ];

      // Quick Connect: a TV or phone app shows a six-digit code; entering it here signs that
      // device in as this user, which is how SSO accounts reach native apps.
      const codeInput = el("input", {
        class: "hera-cc__code",
        type: "text",
        inputmode: "numeric",
        autocomplete: "one-time-code",
        maxlength: "6",
        pattern: "[0-9]{6}",
        placeholder: "000000",
        "aria-label": "Quick Connect code",
        "aria-describedby": "hera-cc-qc-status",
      });
      const qcStatus = el("p", {
        class: "hera-cc__status",
        id: "hera-cc-qc-status",
        role: "status",
        text: "Enter the code a TV or phone shows to sign it in as you.",
      });
      const qcForm = el("form", { class: "hera-cc__qc" }, [
        codeInput,
        el("button", { type: "submit", class: "hera-btn hera-btn--primary hera-cc__qc-submit", text: "Sign In" }),
      ]);
      qcForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        const code = codeInput.value.trim();
        if (!/^\d{6}$/.test(code)) {
          qcStatus.textContent = "The code is six digits.";
          codeInput.focus();
          return;
        }
        try {
          await api().ajax({ type: "POST", url: api().getUrl("QuickConnect/Authorize", { code }) });
          qcStatus.textContent = "Signed in. The device continues on its own.";
          codeInput.value = "";
        } catch {
          qcStatus.textContent = "That code has expired or was mistyped. Ask the device for a new one.";
        }
      });

      this.sessionList = el("ul", { class: "hera-cc__sessions", "aria-live": "polite" });

      const link = (href, name, text) =>
        el("a", { class: "hera-cc__link", href, onclick: () => this.close() }, [icon(name), el("span", { text })]);
      const links = el("nav", { class: "hera-cc__links", "aria-label": "Account" }, [
        link(`#/userprofile?userId=${user.Id}`, "person", "Profile"),
        link("#/mypreferencesmenu", "settings", "Settings"),
        link("#/home?hera=stats", "history", "Your Watching"),
        admin ? link("#/dashboard", "dashboard", "Dashboard") : null,
        el(
          "button",
          {
            type: "button",
            class: "hera-cc__link",
            onclick: () => {
              this.close();
              // Open Jellyfin's own menu once, for anything a plugin adds there.
              this.bypass = true;
              this.trigger?.click();
              this.bypass = false;
            },
          },
          [icon("more_horiz"), el("span", { text: "All options" })],
        ),
      ]);
      // Requests (hera-activity.js) are for people who can request and administrators who watch the queue.
      integrations().then((ints) => {
        if (window.HeraTV?.activity?.requestsAvailable(ints)) {
          links.firstElementChild?.after(link(window.HeraTV.activity.hash, "playlist_add_check", "Requests"));
        }
      });

      const dialog = el("dialog", { class: "hera-cc", "aria-label": "Control Center" }, [
        el("div", { class: "hera-cc__panel" }, [
          el("header", { class: "hera-cc__profile" }, [
            avatar,
            el("div", { class: "hera-cc__who" }, [
              el("p", { class: "hera-cc__name", text: user.Name }),
              el("p", { class: "hera-cc__role", text: admin ? "Administrator" : "Member" }),
            ]),
            el(
              "button",
              {
                type: "button",
                class: "hera-btn hera-btn--glass hera-cc__signout",
                "aria-label": "Sign out",
                title: "Sign out",
                onclick: () => {
                  this.close();
                  window.Dashboard?.logout?.();
                },
              },
              icon("logout"),
            ),
          ]),
          el("div", { class: "hera-cc__tiles" }, tiles),
          el("section", { class: "hera-cc__group", "aria-labelledby": "hera-cc-qc" }, [
            el("h2", { class: "hera-cc__heading", id: "hera-cc-qc", text: "Quick Connect" }),
            qcForm,
            qcStatus,
          ]),
          el("section", { class: "hera-cc__group", "aria-labelledby": "hera-cc-now" }, [
            el("h2", { class: "hera-cc__heading", id: "hera-cc-now", text: "Watching Now" }),
            this.sessionList,
          ]),
          links,
        ]),
      ]);
      dialog.addEventListener("click", (e) => {
        if (e.target === dialog) this.close();
      });
      dialog.addEventListener("close", () => {
        dialog.remove();
        if (this.dialog === dialog) this.dialog = null;
        this.trigger?.focus?.();
      });
      return dialog;
    },

    async refreshSessions() {
      const list = this.sessionList;
      const sessions = (await getJSON("Sessions", { activeWithinSeconds: 960 })) ?? [];
      const own = api().deviceId();
      const playing = sessions.filter((s) => s.NowPlayingItem && s.DeviceId !== own);
      if (!list.isConnected) return;
      if (!playing.length) {
        list.replaceChildren(el("li", { class: "hera-cc__empty", text: "Nothing is playing on other devices." }));
        return;
      }
      list.replaceChildren(
        ...playing.map((s) => {
          const item = s.NowPlayingItem;
          const title = item.SeriesName ? `${item.SeriesName} · ${item.Name}` : item.Name;
          const percent = item.RunTimeTicks ? Math.round(((s.PlayState?.PositionTicks || 0) / item.RunTimeTicks) * 100) : 0;
          return el("li", { class: "hera-cc__session" }, [
            el("span", { class: "hera-cc__session-title", text: title }),
            el("span", {
              class: "hera-cc__session-meta",
              text: `${s.UserName || "Someone"} · ${s.DeviceName}${s.PlayState?.IsPaused ? " · Paused" : ""}`,
            }),
            el("span", { class: "hera-cc__session-progress" }, el("span", { style: `width:${percent}%` })),
          ]);
        }),
      );
    },
  };

  const onProfileClick = (e) => {
    const button = isProfileButton(e.target);
    if (!button || controlCenter.bypass || !api() || !userId()) return;
    e.preventDefault();
    e.stopPropagation();
    controlCenter.open(button).catch((error) => {
      noteFailure("control-center", error);
      controlCenter.bypass = true;
      button.click();
      controlCenter.bypass = false;
    });
  };

  // ---------- routing --------------------------------------------------------------------

  const itemIdFromHash = () => new URLSearchParams(window.location.hash.split("?")[1] || "").get("id");

  // The scroll-edge layer under the bar (body::after in hera-tv.css) is as tall as the bar that
  // is showing: 64px, more with a library page's toolbar, or the TV layout's own header.
  const measureBar = () => {
    const bar = [...document.querySelectorAll(`${JF.appBar}, ${JF.legacyHeader}`)].find((node) => node.offsetHeight > 0);
    if (bar) root.style.setProperty("--hera-bar-h", `${Math.round(bar.offsetHeight)}px`);
  };

  // Jellyfin can show the home page before its home tab has drawn the sections container (coming
  // back from another page through the header's Home link, or from Favourites). The hero and
  // every home row hang off that container, so the page runs again once it exists.
  const homeWait = { observer: null, timer: 0 };
  const stopHomeWait = () => {
    homeWait.observer?.disconnect();
    homeWait.observer = null;
    clearTimeout(homeWait.timer);
  };
  const waitForHomeSections = (page) => {
    stopHomeWait();
    homeWait.observer = new MutationObserver(() => {
      if (!page.querySelector(JF.homeSections)) return;
      stopHomeWait();
      if (!page.classList.contains("hide")) onView(page);
    });
    homeWait.observer.observe(page, { childList: true, subtree: true });
    homeWait.timer = setTimeout(stopHomeWait, 10000);
  };

  // Core is the only place that watches for navigation: modules ask it (kit.onRoute) instead of
  // each listening for viewshow and hashchange. A route is a page showing under an address, and is
  // told once however many signals announce it: Jellyfin's viewshow, a `.page` coming into view,
  // and, for a router push that does neither, the address changing (checked a moment later, when
  // the new page has had time to appear). A module hears routes only while it is active
  // (kit.onRoute(module, fn)): never when it is switched off or standing aside, and once, as it
  // subscribes or becomes active, for the route that is current.
  const routeListeners = new Set(); // { module (null for core's own), fn }
  const route = { key: "", at: 0, current: null, late: 0, nav: 0, check: 0 };
  const visiblePage = () => document.querySelector(JF.page);
  const fireRoute = (entry, info) => {
    try {
      entry.fn(info);
    } catch (error) {
      noteFailure(entry.module ?? "core", error);
    }
  };
  const onRoute = (module, fn) => {
    const entry = { module, fn };
    routeListeners.add(entry);
    if (route.current && isActive(module)) {
      queueMicrotask(() => {
        if (routeListeners.has(entry) && isActive(module) && route.current) fireRoute(entry, route.current);
      });
    }
    return () => routeListeners.delete(entry);
  };
  function deliverCurrent(name) {
    for (const entry of routeListeners) {
      if (entry.module !== name) continue;
      queueMicrotask(() => {
        if (routeListeners.has(entry) && isActive(name) && route.current) fireRoute(entry, route.current);
      });
    }
  }
  // Ends a module: its route subscriptions, then its own stop() and teardown().
  function stopModule(module) {
    for (const entry of [...routeListeners]) if (entry.module === module.name) routeListeners.delete(entry);
    for (const hook of [module.stop, module.teardown]) {
      try {
        hook?.call(module);
      } catch (error) {
        console.warn("[Hera TV:" + module.name + "] stop failed", error);
      }
    }
  }
  const emitRoute = (page, { force = false } = {}) => {
    if (!(page instanceof HTMLElement) || health.boot === "safe") return;
    const hash = window.location.hash;
    const key = `${hash}|${page.id}`;
    const now = Date.now();
    // A viewshow of the page already showing, long after it was told, is Jellyfin showing it again.
    if (key === route.key && !(force && now - route.at > 600)) return;
    route.key = key;
    route.at = now;
    const info = { hash, path: hash.slice(1).split("?")[0], params: new URLSearchParams(hash.split("?")[1] || ""), page };
    route.current = info;
    for (const entry of [...routeListeners]) {
      if (entry.module === null || isActive(entry.module)) fireRoute(entry, info);
    }
    // Series pages re-render their sections after the first viewshow; a late pass catches that.
    clearTimeout(route.late);
    route.late = setTimeout(() => {
      if (visiblePage() === page) onView(page);
    }, 400);
  };
  const queueRouteCheck = () => {
    if (route.check) return;
    route.check = requestAnimationFrame(() => {
      route.check = 0;
      const page = visiblePage();
      if (page) emitRoute(page);
    });
  };
  const onViewShow = (event) => {
    const page = event.target?.closest?.(JF.pageRoot) || event.target;
    emitRoute(page, { force: true });
  };
  const onNavigate = () => {
    // history.replaceState changes the address without an event, so the same route must be able to be announced again.
    route.key = "";
    clearTimeout(route.nav);
    route.nav = setTimeout(() => {
      const page = visiblePage();
      if (page) emitRoute(page);
    }, 400);
  };
  // A page Jellyfin shows by toggling its class, or adds already shown, announces itself here.
  const pageWatch = new WeakSet();
  const pageObserver = new MutationObserver(queueRouteCheck);
  const watchPage = (node) => {
    if (pageWatch.has(node)) return false;
    pageWatch.add(node);
    pageObserver.observe(node, { attributes: true, attributeFilter: ["class"] });
    return true;
  };
  const watchPagesIn = (node) => {
    let added = node.classList.contains("page") && watchPage(node);
    for (const inner of node.getElementsByClassName("page")) added = watchPage(inner) || added;
    if (added) queueRouteCheck();
  };

  // ---------- British copy -------------------------------------------------------------
  // Jellyfin's React header, its menus and its section titles name things in American English
  // ("Movies", "Favorites", "Shows"), and a CSS ::after cannot tell one title from another. Rewrite
  // those exact words where Jellyfin draws them, and again when it redraws them. Its certificates
  // lose their country prefix and take the badge, inside the item so the line's dot stays outside.

  const BRITISH = new Map([
    ["Movies", "Films"],
    ["Shows", "TV Shows"],
    ["Favorites", "Favourites"],
  ]);
  const localiseCopy = () => {
    // The TV layout's header is Jellyfin's older one, with its own tab buttons ("Favorites").
    for (const node of document.querySelectorAll(`${JF.appBarTitle}, ${JF.libraryMenu} li, ${JF.page} ${JF.sectionTitle}, ${JF.headerTabButton}`)) {
      const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        const next = BRITISH.get(text.nodeValue.trim());
        if (next) text.nodeValue = next;
      }
    }
    for (const node of document.querySelectorAll(JF.homeOfficialRating)) {
      if (node.firstElementChild?.classList.contains("hera-badge")) continue;
      node.replaceChildren(el("span", { class: "hera-badge", text: certificate(node.textContent.trim()) }));
    }
    // Jellyfin's meta line writes runtimes "1h 39m" and ranges "2022 - 2025"; Hera's own surfaces
    // say "1 hr 39 min" and "2022–2025".
    for (const node of document.querySelectorAll(JF.miscAllItems)) {
      if (node.childElementCount) continue;
      const text = node.textContent.trim();
      const long = /^(\d+)h(?: (\d+)m)?$/.exec(text);
      const short = /^(\d+)m$/.exec(text);
      const next = long
        ? `${long[1]} hr${Number(long[2]) ? ` ${long[2]} min` : ""}`
        : short
          ? `${short[1]} min`
          : /^\d{4} - (?:\d{4}|Present)$/.test(text)
            ? text.replace(" - ", "–")
            : null;
      if (next) node.textContent = next;
    }
  };
  // Only a change that could carry one of those words queues a pass: new nodes anywhere but the
  // player, or a text edit inside the few places localiseCopy rewrites. The player's clock and
  // position ticks, and removals, cost nothing.
  const COPY_HOSTS = [JF.appBar, JF.libraryMenu, JF.sectionTitle, JF.homeOfficialRating, JF.miscInfo, JF.headerTabButton].join(", ");
  const copyRelevant = (record) => {
    const host = record.target.nodeType === Node.ELEMENT_NODE ? record.target : record.target.parentElement;
    if (!host || host.closest(JF.videoOsdPage)) return false;
    if (record.type === "characterData") return !!host.closest(COPY_HOSTS);
    return record.addedNodes.length > 0;
  };
  let copyQueued = false;
  const queueCopy = () => {
    if (copyQueued) return;
    copyQueued = true;
    requestAnimationFrame(() => {
      copyQueued = false;
      if (!isActive("british")) return;
      try {
        localiseCopy();
      } catch (error) {
        noteFailure("british", error);
      }
    });
  };
  // The one observer of the whole document: it finds pages as Jellyfin adds them and queues a
  // copy pass for changes that could need one.
  const domObserver = new MutationObserver((records) => {
    let copy = false;
    for (const record of records) {
      for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) watchPagesIn(node);
      if (!copy && copyRelevant(record)) copy = true;
    }
    if (copy) queueCopy();
  });

  // ---------- Hera's own pieces, each a module -----------------------------------------------
  // The hero, the detail page's banner, overview, logo, ribbon, seasons and box set, the Control
  // Center, the paddles and the British copy each run, report and switch off on their own, so one
  // that breaks on a Jellyfin page it no longer recognises leaves the rest (and Jellyfin's own
  // page) alone.

  const onDetail = (run) => (page) => (page.id === "itemDetailPage" ? run(page, itemIdFromHash()) : undefined);

  // The banner's Play carries the title Hera started for another page; drop it when the page
  // moves on to a different one.
  const clearStaleLabel = (page, id) => {
    const content = page.querySelector(`${JF.detailPlay} ${JF.detailButtonContent}`);
    if (id && content?.dataset.heraLabelItem && content.dataset.heraLabelItem !== id) labelPlay(page, id, null);
  };

  let stopCapture = null;
  let paddleScope = null;
  const builtIns = [
    {
      name: "hero",
      requires: { indexPage: ["homeTab"] },
      onView: async (page) => {
        if (page.id !== "indexPage") return;
        stopHomeWait();
        if (!page.querySelector(JF.homeSections)) waitForHomeSections(page);
        await mountHero(page);
      },
      teardown: () => {
        state.hero?.destroy();
        state.hero = null;
        stopHomeWait();
        heroTabObserver.observer?.disconnect();
        setView({ home: false });
      },
    },
    {
      name: "logo",
      requires: { itemDetailPage: ["detailLogo"] },
      onView: onDetail((page) => markLogo(page)),
      teardown: () => document.querySelectorAll(".hera-has-logo").forEach((node) => node.classList.remove("hera-has-logo")),
    },
    {
      name: "ribbon",
      requires: { itemDetailPage: ["detailRibbon", "detailButtons"] },
      onView: onDetail((page) => fitRibbon(page)),
    },
    {
      name: "banner",
      requires: { itemDetailPage: ["detailBanner"] },
      // Not awaited: the banner must not hold up the shelves behind it.
      onView: onDetail((page, id) => {
        if (id) track("banner", fillBanner(page, id));
      }),
      teardown: () => setView({ detailArt: false }),
    },
    {
      name: "overview",
      requires: { itemDetailPage: ["detailRibbon", "detailRibbonInfo"] },
      onView: onDetail((page, id) => {
        if (id) track("overview", mountOverview(page, id));
      }),
      teardown: () => {
        document.querySelectorAll(".hera-detail-overview, .hera-detail-more").forEach((node) => node.remove());
        document.querySelectorAll(".hera-has-overview").forEach((node) => node.classList.remove("hera-has-overview"));
      },
    },
    {
      name: "seasons",
      requires: { itemDetailPage: ["detailPrimary"] },
      onView: onDetail(async (page, id) => {
        if (!id) return;
        clearStaleLabel(page, id);
        await mountSeasons(page, id);
        // A page Jellyfin brings back from its cache keeps its shelf, so mountSeasons returns
        // early; the reader's place is restored here instead.
        restoreShelfPlace(page);
      }),
      teardown: () => {
        document.querySelectorAll(".hera-seasons").forEach((node) => node.remove());
        document.querySelectorAll(".hera-has-seasons").forEach((node) => node.classList.remove("hera-has-seasons"));
      },
    },
    {
      name: "boxset",
      requires: { itemDetailPage: ["detailPrimary"] },
      onView: onDetail(async (page, id) => {
        if (!id) return;
        clearStaleLabel(page, id);
        await mountBoxSet(page, id);
      }),
      teardown: () => {
        document.querySelectorAll(".hera-boxset").forEach((node) => node.remove());
        document.querySelectorAll(".hera-has-boxset").forEach((node) => node.classList.remove("hera-has-boxset"));
      },
    },
    {
      // Needs the profile button on the pages that have a header; with it gone, the click is left
      // to Jellyfin's own menu (the interceptor detaches with the module).
      name: "control-center",
      requires: { indexPage: ["profileButton"], itemDetailPage: ["profileButton"] },
      onView: () => {
        stopCapture ??= intercept("control-center", document, "click", onProfileClick);
      },
      teardown: () => {
        stopCapture?.();
        stopCapture = null;
        controlCenter.dialog?.remove();
      },
    },
    {
      name: "paddles",
      onView: () => {
        if (paddleScope) return;
        paddleScope = scope();
        paddleScope.listen(document, "pointerover", onPaddleHover, { passive: true });
      },
      teardown: () => {
        paddleScope?.dispose();
        paddleScope = null;
        document.querySelectorAll(".hera-row__paddle").forEach((node) => node.remove());
      },
    },
    {
      name: "british",
      onView: () => localiseCopy(),
    },
  ];

  // Each showing of a page gets a number; a run still waiting for Jellyfin's pieces when a newer
  // one starts (or the page is hidden) stops, so modules never act on a page the reader has left.
  let viewGeneration = 0;
  const onView = async (page) => {
    if (!api() || !userId() || health.boot === "safe") return;
    const generation = ++viewGeneration;
    const stale = () => generation !== viewGeneration || page.classList.contains("hide");
    root.dataset.heraView = page.id || "";
    // The page's toolbar renders a moment after the page shows.
    requestAnimationFrame(measureBar);
    setTimeout(measureBar, 400);
    if (page.id !== "indexPage") view.home = false;
    if (page.id !== "itemDetailPage") view.detailArt = false;
    applyView();
    const context = { itemId: itemIdFromHash(), params: new URLSearchParams(window.location.hash.split("?")[1] || "") };
    const settled = new Set();
    // One module failing never stops the others.
    for (const module of modules) {
      if (!(await runModule(module, page, context, settled, stale))) return;
    }
    // The first full pass is the browser checking in; reportHealth sends only what changed after.
    reportHealth();
  };

  // A module is run once the server's settings say it may be (some can be switched off there).
  const addModule = (module) => {
    if (state.disabled.has(module.name)) return;
    const m = moduleHealth(module.name);
    m.registered = true;
    modules.push(module);
    refresh(module.name);
    // Load-time wiring and exports (HT.discover, HT.hidden, a stylesheet's helper nodes) belong to
    // start(), so a module the settings switch off runs nothing at all.
    try {
      module.start?.();
    } catch (error) {
      noteFailure(module.name, error);
    }
    // A module that arrives after the first page still sees it.
    const page = visiblePage();
    if (page && api() && userId() && health.boot !== "safe") {
      runModule(module, page, { itemId: itemIdFromHash(), params: new URLSearchParams(window.location.hash.split("?")[1] || "") });
    }
  };
  const enqueue = (module) => (state.ready ? addModule(module) : pending.push(module));

  const loadConfig = async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(new URL("../HeraTV/config", document.baseURI), { signal: controller.signal });
      if (response.ok) state.config = { ...state.config, ...(await response.json()) };
    } catch {
      /* defaults stand */
    } finally {
      clearTimeout(timer);
    }
  };

  const start = async () => {
    keepStylesheetLast();
    appearance.apply();
    const onDeviceScheme = () => appearance.pref === "auto" && appearance.apply();
    lightQuery?.addEventListener?.("change", onDeviceScheme);
    state.cleanups.push(() => lightQuery?.removeEventListener?.("change", onDeviceScheme));
    const onScroll = () => {
      const scrolled = window.scrollY > 24;
      if (scrolled && !root.classList.contains("hera-scrolled")) measureBar();
      root.classList.toggle("hera-scrolled", scrolled);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    state.cleanups.push(() => window.removeEventListener("scroll", onScroll));
    onScroll();
    // Jellyfin's home is a "backdropPage": each time it shows, Jellyfin starts a rotation that
    // downloads and decodes a full-width backdrop every ten seconds, behind the hero, where nothing
    // shows it (html.hera-home .backdropContainer is hidden). Without the class it clears instead.
    const onBeforeShow = (event) => {
      if (event.target?.id === "indexPage") event.target.classList.remove("backdropPage");
    };
    document.addEventListener("viewbeforeshow", onBeforeShow, true);
    document.querySelector(JF.homePage)?.classList.remove("backdropPage");
    state.cleanups.push(() => {
      document.removeEventListener("viewbeforeshow", onBeforeShow, true);
      document.querySelector(JF.homePage)?.classList.add("backdropPage");
    });

    await loadConfig();
    if (health.boot === "safe") return;
    state.disabled = new Set(Array.isArray(state.config.disabledModules) ? state.config.disabledModules : []);
    state.disabled.forEach((name) => root.classList.remove("hera-m-" + name));
    state.ready = true;
    pending.splice(0).forEach(addModule);

    routeListeners.add({ module: null, fn: ({ page }) => onView(page) });
    document.addEventListener("viewshow", onViewShow);
    window.addEventListener("hashchange", onNavigate);
    window.addEventListener("popstate", onNavigate);
    document.querySelectorAll(JF.pageRoot).forEach(watchPage);
    domObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    queueRouteCheck();
    state.cleanups.push(() => {
      document.removeEventListener("viewshow", onViewShow);
      window.removeEventListener("hashchange", onNavigate);
      window.removeEventListener("popstate", onNavigate);
      domObserver.disconnect();
      pageObserver.disconnect();
      cancelAnimationFrame(route.check);
      clearTimeout(route.late);
      clearTimeout(route.nav);
      clearTimeout(reportTimer);
    });

    // The ApiClient is checked as soon as it exists: the methods Hera calls must all be there, or
    // Hera steps aside. What needs a signed-in user waits for one (a signed-out tab has the
    // ApiClient too, so it is not caught by the watchdog below).
    let checked = false;
    const waitForApi = setInterval(() => {
      try {
        const client = api();
        if (!client) return;
        if (!checked) {
          checked = true;
          const missing = API_REQUIRED.filter((name) => typeof client[name] !== "function");
          if (missing.length) {
            clearInterval(waitForApi);
            clearTimeout(watchdog);
            safeMode(`Jellyfin's ApiClient has no ${missing.join(", ")}`);
            return;
          }
          const lacking = API_OPTIONAL.filter((name) => typeof client[name] !== "function");
          report("core", lacking.length ? "partial" : "ok", { missing: lacking.map((name) => `ApiClient.${name}`) });
          if (health.boot === "starting") health.boot = "ok";
          checkVersion();
        }
        if (!userId()) return;
        clearInterval(waitForApi);
        clearTimeout(watchdog);
        appearance.load().catch(() => {});
        getJSON("System/Info/Public")
          .then((info) => info?.ServerName && root.style.setProperty("--hera-server", JSON.stringify(info.ServerName)))
          .catch(() => {});
        // The first page may already be showing when we arrive.
        const page = visiblePage();
        if (page) onView(page);
      } catch (error) {
        clearInterval(waitForApi);
        clearTimeout(watchdog);
        safeMode(`Jellyfin's ApiClient failed: ${error?.message || error}`);
      }
    }, 250);
    // A web client with no ApiClient long after loading is not one Hera knows: step aside.
    const watchdog = setTimeout(() => {
      if (!api()) safeMode("Jellyfin's web client has no ApiClient");
    }, 20000);
    state.cleanups.push(() => clearInterval(waitForApi), () => clearTimeout(watchdog));
  };

  window.HeraTV = {
    kit: {
      api,
      userId,
      el,
      icon,
      getJSON,
      /** An item as the signed-in user sees it, fetched once per half a minute whoever asks. */
      item: fetchItem,
      imageUrl,
      runtime,
      go,
      play,
      playAction,
      hera,
      integrations,
      card,
      shelf,
      mountRow,
      shelfCard,
      collectionShelf,
      shortDate,
      itemIdFromHash,
      reduceMotion,
      appearance,
      prefs,
      appearances: APPEARANCES,
      isTv: () => root.classList.contains("layout-tv"),
      /** `kit.externalLink(attrs, children, { fallback })`: a link out of Jellyfin, or null (or the fallback element) in the TV layout. */
      externalLink,
      /** `kit.jf(module, key, root = document)`: the first match of a Jellyfin piece, or null (a null for a required key marks `module` partial). */
      jf: jfFirst,
      /** All matches, as an array; an empty one is a miss the same way. */
      jfAll,
      /** `kit.report(module, status, detail?)`: ok | partial | degraded | idle, for a module with no onView; detail is a message or { missing, page, error }. */
      report,
      /** `kit.track(module, promise)`: counts the promise's failure against the module (partial, never a strike); resolves to its value or undefined. */
      track,
      /** `kit.onRoute(module, fn)`: fn({ hash, path, params, page }) once per navigation, while `module` is active (and once when it subscribes or becomes active, for the current route); returns the unsubscribe. */
      onRoute,
      scope,
      ttlCache,
      text: textTools,
      keys: keyTools,
      /** Core alone owns the <html> view classes: take() for a module's full-page view, release() to give it back. */
      view: { take: takeView, release: releaseView },
      /** `kit.intercept(module, target, type, handler, options?)`: a capture-phase listener that detaches while the module is standing aside or off; returns the unsubscribe. */
      intercept,
      /** Jellyfin's own localStorage key names (JF_STORAGE); jfUserKey prefixes the signed-in user's id. */
      storage: {
        jfKey: (name) => storageName(name, false),
        jfUserKey: (name) => storageName(name, true),
      },
      /** How long a page gets to settle before a missing piece counts (ms). */
      settleMs: SETTLE_MS,
    },
    /** Jellyfin's pieces Hera leans on, by name, and what each is (scope, required) (see "compatibility"). */
    jf: JF,
    jfMeta: JF_META,
    /** How Hera is getting on with this Jellyfin: boot state and each module's status. */
    health: healthSnapshot,
    /**
     * Adds a module: `{ name, requires, start(), stop(), onView(page, { itemId, params }), teardown() }`.
     * `start()` runs once the module is registered and the plugin's settings leave it on (so load-time
     * wiring and namespace exports go there); `stop()` (and `teardown()`) run when it is switched off or
     * torn down.
     * `requires` maps a page id (or "*") to the names in `jf` the module can't work without on
     * that page; until they are there, the module is not run on it. A module switched off in the
     * plugin's settings is never run.
     */
    register: enqueue,
    /** Called by the bundle when a script threw as it loaded: the module shows as degraded, with the error. */
    loadFailed(file, error) {
      const name = file === "hera-tv.js" ? "core" : file.replace(/^hera-/, "").replace(/\.js$/, "");
      moduleHealth(name).errors += 1;
      report(name, "degraded", { error: "failed to load " + file + ": " + formatError(error) });
    },
    teardown() {
      state.hero?.destroy();
      state.hero = null;
      stopHomeWait();
      ambient.remove();
      heroTabObserver.observer?.disconnect();
      state.cleanups.splice(0).forEach((fn) => fn());
      for (const entry of intercepts) attach(entry, false);
      intercepts.clear();
      routeListeners.clear();
      for (const module of modules.splice(0)) stopModule(module);
      pending.length = 0;
      document.querySelectorAll(".hera-seasons, .hera-boxset").forEach((node) => node.remove());
      clearRootClasses();
    },
  };

  builtIns.forEach(enqueue);
  start().catch((error) => {
    noteFailure("core", error);
    safeMode(`Hera's core failed to start: ${error?.message || error}`);
  });
})();
