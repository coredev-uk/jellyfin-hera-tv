/*
 * Hera TV: extras. Registers with window.HeraTV (hera-tv.js). What Jellyfin Enhanced and Jellyfin
 * Tweaks used to add, rebuilt in Hera's own language:
 *  - Defaults for a person's first visit on a browser: page backdrops, detail banners, blurhash.
 *    They are written only where the person has not chosen, so a changed setting is never undone
 *    (and never taken back either: a stored "true" cannot be told from the person's own choice).
 *  - Quality on detail pages (meta line) and on cards (4K, HDR, Dolby Vision, Atmos), fetched in
 *    batches for the cards that are on screen.
 *  - IMDb and Rotten Tomatoes scores on film and series pages (from Seerr, through the server).
 *  - "Also on": the streaming services that carry a title in the configured region.
 *  - Hide titles: "Remove from Up Next" and "Not Interested", saved per user on the server,
 *    honoured by Hera's rows, Discover and search, and listed with Unhide in Settings > Home.
 *
 * Contracts with other files:
 *  - Reads these expandos off Hera's cards (set by hera-home.js, hera-discover.js, hera-search.js):
 *    `heraHide` ({ scope, keys, title, year, kind, image, extra }: this card can be hidden),
 *    `heraItem` (a Seerr title) and `heraId` (a library item id).
 *  - Offers `HeraTV.hidden` (ready, match, settingsGroup, menu) to home, Discover and Settings; it
 *    is gone while this module is torn down, so callers use it optionally.
 *  - Borrows Jellyfin's `mediaInfoItem` class for the nodes it adds to the detail meta line, so
 *    they take the line's spacing and separator dots.
 *  - Expects hera-tv.css for `.hera-card`, `.hera-card__art`, `.hera-card__progress` and
 *    hera-dashboard.css for the `.hera-set-*` rows of the hidden-titles list.
 *  - Its stylesheets are hera-extras.css (this module) and hera-extras-detail.css (`extras-detail`),
 *    each gated on its own module's class, so the detail page's ratings and chips stand or fall apart.
 */
