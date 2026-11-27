/*
 * Hera TV: notifications. Registers with window.HeraTV (hera-tv.js).
 * What the server has to tell this person, from GET /HeraTV/notifications:
 *  - a bell in the header, with the unread count, that opens a glass panel under it (Control
 *    Center's material and motion) listing the notices as Today, This Week and Earlier;
 *  - "New" on the cards and the detail page of the titles that unread notices name.
 * Notices are the person's own and are only seen while Jellyfin is open: the bell polls every two
 * minutes while the tab is visible, and straight away when it comes back to the front.
 * The bell stands aside (reported as partial) when the header has no search button to sit beside.
 * Borrowed Jellyfin classes: the bell wears MuiIconButton-root / headerButton, the detail chip
 * mediaInfoItem. Cards are found through HT.jf (notifyCard, notifyCardArt) and Hera's own
 * `.hera-card`/`.hera-episode`, whose `heraId` expando carries a card's item id. hera-notify.css
 * expects hera-tv.css's scheme tokens and `.hera-dark`.
 */
(() => {
  "use strict";

  const HT = window.HeraTV;
  if (!HT?.kit) return;
  const { kit } = HT;
  const { el, icon } = kit;

  const POLL_MS = 2 * 60 * 1000;
  // Focus and visibility changes arrive together; one fetch serves both.
  const MIN_GAP_MS = 4000;
  const LIMIT = 50;
  const POSTERS = 5;
  const DAY_MS = 86400000;
  const COUNT_CAP = 9;
  const PHOTO_WIDTH = { wide: 288, poster: 140, mini: 120 };

  const plainId = (id) => String(id || "").replace(/-/g, "").toLowerCase();

  // ---------- wording -------------------------------------------------------------------------

  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

  // "3 Nov", with the year once it isn't this one.
  const dateText = (then, now) =>
    then.toLocaleDateString(undefined, { day: "numeric", month: "short", year: then.getFullYear() === now.getFullYear() ? undefined : "numeric" });

  /** "Just now", "12 min ago", "2 hr ago", "Yesterday", "3 days ago", then the date. */
  const ago = (iso, now) => {
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return "";
    const minutes = Math.floor(Math.max(0, now - then) / 60000);
    if (minutes < 1) return "Just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.round((startOfDay(now) - startOfDay(then)) / DAY_MS);
    if (days <= 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;
    return dateText(then, now);
  };

  const GROUPS = ["Today", "This Week", "Earlier"];

  const groupOf = (iso, now) => {
    const at = new Date(iso).getTime();
    const today = startOfDay(now);
    if (!(at < today)) return 0;
    return at >= today - 6 * DAY_MS ? 1 : 2;
  };

  const jf = HT.jf;

  // ---------- pieces ----------------------------------------------------------------------------

  const REQUEST_GLYPHS = [
    [/ready to watch$/i, "play_circle"],
    [/is downloading$/i, "downloading"],
    [/was approved$/i, "check_circle"],
    [/was declined$/i, "block"],
  ];

  const glyphFor = (notice) => {
    if (notice.kind === "episode") return "tv";
    if (notice.kind === "arrivals") return "new_releases";
    return REQUEST_GLYPHS.find(([pattern]) => pattern.test(notice.title || ""))?.[1] || "playlist_add_check";
  };

  /**
   * Artwork in a frame that already shows the notice's glyph, so a title without a picture, or a
   * picture that fails, still has something there. Wide art tries the thumb, then the backdrop,
   * then the poster.
   */
  const art = ({ id, shape, glyph, className }) => {
    const frame = el("span", { class: `${className} ${className}--${shape}`, "aria-hidden": "true" }, icon(glyph));
    if (!id) return frame;
    const types = shape === "wide" ? ["Thumb", "Backdrop", "Primary"] : ["Primary"];
    const width = PHOTO_WIDTH[shape] || PHOTO_WIDTH.wide;
    const img = el("img", { alt: "", loading: "lazy", decoding: "async" });
    let tried = 0;
    const next = () => {
      if (tried >= types.length) {
        img.remove();
        return;
      }
      img.src = kit.imageUrl(id, types[tried++], { maxWidth: width });
    };
    img.addEventListener("error", next);
    next();
    frame.append(img);
    return frame;
  };

  const targetOf = (notice) => notice.url || (notice.itemId ? `#/details?id=${notice.itemId}` : null);

  let sequence = 0;

  const noticeNode = (notice, now, opts) => {
    const href = targetOf(notice);
    const wide = notice.kind !== "request";
    const mainId = notice.imageId || notice.itemId || notice.items?.[0]?.id || null;
    const time = el("time", {
      class: "hera-nt__time",
      datetime: notice.createdAt,
      title: new Date(notice.createdAt).toLocaleString(),
      text: ago(notice.createdAt, now),
    });
    const children = [
      art({ id: mainId, shape: wide ? "wide" : "poster", glyph: glyphFor(notice), className: "hera-nt__art" }),
      el("span", { class: "hera-nt__text" }, [
        notice.read ? null : el("span", { class: "hera-nt__sr", text: "Unread. " }),
        el("span", { class: "hera-nt__name", text: notice.title }),
        notice.body ? el("span", { class: "hera-nt__desc", text: notice.body }) : null,
        time,
      ]),
      notice.read ? null : el("span", { class: "hera-nt__dot", "aria-hidden": "true" }),
    ];
    const external = href && !href.startsWith("#");
    const main = el(href ? "a" : "button", {
      class: "hera-nt__item",
      href,
      type: href ? null : "button",
      target: external ? "_blank" : null,
      rel: external ? "noopener noreferrer" : null,
    }, children);
    main.addEventListener("click", () => opts.onOpen?.(notice, { href }));

    const posters = (notice.items || []).slice(0, POSTERS);
    const more = (notice.items?.length || 0) - posters.length;
    const strip = posters.length
      ? el("ul", { class: "hera-nt__posters", "aria-label": "Added" }, [
          ...posters.map((item) => {
            const itemHref = `#/details?id=${item.id}`;
            const link = el("a", { class: "hera-nt__poster", href: itemHref, "aria-label": item.name, title: item.name }, art({ id: item.id, shape: "mini", glyph: item.type === "Series" ? "tv" : "movie", className: "hera-nt__mini" }));
            link.addEventListener("click", () => opts.onOpen?.(notice, { href: itemHref }));
            return el("li", {}, link);
          }),
          more > 0 ? el("li", { class: "hera-nt__more", text: `+${more}` }) : null,
        ])
      : null;

    return el("li", { class: `hera-nt__notice${notice.read ? "" : " is-unread"}${strip ? " has-posters" : ""}`, "data-nt-row": "", "data-nid": notice.id }, [main, strip]);
  };

  // The panel scrolls under its title row, so the title stays where the bell's menu was opened.
  const frame = (panel, { unread = 0, onMarkAll } = {}) => {
    panel.classList.add("hera-nt__panel");
    panel.setAttribute("tabindex", "-1");
    const markAll =
      unread > 0
        ? el("button", { type: "button", class: "hera-nt__markall", text: "Mark all as read" })
        : null;
    markAll?.addEventListener("click", () => onMarkAll?.());
    const head = el("header", { class: "hera-nt__head" }, [
      el("h2", { class: "hera-nt__title", text: "Notifications" }),
      markAll ? el("div", { class: "hera-nt__headrow", "data-nt-row": "" }, markAll) : null,
    ]);
    const body = el("div", { class: "hera-nt__body" });
    panel.replaceChildren(head, body);
    if (!panel.heraKeys) {
      panel.heraKeys = true;
      panel.addEventListener("keydown", onKeys);
    }
    return body;
  };

  // Up and Down walk the notices; Left and Right step along one that has posters. A remote's pad
  // sends the same keys, so the panel needs nothing more for a TV.
  const KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

  function onKeys(event) {
    if (!KEYS.has(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const panel = event.currentTarget;
    const rows = [...panel.querySelectorAll("[data-nt-row]")]
      .map((row) => [...row.querySelectorAll("a[href], button:not([disabled])")])
      .filter((stops) => stops.length);
    if (!rows.length) return;
    event.preventDefault();
    event.stopPropagation();
    const at = rows.findIndex((stops) => stops.includes(document.activeElement));
    const column = at < 0 ? 0 : rows[at].indexOf(document.activeElement);
    let to = null;
    if (event.key === "Home") to = rows[0][0];
    else if (event.key === "End") to = rows[rows.length - 1][0];
    else if (event.key === "ArrowDown") to = rows[Math.min(rows.length - 1, at + 1)][0];
    else if (event.key === "ArrowUp") to = rows[at < 0 ? rows.length - 1 : Math.max(0, at - 1)][0];
    else if (at >= 0) to = rows[at][column + (event.key === "ArrowRight" ? 1 : -1)] || null;
    if (!to) return;
    to.focus({ preventScroll: true });
    // The first notice has its group's heading above it: scroll that into view too.
    const body = panel.querySelector(".hera-nt__body");
    if (body && to === rows.find((stops) => stops[0].closest(".hera-nt__notice"))?.[0]) body.scrollTop = 0;
    else to.scrollIntoView({ block: "nearest" });
  }

  /** The panel's contents from one response; `opts.onOpen(notice, { href })`, `opts.onMarkAll()`. */
  const render = (panel, data, opts = {}) => {
    const now = opts.now || new Date();
    const notices = (data?.notices || []).slice().sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const unread = Number.isFinite(data?.unread) ? data.unread : notices.filter((n) => !n.read).length;
    const body = frame(panel, { unread, onMarkAll: opts.onMarkAll });
    if (!notices.length) {
      body.append(
        el("div", { class: "hera-nt__note", role: "status" }, [
          icon("notifications_none"),
          el("p", { class: "hera-nt__note-text", text: "You're all caught up." }),
        ]),
      );
      return panel;
    }
    const buckets = GROUPS.map(() => []);
    for (const notice of notices) buckets[groupOf(notice.createdAt, now)].push(notice);
    GROUPS.forEach((name, index) => {
      if (!buckets[index].length) return;
      const id = `hera-nt-group-${++sequence}`;
      body.append(
        el("section", { class: "hera-nt__group", "aria-labelledby": id }, [
          el("h3", { class: "hera-nt__heading", id, text: name }),
          el("ul", { class: "hera-nt__list" }, buckets[index].map((notice) => noticeNode(notice, now, opts))),
        ]),
      );
    });
    return panel;
  };

  /** Rows of grey blocks where notices will be, while the first answer is on its way. */
  const loading = (panel) => {
    const body = frame(panel);
    const ghost = (shape) =>
      el("li", { class: "hera-nt__ghost", "aria-hidden": "true" }, [
        el("span", { class: `hera-nt__art hera-nt__art--${shape}` }),
        el("span", { class: "hera-nt__text" }, [el("span", { class: "hera-nt__bar" }), el("span", { class: "hera-nt__bar hera-nt__bar--short" })]),
      ]);
    body.append(
      el("div", { class: "hera-nt__group", role: "status", "aria-busy": "true", "aria-label": "Loading notifications" }, el("ul", { class: "hera-nt__list" }, [ghost("wide"), ghost("poster"), ghost("wide")])),
    );
    return panel;
  };

  /** A quiet failure, with a way to try again. */
  const failed = (panel, onRetry) => {
    const body = frame(panel);
    const retry = el("button", { type: "button", class: "hera-nt__retry", text: "Try again" });
    retry.addEventListener("click", () => onRetry?.());
    body.append(
      el("div", { class: "hera-nt__note", role: "status" }, [
        icon("cloud_off"),
        el("p", { class: "hera-nt__note-text", text: "Couldn't load notifications" }),
        el("div", { "data-nt-row": "" }, retry),
      ]),
    );
    return panel;
  };

  // ---------- state -----------------------------------------------------------------------------

  const state = {
    user: null,
    data: null,
    status: "idle", // idle | loading | ready | failed
    fetchedAt: 0,
    inflight: null,
    run: 0,
    reading: 0,
    news: new Set(),
    bell: null,
    kind: null,
    header: null,
    headerObserver: null,
    headerQueued: false,
    dialog: null,
    panel: null,
    panelKey: "",
    restoreFocus: true,
    focusFirst: false,
    started: false,
    timer: 0,
    cardObserver: null,
    cardQueued: false,
    detail: null,
    warned: false,
  };

  let scope = null; // listeners and route subscription, alive while the module polls

  const idsOf = (notice) => [notice.itemId, notice.imageId, ...(notice.items || []).map((item) => item.id)].filter(Boolean).map(plainId);

  const normalise = (data) => {
    const notices = Array.isArray(data?.notices) ? data.notices : [];
    return {
      unread: Number.isFinite(data?.unread) ? Math.max(0, data.unread) : notices.filter((n) => !n.read).length,
      notices,
      newItems: Array.isArray(data?.newItems) ? data.newItems : [],
    };
  };

  // The panel only needs drawing again when something it shows changed.
  const signature = (data) => data.notices.map((n) => `${n.id}:${n.read ? 1 : 0}`).join(",") + `|${data.unread}`;

  // ---------- the bell --------------------------------------------------------------------------

  /**
   * Where the bell goes: right after the search button, before the profile button, in the modern
   * app bar, or in the TV and legacy layouts' .skinHeader. Whichever header is showing wins; with
   * none (the player, sign-in) or without a search button to sit beside, the bell stands aside.
   * A header that is absent is normal here, so these lookups are not misses.
   */
  const findHost = () => {
    const shown = (node) => node && node.offsetHeight > 0;
    const bar = document.querySelector(jf.appBar);
    const legacyBar = document.querySelector(jf.legacyHeader);
    const modern = bar && kit.jf("notify", "headerSearchButton", bar);
    const legacy = legacyBar && kit.jf("notify", "headerSearchButton", legacyBar);
    const pick = [
      modern && { kind: "modern", anchor: modern, header: bar },
      legacy && { kind: "legacy", anchor: legacy, header: legacyBar },
    ].filter(Boolean);
    const host = pick.find((candidate) => shown(candidate.header)) || null;
    // The profile button's own click opens Control Center: a bell in its box would open that too.
    if (host?.anchor.parentElement?.matches(jf.appBarEnd)) return null;
    return host;
  };

  // The bell wears Jellyfin's own button classes so the header styles it like its neighbours:
  // MuiIconButton-root in the modern app bar, headerButton and friends in the legacy header.
  const buildBell = (kind) => {
    const classes =
      kind === "modern"
        ? "hera-bell MuiIconButton-root"
        : "hera-bell headerButton headerButtonRight paper-icon-button-light show-focus";
    const bell = el(
      "button",
      { type: "button", class: classes, "aria-label": "Notifications", "aria-haspopup": "dialog", "aria-expanded": "false", "data-kind": kind },
      [icon("notifications"), el("span", { class: "hera-bell__count", "aria-hidden": "true", hidden: true })],
    );
    bell.addEventListener("click", (event) => {
      if (state.dialog) closePanel();
      else openPanel({ byKey: event.detail === 0 });
    });
    return bell;
  };

  const paintBell = () => {
    const bell = state.bell;
    if (!bell) return;
    const unread = state.data?.unread || 0;
    const count = bell.querySelector(".hera-bell__count");
    count.hidden = unread < 1;
    count.textContent = unread > COUNT_CAP ? `${COUNT_CAP}+` : String(unread);
    bell.setAttribute("aria-label", unread > 0 ? `Notifications, ${unread} unread` : "Notifications");
  };

  const removeBell = () => {
    closePanel({ restore: false });
    state.headerObserver?.disconnect();
    state.headerObserver = null;
    state.header = null;
    state.bell?.remove();
    state.bell = null;
    state.kind = null;
  };

  const ANCHOR = jf.headerSearchButton;
  const shownHeader = () => [...document.querySelectorAll(`${jf.appBar}, ${jf.legacyHeader}`)].find((node) => node.offsetHeight > 0) || null;

  // Jellyfin draws its header in pieces, and again when the user or layout changes; the bell finds
  // its place again, a few times over if the search button isn't there yet.
  let retryTimer = 0;
  const ensureBell = (attempt = 0) => {
    clearTimeout(retryTimer);
    if (!kit.userId() || !kit.api()) return removeBell();
    const host = findHost();
    if (!host) {
      if (state.bell && !state.bell.isConnected) removeBell();
      // The admin Dashboard's header and the player's never have a search button: no bell there is
      // normal, not a miss.
      if (kit.jf("notify", "dashboardDocument") || kit.jf("notify", "page")?.matches(jf.videoOsdPage)) {
        kit.report("notify", "idle");
        return;
      }
      if (attempt < 8) retryTimer = setTimeout(() => ensureBell(attempt + 1), 500);
      else if (shownHeader() && !state.bell && !state.warned) {
        state.warned = true;
        const detail = `Jellyfin's header has no search button (${ANCHOR}) to sit beside`;
        console.warn(`[Hera TV:notify] standing aside: ${detail}`);
        kit.report("notify", "partial", detail);
      }
      return;
    }
    state.warned = false;
    if (state.bell && state.kind !== host.kind) removeBell();
    if (!state.bell) {
      state.bell = buildBell(host.kind);
      state.kind = host.kind;
    }
    if (state.bell.previousElementSibling !== host.anchor) host.anchor.after(state.bell);
    kit.report("notify", "ok");
    paintBell();
    if (state.header !== host.header) {
      state.headerObserver?.disconnect();
      state.header = host.header;
      state.headerObserver = new MutationObserver(() => {
        if (state.headerQueued) return;
        state.headerQueued = true;
        requestAnimationFrame(() => {
          state.headerQueued = false;
          // The usual redraw leaves the bell where it was; only a lost one needs putting back.
          if (state.bell?.isConnected && state.bell.previousElementSibling?.matches(ANCHOR)) return;
          ensureBell();
        });
      });
      state.headerObserver.observe(host.header, { childList: true, subtree: true });
    }
  };

  // ---------- loading ---------------------------------------------------------------------------

  const accept = (data) => {
    state.data = data;
    state.status = "ready";
    state.news = new Set(data.newItems.map(plainId));
    paintBell();
    syncCards();
    syncDetail();
    if (state.panel && signature(data) !== state.panelKey) paintPanel();
  };

  const load = ({ force = false } = {}) => {
    const user = kit.userId();
    if (!user || !kit.api()) return Promise.resolve(null);
    if (state.inflight) return state.inflight;
    if (!force && Date.now() - state.fetchedAt < MIN_GAP_MS) return Promise.resolve(state.data);
    if (!state.data) {
      state.status = "loading";
      if (state.panel) paintPanel();
    }
    const run = ++state.run;
    const request = Promise.resolve(kit.hera("notifications", { query: { limit: LIMIT } }));
    kit.track("notify", request);
    const pending = request
      .then((data) => {
        // Another account, or a mark-as-read still on its way, makes this answer out of date.
        if (user !== kit.userId() || run !== state.run || state.reading > 0) return state.data;
        accept(normalise(data));
        return state.data;
      })
      .catch((error) => {
        console.warn("[Hera TV:notify]", error);
        // A bell that already has an answer keeps it; the next poll tries again.
        if (!state.data && user === kit.userId()) {
          state.status = "failed";
          if (state.panel) paintPanel();
        }
        return null;
      })
      .finally(() => {
        state.fetchedAt = Date.now();
        if (state.inflight === pending) state.inflight = null;
      });
    state.inflight = pending;
    return pending;
  };

  const retry = () => {
    state.status = state.data ? "ready" : "loading";
    paintPanel();
    load({ force: true }).then(() => state.panel?.querySelector(".hera-nt__item, .hera-nt__retry, .hera-nt__markall")?.focus({ preventScroll: true }));
  };

  /** Marks notices read (all of them with no ids), at once on screen, then on the server. */
  const markRead = async (ids) => {
    const data = state.data;
    if (!data) return;
    const targets = data.notices.filter((n) => !n.read && (!ids || ids.includes(n.id)));
    if (!targets.length && ids) return;
    const named = new Set(targets.flatMap(idsOf));
    targets.forEach((n) => (n.read = true));
    const before = data.unread;
    data.unread = ids ? Math.max(0, data.unread - targets.length) : 0;
    // A title stays New while another unread notice still names it.
    const kept = new Set(data.notices.filter((n) => !n.read).flatMap(idsOf));
    state.news = new Set([...state.news].filter((id) => kept.has(id) || !named.has(id)));
    if (!ids) state.news.clear();
    paintBell();
    syncCards();
    syncDetail();
    if (state.panel) paintPanel();
    // An answer that was already on its way predates this, and must not undo it.
    state.run += 1;
    state.inflight = null;
    state.reading += 1;
    try {
      const answer = await kit.hera("notifications/read", { method: "POST", body: ids ? { ids } : {} });
      if (Number.isFinite(answer?.unread)) data.unread = answer.unread;
      paintBell();
    } catch (error) {
      console.warn("[Hera TV:notify] mark as read", error);
      targets.forEach((n) => (n.read = false));
      data.unread = before;
      state.news = new Set(data.newItems.map(plainId));
      paintBell();
      syncCards();
      syncDetail();
      if (state.panel) paintPanel();
    } finally {
      state.reading -= 1;
      // The server's own list settles anything this guessed.
      if (state.reading === 0) load({ force: true });
    }
  };

  // ---------- the panel -------------------------------------------------------------------------

  const place = () => {
    if (!state.dialog || !state.bell) return;
    const box = state.bell.getBoundingClientRect();
    const style = state.dialog.style;
    style.setProperty("--nt-top", `${Math.round(box.bottom + 10)}px`);
    // The panel's right edge sits a little past the bell's, as Control Center hangs from its own button.
    style.setProperty("--nt-right", `${Math.max(12, Math.round(window.innerWidth - box.right - 6))}px`);
  };

  const FIRST_STOP = ".hera-nt__item, .hera-nt__retry";

  const paintPanel = () => {
    const panel = state.panel;
    if (!panel) return;
    const holding = panel.contains(document.activeElement) ? document.activeElement : null;
    const keep = holding?.closest("[data-nid]")?.dataset.nid || null;
    const column = holding?.closest(".hera-nt__posters") ? [...holding.closest("ul").querySelectorAll("a")].indexOf(holding) : -1;
    const marking = holding?.classList.contains("hera-nt__markall");
    const scrolled = panel.querySelector(".hera-nt__body")?.scrollTop || 0;
    state.panelKey = state.data ? signature(state.data) : "";

    if (!state.data) {
      if (state.status === "failed") failed(panel, retry);
      else loading(panel);
    } else {
      render(panel, state.data, {
        now: new Date(),
        // The panel is let go before anything redraws it, so a link that is being followed stays whole.
        onOpen: (notice) => {
          state.panel = null;
          closePanel({ restore: false });
          markRead([notice.id]);
        },
        onMarkAll: () => markRead(),
      });
    }
    const body = panel.querySelector(".hera-nt__body");
    if (body) body.scrollTop = scrolled;

    if (!holding) return;
    // Redrawn under the keyboard or a remote: focus stays on the same notice, or the nearest thing
    // to it. Opened before the first answer arrived, it moves onto the first notice when it does.
    if (holding === panel) {
      const first = state.focusFirst ? panel.querySelector(FIRST_STOP) : null;
      if (first) state.focusFirst = false;
      (first || panel).focus({ preventScroll: true });
      return;
    }
    const same = keep ? panel.querySelector(`[data-nid="${CSS.escape(keep)}"]`) : null;
    const target =
      (same && (column >= 0 ? same.querySelectorAll(".hera-nt__posters a")[column] : same.querySelector(".hera-nt__item"))) ||
      (marking ? null : same?.querySelector(".hera-nt__item")) ||
      panel.querySelector(FIRST_STOP) ||
      panel;
    target.focus({ preventScroll: true });
  };

  const openPanel = ({ byKey = false } = {}) => {
    if (state.dialog || !state.bell) return;
    const panel = el("div", { class: "hera-nt__panel" });
    const dialog = el("dialog", { class: "hera-nt", "aria-label": "Notifications" }, panel);
    state.dialog = dialog;
    state.panel = panel;
    state.restoreFocus = true;
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closePanel();
    });
    // Back belongs to the panel while it is open: Jellyfin would otherwise also leave the page.
    dialog.addEventListener("keydown", (event) => {
      if (kit.keys.isBack(event)) {
        event.preventDefault();
        event.stopPropagation();
        closePanel();
      }
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      window.removeEventListener("resize", place);
      if (state.dialog === dialog) {
        state.dialog = null;
        state.panel = null;
      }
      state.bell?.setAttribute("aria-expanded", "false");
      if (state.restoreFocus) state.bell?.focus?.();
    });
    document.body.append(dialog);
    window.addEventListener("resize", place);
    place();
    paintPanel();
    dialog.showModal();
    state.bell.setAttribute("aria-expanded", "true");
    // A remote and the keyboard start on the first notice; a click leaves focus on the panel itself,
    // so Escape and the arrow keys work without a ring appearing under the mouse.
    state.focusFirst = kit.isTv() || byKey;
    const first = state.focusFirst ? panel.querySelector(FIRST_STOP) : null;
    if (first) state.focusFirst = false;
    (first || panel).focus({ preventScroll: true });
    // What is on screen is shown at once; a fresh answer follows.
    load({ force: true });
  };

  const closePanel = ({ restore = true } = {}) => {
    if (!state.dialog) return;
    state.restoreFocus = restore;
    state.dialog.close();
  };

  // ---------- "New" on cards --------------------------------------------------------------------

  // The same cards the quality badges go on, and the same way: one batched pass over what
  // Jellyfin and Hera add to the page, no request per card. A card is New when its item (or its
  // series) is named by an unread notice.
  const CARD_SELECTOR = [jf.notifyCard, '.hera-card[href*="id="]', ".hera-episode"].join(",");
  const ART_SELECTOR = `.hera-card__art, ${jf.notifyCardArt}, .hera-episode__still`;

  const cardIds = (card) => {
    const ids = [];
    if (card.dataset.id) ids.push(card.dataset.id);
    else if (card.getAttribute("href")) ids.push(new URLSearchParams(card.getAttribute("href").split("?")[1] || "").get("id"));
    else if (card.heraId) ids.push(card.heraId);
    if (card.dataset.seriesid) ids.push(card.dataset.seriesid);
    return ids.filter(Boolean).map(plainId);
  };

  const paintCard = (card) => {
    const art = card.querySelector(ART_SELECTOR);
    if (!art) return;
    const wanted = state.news.size > 0 && cardIds(card).some((id) => state.news.has(id));
    const have = art.querySelector(":scope > .hera-new");
    if (wanted && !have) art.append(el("span", { class: "hera-new hera-dark", text: "New" }));
    else if (!wanted && have) have.remove();
  };

  const scanCards = (node) => {
    if (node.matches?.(CARD_SELECTOR)) paintCard(node);
    for (const card of node.querySelectorAll?.(CARD_SELECTOR) || []) paintCard(card);
  };

  const stopCards = () => {
    state.cardObserver?.disconnect();
    state.cardObserver = null;
    state.cardQueued = false;
  };

  // The observer runs only while something is New, so a quiet library costs the page nothing.
  const syncCards = () => {
    if (!state.news.size) {
      stopCards();
      document.querySelectorAll(".hera-new").forEach((node) => node.remove());
      return;
    }
    if (!state.cardObserver) {
      const pending = new Set();
      state.cardObserver = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) if (node.nodeType === 1) pending.add(node);
        if (state.cardQueued || !pending.size) return;
        state.cardQueued = true;
        requestAnimationFrame(() => {
          state.cardQueued = false;
          const nodes = [...pending];
          pending.clear();
          for (const node of nodes) if (node.isConnected) scanCards(node);
        });
      });
      state.cardObserver.observe(document.body, { childList: true, subtree: true });
    }
    // Ids that stopped being New lose their badge; the rest of the page is checked once.
    scanCards(document.body);
  };

  // ---------- "New" on a detail page --------------------------------------------------------------

  // `mediaInfoItem` is Jellyfin's class for a meta-line chip: borrowed so the chip sits in its rhythm.
  const detailChip = () =>
    el("div", { class: "mediaInfoItem hera-new-meta", "aria-label": "New" }, el("span", { class: "hera-new-chip", text: "New" }));

  const syncDetail = () => {
    const detail = state.detail;
    if (!detail) return;
    const { page, id } = detail;
    const meta = page.isConnected ? kit.jf("notify-detail", "detailMisc", page) : null;
    if (!meta) return;
    const wanted = state.news.has(plainId(id));
    const have = meta.querySelector(":scope > .hera-new-meta");
    if (wanted && !have) {
      // Redrawing the meta line would loop the observer: it is paused while the chip goes in.
      detail.observer?.disconnect();
      meta.prepend(detailChip());
      detail.observer?.observe(meta, { childList: true });
    } else if (!wanted && have) {
      detail.observer?.disconnect();
      have.remove();
      detail.observer?.observe(meta, { childList: true });
    }
  };

  const clearDetail = () => {
    state.detail?.observer?.disconnect();
    state.detail = null;
    document.querySelectorAll(".hera-new-meta").forEach((node) => node.remove());
  };

  const mountDetail = (page, id) => {
    if (!id) return clearDetail();
    if (state.detail?.page === page && state.detail.id === id && state.detail.observer) {
      syncDetail();
      return;
    }
    clearDetail();
    const meta = kit.jf("notify-detail", "detailMisc", page);
    const detail = { page, id, observer: null };
    state.detail = detail;
    // Jellyfin draws the meta line again when the item reloads (a played mark, a refreshed rating).
    detail.observer = new MutationObserver(() => {
      if (!meta.querySelector(":scope > .hera-new-meta")) syncDetail();
    });
    if (meta) detail.observer.observe(meta, { childList: true });
    syncDetail();
  };

  // ---------- running ---------------------------------------------------------------------------

  const poll = () => {
    if (document.visibilityState === "visible") load();
  };

  const start = () => {
    if (state.started) return;
    state.started = true;
    scope = kit.scope();
    state.timer = setInterval(poll, POLL_MS);
    scope.listen(document, "visibilitychange", poll);
    scope.listen(window, "focus", poll);
    scope.add(kit.onRoute("notify", () => closePanel({ restore: false })));
  };

  const reset = () => {
    state.run += 1;
    state.inflight = null;
    state.data = null;
    state.status = "idle";
    state.fetchedAt = 0;
    state.news = new Set();
    syncCards();
    syncDetail();
    paintBell();
  };

  // Everything the module has running, stopped: the timer, the listeners, the bell and the badges.
  const halt = () => {
    clearInterval(state.timer);
    clearTimeout(retryTimer);
    scope?.dispose();
    scope = null;
    state.started = false;
    removeBell();
    state.user = null;
    reset();
  };

  HT.register({
    name: "notify",
    // No `requires`: the bell goes beside whichever search button the header shows, and ensureBell
    // checks for one itself, as the header search does. A page with no header (the player, sign-in)
    // is not a page this module has failed on.
    async onView() {
      if (!kit.userId()) return;
      // The server's own switch (Dashboard > Hera TV): off, there is no bell and nothing to ask.
      const features = (await kit.integrations())?.features || {};
      if (features.notifications === false) {
        halt();
        return;
      }
      if (state.user !== kit.userId()) {
        state.user = kit.userId();
        reset();
      }
      start();
      ensureBell();
      if (!state.data) poll();
    },
    teardown() {
      halt();
      stopCards();
      state.dialog?.remove();
      state.dialog = null;
      state.panel = null;
      document.querySelectorAll(".hera-new").forEach((node) => node.remove());
      state.data = null;
    },
  });

  // Two modules, so that a detail page Jellyfin has redrawn costs only its chip, never the bell.
  HT.register({
    name: "notify-detail",
    // The chip joins the meta line; without it there is nothing to join.
    requires: { itemDetailPage: ["detailMisc"] },
    onView(page, { itemId }) {
      if (page.id === "itemDetailPage") mountDetail(page, itemId);
      else clearDetail();
    },
    teardown() {
      clearDetail();
    },
  });
})();