(() => {
  "use strict";

  const heraTv = window.HeraTV;
  if (!heraTv) return;
  const { kit, jf } = heraTv;
  const { el, icon } = kit;

  const MODULE = "extras";
  const DETAIL = "extras-detail";

  const BADGE_LABEL = { "4k": "4K", dv: "Dolby Vision", hdr: "HDR", atmos: "Dolby Atmos", "7.1": "7.1", "5.1": "5.1" };
  // Cards carry the loudest facts only, in the shortest words.
  const CARD_LABEL = { "4k": "4K", dv: "DV", hdr: "HDR", atmos: "Atmos" };
  const CARD_ORDER = ["4k", "dv", "hdr", "atmos"];
  // Jellyfin's own cards come from the `extrasStockCards` key; these are Hera's.
  const HERA_CARDS = '.hera-card[href^="#/details?id="]:not(.hera-card--person), .hera-upnext > .hera-card';
  const BADGE_BATCH = 40;
  const BADGE_KEPT = 1500;
  const EXTRAS_KEPT = 40;
  const BADGE_TTL = 10 * 60 * 1000;
  const EXTRAS_TTL = 5 * 60 * 1000;
  const UNDO_MS = 6000;
  const LONG_PRESS_MS = 450;

  const state = {
    run: 0, // detail-page mounts: a newer mount, or a teardown, makes an older one stale
    badgeQueue: new Set(),
    badgeTimer: 0,
    badgeObserver: null,
    detail: null,
  };
  // Everything the module listens to or observes while it runs, so teardown is one call. Null
  // while the module is off; an async step that outlives a teardown sees it change and stops.
  let scope = null;

  const badgeCache = kit.ttlCache({ ttl: BADGE_TTL, max: BADGE_KEPT }); // item id -> badge keys
  const extrasCache = kit.ttlCache({ ttl: EXTRAS_TTL, max: EXTRAS_KEPT }); // item id -> the server's extras

  const plainId = (id) => String(id || "").replace(/-/g, "").toLowerCase();
  const features = async () => (await kit.integrations())?.features || {};
  /** True while `page` is the page on screen. */
  const isShown = (page) => page.isConnected && kit.jf(DETAIL, "page") === page;

  // ---------- defaults ------------------------------------------------------------------------
  // Jellyfin keeps these in the browser, under "<user id>-<setting>". Jellyfin Tweaks forced them
  // on every load; here a missing value is filled in once and a stored one, on or off, is left.

  const DEFAULTS = { enableBackdrops: "true", detailsBanner: "true", blurhash: "true" };

  const applyDefaults = () => {
    if (!kit.userId()) return;
    try {
      for (const [name, value] of Object.entries(DEFAULTS)) {
        const key = kit.storage.jfUserKey(name);
        if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
      }
    } catch {
      /* private mode: Jellyfin's own defaults stand */
    }
  };

  // ---------- hidden titles -------------------------------------------------------------------

  const hidden = { user: null, list: null, index: null, loading: null };

  // The list, and a lookup by "scope:key" (a title's key or any alias) so a card is judged in one
  // read, not by walking the list.
  const setList = (list) => {
    hidden.list = list;
    hidden.index = new Map();
    if (!list) return;
    for (const entry of list) {
      for (const key of [entry.key, ...(entry.aliases || [])]) {
        const id = `${entry.scope}:${key}`;
        if (!hidden.index.has(id)) hidden.index.set(id, entry);
      }
    }
  };

  const loadHidden = () => {
    const user = kit.userId();
    if (hidden.user !== user) {
      hidden.user = user;
      setList(null);
      hidden.loading = null;
    }
    if (!hidden.loading) {
      hidden.loading = Promise.resolve(kit.hera("hidden"))
        .then((list) => {
          setList(Array.isArray(list) ? list : []);
          return hidden.list;
        })
        .catch((error) => {
          hidden.loading = null;
          console.warn("[Hera TV:extras] hidden titles", error);
          return hidden.list || [];
        });
    }
    return hidden.loading;
  };

  /** The saved entry that hides a title in this scope, matching any of its keys; null when it is shown. */
  const hiddenEntry = (scope, keys) => {
    if (!hidden.index?.size) return null;
    for (const key of keys) {
      if (!key) continue;
      const entry = hidden.index.get(`${scope}:${key}`);
      if (entry) return entry;
    }
    return null;
  };

  const writeHidden = (list) => {
    setList(list);
    hidden.loading = Promise.resolve(list);
  };

  // The artwork is a 32 by 48 icon in Settings; a small size is all it takes (TMDB's w92, or a Jellyfin image at 96).
  const thumb = (url) => (url ? url.replace(/(image\.tmdb\.org\/t\/p\/)w\d+/, "$1w92").replace(/([?&]maxWidth=)\d+/, (_, head) => `${head}96`) : url);

  const hide = async (descriptor) => {
    const entry = {
      scope: descriptor.scope,
      key: descriptor.keys[0],
      title: descriptor.title,
      year: descriptor.year || null,
      kind: descriptor.kind || null,
      image: thumb(descriptor.image) || null,
      aliases: descriptor.keys.slice(1),
      at: new Date().toISOString(),
    };
    const before = hidden.list || [];
    writeHidden([entry, ...before.filter((e) => !(e.scope === entry.scope && e.key === entry.key))]);
    try {
      writeHidden(await kit.hera("hidden", { method: "POST", body: entry }));
    } catch (error) {
      writeHidden(before);
      throw error;
    }
  };

  const unhide = async (entry) => {
    const before = hidden.list || [];
    writeHidden(before.filter((e) => !(e.scope === entry.scope && e.key === entry.key)));
    try {
      writeHidden(await kit.hera("hidden", { method: "DELETE", query: { scope: entry.scope, key: entry.key } }));
    } catch (error) {
      writeHidden(before);
      throw error;
    }
  };

  const SCOPE_TEXT = {
    upnext: { action: "Remove from Up Next", icon: "playlist_remove", done: "Removed from Up Next", where: "Removed from Up Next" },
    interest: { action: "Not Interested", icon: "visibility_off", done: "Hidden", where: "Not Interested" },
  };

  const tmdbKey = (item) => (item?.tmdbId && item.mediaType ? `tmdb:${item.mediaType}:${item.tmdbId}` : null);

  /** What a card stands for, when it can be hidden: { scope, keys, title, year, kind, image }. */
  const describe = (card) => {
    if (card.heraHide) return card.heraHide;
    const item = card.heraItem;
    if (!item?.title || !card.closest(".hera-discover, .hera-search, [data-hera-row]") || card.closest(".hera-sheet, .hera-seerr")) return null;
    const keys = [tmdbKey(item), item.jellyfinId ? plainId(item.jellyfinId) : null].filter(Boolean);
    if (!keys.length) return null;
    return {
      scope: "interest",
      keys,
      title: item.title,
      year: item.year ? String(item.year) : null,
      kind: item.mediaType === "tv" ? "TV Show" : "Film",
      image: item.poster || null,
    };
  };

  // The element that leaves a row when its title is hidden: Up Next wraps its card.
  const cellOf = (card) => card.closest(".hera-upnext") || card;

  // A row with nothing left to show leaves with its last card. `rows` collects the rows a batch touched so each is judged once.
  const syncRow = (row) => {
    for (const card of row.querySelectorAll(".hera-card")) {
      if (!cellOf(card).hidden) {
        row.hidden = false;
        return;
      }
    }
    row.hidden = true;
  };

  const setCellHidden = (cell, off, rows) => {
    cell.hidden = off;
    cell.classList.toggle("hera-card--hidden", off);
    const row = cell.closest(".hera-row");
    if (!row) return;
    if (rows) rows.add(row);
    else syncRow(row);
  };

  /** Hides what the person has already hidden: Discover and search build cards without asking. */
  const filterCards = (root) => {
    if (!hidden.list?.length) return;
    const cards = root.matches?.(".hera-card") ? [root] : [...(root.querySelectorAll?.(".hera-card") || [])];
    const rows = new Set();
    for (const card of cards) {
      const descriptor = describe(card);
      if (!descriptor || descriptor.scope !== "interest") continue;
      if (hiddenEntry("interest", descriptor.keys)) setCellHidden(cellOf(card), true, rows);
    }
    rows.forEach(syncRow);
  };

  // ---------- toast ---------------------------------------------------------------------------

  let toast = null;
  let toastTimer = 0;

  const say = (message, undo) => {
    clearTimeout(toastTimer);
    toast?.remove();
    const node = el("div", { class: "hera-toast", role: "status" }, [
      el("span", { class: "hera-toast__text", text: message }),
      undo ? el("button", { class: "hera-toast__undo", type: "button", text: "Undo", onclick: () => { dismiss(); undo(); } }) : null,
    ]);
    const dismiss = () => {
      clearTimeout(toastTimer);
      node.classList.remove("is-in");
      setTimeout(() => node.remove(), 240);
      if (toast === node) toast = null;
    };
    toast = node;
    document.body.append(node);
    requestAnimationFrame(() => node.classList.add("is-in"));
    toastTimer = setTimeout(dismiss, UNDO_MS);
  };

  const doHide = async (card, descriptor) => {
    const cell = cellOf(card);
    setCellHidden(cell, true);
    try {
      await hide(descriptor);
    } catch (error) {
      console.error("[Hera TV:extras]", error);
      setCellHidden(cell, false);
      say("Couldn't hide that. Check your connection and try again.");
      return;
    }
    const entry = hiddenEntry(descriptor.scope, descriptor.keys);
    say(`${descriptor.title}: ${SCOPE_TEXT[descriptor.scope].done}`, async () => {
      try {
        if (entry) await unhide(entry);
        setCellHidden(cell, false);
      } catch (error) {
        console.error("[Hera TV:extras]", error);
        say("Couldn't undo that. Open Settings > Home > Hidden Titles to unhide it.");
      }
    });
  };

  // ---------- menu ----------------------------------------------------------------------------

  const menu = { node: null, opener: null, off: null };

  const closeMenu = ({ restore = true } = {}) => {
    if (!menu.node) return;
    menu.node.remove();
    menu.off?.();
    const opener = menu.opener;
    menu.node = menu.opener = menu.off = null;
    if (restore && opener?.isConnected) opener.focus({ preventScroll: true });
  };

  /** A small glass menu at a point or beside a rectangle. Items: { label, icon, onSelect }. */
  const openMenu = ({ at, rect, opener, items }) => {
    closeMenu({ restore: false });
    const buttons = items.map((item) =>
      el("button", { class: "hera-menu__item", type: "button", role: "menuitem", onclick: () => { closeMenu(); item.onSelect(); } }, [icon(item.icon), el("span", { text: item.label })]),
    );
    const node = el("div", { class: "hera-menu", role: "menu" }, buttons);
    document.body.append(node);
    const box = node.getBoundingClientRect();
    let x = at ? at.x : rect.right - box.width;
    let y = at ? at.y : rect.bottom + 6;
    x = Math.max(8, Math.min(x, window.innerWidth - box.width - 8));
    if (y + box.height > window.innerHeight - 8) y = Math.max(8, (rect ? rect.top - 6 : y) - box.height);
    node.style.left = `${Math.round(x)}px`;
    node.style.top = `${Math.round(y)}px`;
    menu.node = node;
    menu.opener = opener || null;
    const menuScope = kit.scope();
    const away = (event) => {
      if (!node.contains(event.target)) closeMenu({ restore: false });
    };
    const keys = (event) => {
      if (kit.keys.isBack(event)) {
        event.preventDefault();
        event.stopPropagation();
        closeMenu();
      } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        const at = buttons.indexOf(document.activeElement);
        buttons[(at + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length].focus();
      } else if (event.key === "Tab") {
        closeMenu({ restore: false });
      }
    };
    // The click that opened the menu is still travelling; listen for the next press.
    const armed = setTimeout(() => menuScope.listen(document, "pointerdown", away, { capture: true }), 0);
    menuScope.add(() => clearTimeout(armed));
    menuScope.listen(document, "keydown", keys, { capture: true });
    menuScope.listen(window, "scroll", () => closeMenu({ restore: false }), { passive: true, once: true });
    menu.off = () => menuScope.dispose();
    buttons[0].focus({ preventScroll: true });
  };

  const menuFor = (card, descriptor, anchor) => {
    const text = SCOPE_TEXT[descriptor.scope];
    const items = [...(descriptor.extra || []), { label: text.action, icon: text.icon, onSelect: () => doHide(card, descriptor) }];
    openMenu({ ...anchor, opener: card, items });
  };

  // ---------- the "more" button that follows the pointer --------------------------------------
  // One floating button serves every eligible card, so cards need no markup of their own and a
  // card's link or button never holds another button.

  const more = { node: null, card: null, timer: 0 };

  const placeMore = (card) => {
    const art = card.querySelector(".hera-card__art") || card;
    const box = art.getBoundingClientRect();
    more.node.style.left = `${Math.round(box.right - 8 - 32)}px`;
    more.node.style.top = `${Math.round(box.top + 8)}px`;
  };

  const hideMore = () => {
    clearTimeout(more.timer);
    more.card = null;
    more.node?.classList.remove("is-on");
  };

  const showMore = (card) => {
    if (!more.node || kit.isTv()) return;
    const descriptor = describe(card);
    if (!descriptor || cellOf(card).hidden) return;
    clearTimeout(more.timer);
    more.card = card;
    more.node.setAttribute("aria-label", `${SCOPE_TEXT[descriptor.scope].action}: ${descriptor.title}`);
    placeMore(card);
    more.node.classList.add("is-on");
  };

  const mountMore = () => {
    more.node = el("button", { class: "hera-more hera-dark", type: "button", tabindex: "-1", "aria-hidden": "true", title: "More" }, icon("more_horiz"));
    more.node.addEventListener("click", (event) => {
      event.preventDefault();
      const card = more.card;
      const descriptor = card && describe(card);
      if (!descriptor) return;
      menuFor(card, descriptor, { rect: more.node.getBoundingClientRect() });
    });
    document.body.append(more.node);

    const cardAt = (target) => target?.closest?.(".hera-card");
    const over = (event) => {
      if (event.pointerType === "touch") return;
      const card = cardAt(event.target);
      if (card && describe(card)) showMore(card);
      else if (!more.node.contains(event.target) && more.card) {
        clearTimeout(more.timer);
        more.timer = setTimeout(hideMore, 120);
      }
    };
    const out = (event) => {
      if (!more.card || more.node.contains(event.relatedTarget) || more.card.contains(event.relatedTarget) || cellOf(more.card).contains(event.relatedTarget)) return;
      clearTimeout(more.timer);
      more.timer = setTimeout(hideMore, 120);
    };
    const focus = (event) => {
      const card = cardAt(event.target);
      if (card && describe(card) && event.target.matches?.(":focus-visible")) showMore(card);
    };
    const blur = (event) => {
      if (event.relatedTarget === more.node) return;
      hideMore();
    };
    // A scroll event arrives for every scroller on the page, shelves included; the button is
    // placed once a frame, and only while it is showing.
    let moveQueued = false;
    const reposition = () => {
      if (moveQueued || !more.card) return;
      moveQueued = true;
      requestAnimationFrame(() => {
        moveQueued = false;
        if (more.card?.isConnected) placeMore(more.card);
        else hideMore();
      });
    };
    // The shelves scroll inside themselves; capture sees those scrolls too.
    scope.listen(document, "pointerover", over, { capture: true });
    scope.listen(document, "pointerout", out, { capture: true });
    scope.listen(document, "focusin", focus, { capture: true });
    scope.listen(document, "focusout", blur, { capture: true });
    scope.listen(window, "scroll", reposition, { passive: true, capture: true });
    scope.add(() => {
      clearTimeout(more.timer);
      more.node?.remove();
      more.node = null;
    });
  };

  /** Where a card's menu opens from when there is no pointer: over its artwork, a little in from the right. */
  const anchorOf = (card) => {
    const rect = (card.querySelector(".hera-card__art") || card).getBoundingClientRect();
    return { rect: { right: rect.left + rect.width * 0.7, bottom: rect.top + rect.height * 0.5, top: rect.top } };
  };

  // Right-click, the keyboard's Menu key and Shift+F10 all raise a `contextmenu` event on the card.
  const onContextMenu = (event) => {
    const card = event.target.closest?.(".hera-card");
    const descriptor = card && describe(card);
    if (!descriptor || cellOf(card).hidden) return;
    event.preventDefault();
    const fromKeyboard = event.clientX === 0 && event.clientY === 0;
    menuFor(card, descriptor, fromKeyboard ? anchorOf(card) : { at: { x: event.clientX, y: event.clientY } });
  };

  // A remote has no pointer: holding OK on a card opens the same menu. (Up Next's cards do their
  // own, in hera-home.js, because their short press plays.)
  const press = { timer: 0, card: null, fired: false };
  const onPressStart = (event) => {
    if (!kit.isTv() || event.key !== "Enter" || event.repeat) return;
    const card = event.target.closest?.(".hera-card");
    const descriptor = card && !card.closest(".hera-upnext") && describe(card);
    if (!descriptor) return;
    press.fired = false;
    press.card = card;
    press.timer = setTimeout(() => {
      press.fired = true;
      menuFor(card, descriptor, anchorOf(card));
    }, LONG_PRESS_MS);
    event.preventDefault();
  };
  const onPressEnd = (event) => {
    if (!press.timer || event.key !== "Enter") return;
    clearTimeout(press.timer);
    press.timer = 0;
    if (!press.fired) press.card?.click();
    press.card = null;
  };

  // ---------- quality badges on cards ---------------------------------------------------------

  const cardId = (card) => {
    if (card.dataset.id) return plainId(card.dataset.id);
    const href = card.getAttribute("href");
    if (href) return plainId(new URLSearchParams(href.split("?")[1] || "").get("id"));
    return card.heraId ? plainId(card.heraId) : null;
  };

  const paintCard = (card, badges) => {
    const art = card.querySelector(".hera-card__art") || kit.jf(MODULE, "extrasCardArt", card);
    if (!art) return;
    art.querySelector(":scope > .hera-quality")?.remove();
    const shown = CARD_ORDER.filter((key) => badges.includes(key) && !(key === "hdr" && badges.includes("dv")));
    if (!shown.length) return;
    const node = el("span", { class: "hera-quality hera-dark", "aria-label": shown.map((key) => BADGE_LABEL[key]).join(", ") }, shown.map((key) => el("span", { class: "hera-quality__chip", "aria-hidden": "true", text: CARD_LABEL[key] })));
    if (art.querySelector(".hera-card__progress") || kit.jf(MODULE, "extrasCardProgress", art)) node.classList.add("hera-quality--raised");
    art.append(node);
  };

  const paintId = (id, badges) => {
    for (const card of document.querySelectorAll(`[data-hera-qid="${id}"]`)) paintCard(card, badges);
  };

  const flushBadges = async () => {
    state.badgeTimer = 0;
    const user = kit.userId();
    const ids = [...state.badgeQueue];
    state.badgeQueue.clear();
    if (!ids.length || (await features()).qualityBadges === false) return;
    for (let at = 0; at < ids.length; at += BADGE_BATCH) {
      const chunk = ids.slice(at, at + BADGE_BATCH);
      // One request per chunk, sent only if a title in it is not already held.
      let request = null;
      const fetchChunk = () => {
        request = request || Promise.resolve(kit.hera("extras/badges", { query: { ids: chunk.join(",") } }));
        return request;
      };
      try {
        const painting = Promise.all(
          chunk.map(async (id) => {
            const badges = await badgeCache.get(id, async () => ((await fetchChunk()) || {})[id] || []);
            if (user === kit.userId()) paintId(id, badges);
          }),
        );
        kit.track(MODULE, painting);
        await painting;
      } catch (error) {
        console.warn("[Hera TV:extras] badges", error);
      }
      if (user !== kit.userId()) {
        badgeCache.clear();
        return;
      }
    }
  };

  const queueBadges = (id) => {
    const held = badgeCache.peek(id);
    if (held) {
      paintId(id, held);
      return;
    }
    state.badgeQueue.add(id);
    if (!state.badgeTimer) state.badgeTimer = setTimeout(flushBadges, 80);
  };

  const watchCard = (card) => {
    if (card.dataset.heraQid) return;
    const id = cardId(card);
    if (!id) return;
    card.dataset.heraQid = id;
    const held = badgeCache.peek(id);
    if (held) paintCard(card, held);
    state.badgeObserver?.observe(card);
  };

  const scan = (root) => {
    // `jf` is read for the plain selector here: one added node is tested with matches(), which a
    // lookup by key cannot do.
    if (root.matches?.(HERA_CARDS) || root.matches?.(jf.extrasStockCards)) watchCard(root);
    for (const card of root.querySelectorAll?.(HERA_CARDS) || []) watchCard(card);
    for (const card of kit.jfAll(MODULE, "extrasStockCards", root)) watchCard(card);
    filterCards(root);
  };

  const startCards = async (mine) => {
    const flags = await features();
    if (scope !== mine) return;
    if (flags.qualityBadges !== false) {
      const io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            io.unobserve(entry.target);
            queueBadges(entry.target.dataset.heraQid);
          }
        },
        { rootMargin: "240px 400px" },
      );
      state.badgeObserver = io;
      mine.add(() => {
        io.disconnect();
        state.badgeObserver = null;
      });
    }
    const pending = new Set();
    let queued = false;
    const mutations = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) pending.add(node);
      if (queued || !pending.size) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        const nodes = [...pending];
        pending.clear();
        if (scope !== mine) return;
        for (const node of nodes) if (node.isConnected) scan(node);
      });
    });
    mutations.observe(document.body, { childList: true, subtree: true });
    mine.add(() => mutations.disconnect());
    scan(document.body);
  };

  // ---------- detail pages --------------------------------------------------------------------

  const extrasFor = (id) => {
    const request = extrasCache.get(id, () => kit.hera(`extras/${id}`));
    kit.track(DETAIL, request);
    return request.catch((error) => {
      console.warn("[Hera TV:extras] extras", error);
      return null;
    });
  };

  const ratingText = (value) => `${value}%`;

  // Rotten Tomatoes' own marks, drawn in one colour on a 24-unit grid: the Tomatometer's tomato
  // (fresh) or splat (rotten), the Popcornmeter's bucket upright and full or tipped over with its
  // popcorn spilled.
  const BUCKET = "M4.4 11h15.2v2.2H4.4zM5 13.8h3.4l.6 8.2H6.4zM10.3 13.8h3.4l-.2 8.2h-3zM15.6 13.8H19l-1.4 8.2H15z";
  const GLYPHS = {
    fresh: [{ d: "M12 5.6c4.9 0 8.8 3.4 8.8 7.9S16.9 21.6 12 21.6s-8.8-3.6-8.8-8.1S7.1 5.6 12 5.6zM12 6.18L13 8.55L16.95 8.4L13.62 9.73L15.06 12.01L12 10.45L8.94 12.01L10.38 9.73L7.05 8.4L11 8.55z", "fill-rule": "evenodd" }],
    rotten: [{ d: "M12.4 3.6l1.6 4.2 3.6-2.7-.9 4.4 4.5.2-3.7 2.6 3.4 2.9-4.5.3 1.3 4.3-3.8-2.4-.9 4.4-2.1-4-3.1 3.3.2-4.5-4.4 1 2.6-3.6L2.2 12l4.3-1.3-2.4-3.8 4.3 1.4z" }],
    upright: [{ d: "M5 10.2a2.6 2.6 0 0 1 1.1-4.8a2.5 2.5 0 0 1 3.6-3a2.7 2.7 0 0 1 4.6 0a2.5 2.5 0 0 1 3.6 3A2.6 2.6 0 0 1 19 10.2z" }, { d: BUCKET }],
    spilled: [{ d: BUCKET, transform: "translate(3 -1) rotate(-100 12 16)" }, { d: "M3 18.5a2.1 2.1 0 1 1 0 4.2a2.1 2.1 0 1 1 0-4.2zM7.4 20a1.6 1.6 0 1 1 0 3.2a1.6 1.6 0 1 1 0-3.2zM3.8 14.1a1.7 1.7 0 1 1 0 3.4a1.7 1.7 0 1 1 0-3.4z" }],
  };
  const SVG_NS = "http://www.w3.org/2000/svg";
  const glyph = (name) => {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "hera-rating__icon");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    for (const attrs of GLYPHS[name]) {
      const path = document.createElementNS(SVG_NS, "path");
      for (const [key, value] of Object.entries(attrs)) path.setAttribute(key, value);
      svg.append(path);
    }
    return svg;
  };

  const ratingsNode = (ratings) => {
    const parts = [];
    if (ratings.imdb?.score != null) {
      const votes = ratings.imdb.votes ? ` from ${ratings.imdb.votes.toLocaleString()} votes` : "";
      parts.push(
        el("span", { class: "hera-rating", title: `IMDb rating ${ratings.imdb.score.toFixed(1)}${votes}`, "aria-label": `IMDb rating ${ratings.imdb.score.toFixed(1)} out of 10` }, [
          el("span", { class: "hera-rating__mark", "aria-hidden": "true", text: "IMDb" }),
          el("span", { text: ratings.imdb.score.toFixed(1) }),
        ]),
      );
    }
    const rt = ratings.rt;
    if (rt?.critics) {
      parts.push(
        el("span", { class: "hera-rating", title: `Rotten Tomatoes critics ${ratingText(rt.critics.score)}, ${rt.critics.fresh ? "fresh" : "rotten"}`, "aria-label": `Rotten Tomatoes critics ${ratingText(rt.critics.score)}, ${rt.critics.fresh ? "fresh" : "rotten"}` }, [
          glyph(rt.critics.fresh ? "fresh" : "rotten"),
          el("span", { text: ratingText(rt.critics.score) }),
        ]),
      );
    }
    if (rt?.audience) {
      parts.push(
        el("span", { class: "hera-rating", title: `Rotten Tomatoes audience ${ratingText(rt.audience.score)}, ${rt.audience.fresh ? "upright" : "spilled"}`, "aria-label": `Rotten Tomatoes audience ${ratingText(rt.audience.score)}, ${rt.audience.fresh ? "upright" : "spilled"}` }, [
          glyph(rt.audience.fresh ? "upright" : "spilled"),
          el("span", { text: ratingText(rt.audience.score) }),
        ]),
      );
    }
    return parts.length ? el("div", { class: "mediaInfoItem hera-xmeta hera-ratings" }, parts) : null;
  };

  const qualityNode = (badges) =>
    badges?.length
      ? el(
          "div",
          { class: "mediaInfoItem hera-xmeta hera-qualities", "aria-label": badges.map((key) => BADGE_LABEL[key]).join(", ") },
          badges.map((key) => el("span", { class: "hera-chip", "aria-hidden": "true", text: BADGE_LABEL[key] })),
        )
      : null;

  const elsewhereNode = (providers) => {
    if (!providers?.streaming?.length) return null;
    const logos = providers.streaming.map((provider) => {
      const logo = el("img", { src: provider.logo, alt: provider.name, loading: "lazy", decoding: "async" });
      return el("li", {}, el("a", { class: "hera-provider", href: providers.link || "https://www.themoviedb.org/", target: "_blank", rel: "noopener noreferrer", title: `Watch on ${provider.name}`, "aria-label": `Watch on ${provider.name}` }, logo));
    });
    return el("section", { class: "hera-elsewhere", "aria-label": "Also on" }, [
      el("h3", { class: "hera-elsewhere__title", text: "Also on" }),
      el("ul", { class: "hera-elsewhere__list" }, logos),
      el("a", { class: "hera-elsewhere__source", href: providers.link || "https://www.themoviedb.org/", target: "_blank", rel: "noopener noreferrer", text: "Streaming data from JustWatch" }),
    ]);
  };

  const clearDetail = () => {
    state.detail?.observer?.disconnect();
    state.detail = null;
    document.querySelectorAll(".hera-xmeta, .hera-elsewhere").forEach((node) => node.remove());
    document.querySelectorAll(".hera-meta-ratings").forEach((node) => node.classList.remove("hera-meta-ratings"));
  };

  const paintDetail = (page, data) => {
    const meta = kit.jf(DETAIL, "detailMisc", page);
    if (meta) {
      meta.querySelectorAll(".hera-xmeta").forEach((node) => node.remove());
      const ratings = data.ratings ? ratingsNode(data.ratings) : null;
      const quality = qualityNode(data.badges);
      const before = kit.jf(DETAIL, "extrasEndsAt", meta);
      for (const node of [ratings, quality]) {
        if (!node) continue;
        if (before) meta.insertBefore(node, before);
        else meta.append(node);
      }
      // Our scores stand in for the stock TMDB star and critic score.
      meta.classList.toggle("hera-meta-ratings", !!ratings);
    }
    const section = kit.jf(DETAIL, "extrasDetailContent", page);
    page.querySelectorAll(".hera-elsewhere").forEach((node) => node.remove());
    const elsewhere = data.providers ? elsewhereNode(data.providers) : null;
    if (section && elsewhere) section.prepend(elsewhere);
  };

  const mountDetail = async (page, id) => {
    if (!id) return;
    if (state.detail?.page === page && state.detail.id === id && page.querySelector(".hera-xmeta, .hera-elsewhere")) return;
    clearDetail();
    const run = ++state.run;
    // A newer visit, another page or a teardown makes this answer stale.
    const current = () => run === state.run && isShown(page) && plainId(kit.itemIdFromHash()) === plainId(id);
    const data = await extrasFor(plainId(id));
    if (!data || !current()) return;
    const flags = await features();
    if (!current()) return;
    const shown = {
      badges: flags.qualityBadges === false ? [] : data.badges,
      ratings: flags.ratings === false ? null : data.ratings,
      providers: flags.elsewhere === false ? null : data.providers,
    };
    paintDetail(page, shown);
    // Jellyfin draws the meta line again when the item reloads (a played mark, a refreshed rating).
    const meta = kit.jf(DETAIL, "detailMisc", page);
    const observer = new MutationObserver(() => {
      if (meta.querySelector(".hera-xmeta") || (!shown.ratings && !shown.badges?.length)) return;
      observer.disconnect();
      paintDetail(page, shown);
      observer.observe(meta, { childList: true });
    });
    if (meta) observer.observe(meta, { childList: true });
    state.detail = { page, id, observer };
  };

  // ---------- Settings > Home: hidden titles --------------------------------------------------

  /** A grouped list for the Settings app: each hidden title with an Unhide on its row. */
  const settingsGroup = () => {
    const list = el("div", { class: "hera-set-list" });
    const node = el("section", { class: "hera-set-group", "aria-label": "Hidden Titles" }, [
      el("h2", { class: "hera-set-group__title", text: "Hidden Titles" }),
      list,
      el("p", { class: "hera-set-group__foot", text: "Titles you remove from Up Next or mark Not Interested stay out of Home, Discover and search until you unhide them." }),
    ]);
    const empty = () => el("div", { class: "hera-set-row hera-set-row--static" }, el("span", { class: "hera-set-row__text" }, el("span", { class: "hera-set-row__desc", text: "Nothing is hidden." })));
    const render = (entries) => {
      if (!entries.length) {
        list.replaceChildren(empty());
        return;
      }
      list.replaceChildren(
        ...entries.map((entry) => {
          const detail = [SCOPE_TEXT[entry.scope]?.where, entry.kind, entry.year].filter(Boolean).join(" · ");
          const art = thumb(entry.image);
          const row = el("button", { class: "hera-set-row hera-hidden-row", type: "button", "aria-label": `Unhide ${entry.title}` }, [
            el("span", { class: "hera-set-row__icon" }, art ? el("img", { class: "hera-hidden-row__art", src: art, alt: "", width: "32", height: "48", loading: "lazy", decoding: "async" }) : icon("visibility_off")),
            el("span", { class: "hera-set-row__text" }, [el("span", { class: "hera-set-row__label", text: entry.title }), el("span", { class: "hera-set-row__desc", text: detail })]),
            el("span", { class: "hera-set-row__value", text: "Unhide" }),
          ]);
          row.addEventListener("click", async () => {
            row.disabled = true;
            try {
              await unhide(entry);
              // Only this row goes; the others keep their images and their place.
              const next = row.nextElementSibling || row.previousElementSibling;
              row.remove();
              if (!list.children.length) list.replaceChildren(empty());
              else next?.focus({ preventScroll: true });
            } catch (error) {
              console.error("[Hera TV:extras]", error);
              row.disabled = false;
              row.querySelector(".hera-set-row__value").textContent = "Try again";
            }
          });
          return row;
        }),
      );
    };
    list.replaceChildren(el("div", { class: "hera-set-row hera-set-row--static" }, el("span", { class: "hera-set-row__text" }, el("span", { class: "hera-set-row__desc", text: "Loading…" }))));
    loadHidden().then((entries) => node.isConnected !== false && render(entries));
    return node;
  };

  const hiddenApi = {
    /** Resolves once this user's hidden titles are known. */
    ready: loadHidden,
    /** The entry hiding a title in `scope` ("upnext" or "interest") by any of `keys`, or null. */
    match: hiddenEntry,
    settingsGroup,
    /** Opens a card's menu over its artwork (a remote's long press); false when the card has none. */
    menu(card) {
      const descriptor = describe(card);
      if (!descriptor) return false;
      menuFor(card, descriptor, anchorOf(card));
      return true;
    },
  };

  // ---------- module --------------------------------------------------------------------------

  const watchCards = () => {
    if (scope) return;
    const mine = kit.scope();
    scope = mine;
    mountMore();
    mine.listen(document, "contextmenu", onContextMenu);
    kit.intercept(MODULE, document, "keydown", onPressStart);
    kit.intercept(MODULE, document, "keyup", onPressEnd);
    mine.add(() => {
      clearTimeout(press.timer);
      press.timer = 0;
      press.card = null;
    });
    loadHidden().then(() => scope === mine && scan(document.body));
    const cards = startCards(mine);
    kit.track(MODULE, cards);
    cards.catch((error) => console.error("[Hera TV:extras]", error));
  };

  // Two modules, so that a detail page Jellyfin has redrawn costs only the detail page's extras
  // (the ratings, quality and where-to-watch), not the badges on cards or hidden titles.
  heraTv.register({
    name: MODULE,
    // The namespace home, Discover and Settings call is offered by start(): a module switched off
    // in the plugin's settings offers none, and they fall back to showing everything.
    start() {
      heraTv.hidden = hiddenApi;
    },
    onView() {
      applyDefaults();
      watchCards();
    },
    teardown() {
      scope?.dispose();
      scope = null;
      clearTimeout(state.badgeTimer);
      state.badgeTimer = 0;
      state.badgeQueue.clear();
      closeMenu({ restore: false });
      toast?.remove();
      document.querySelectorAll(".hera-quality").forEach((node) => node.remove());
      document.querySelectorAll("[data-hera-qid]").forEach((node) => delete node.dataset.heraQid);
      document.querySelectorAll(".hera-card--hidden").forEach((cell) => {
        cell.hidden = false;
        cell.classList.remove("hera-card--hidden");
      });
      delete heraTv.hidden;
    },
  });

  heraTv.register({
    name: DETAIL,
    // The ratings and quality badges join the meta line; without it there is nothing to join.
    requires: { itemDetailPage: ["detailMisc"] },
    onView(page, { itemId }) {
      if (page.id === "itemDetailPage") {
        mountDetail(page, itemId).catch((error) => console.error("[Hera TV:extras]", error));
      } else {
        clearDetail();
      }
    },
    teardown() {
      state.run++;
      clearDetail();
    },
  });
})();
