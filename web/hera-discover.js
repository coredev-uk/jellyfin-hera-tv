/*
 * Hera TV: discover module. Registers with window.HeraTV (hera-tv.js).
 *  - A Discover tab beside Home: Seerr's trending, popular and upcoming titles, with search.
 *  - A title sheet: backdrop, details, cast, trailer, and Request (films) or a season checklist (TV).
 *  - "Request seasons" beside a series' Episodes. Seerr results on the search page live in hera-search.js.
 * Requests are made by the plugin as the viewer's own Seerr account; a viewer who isn't linked
 * can browse but is pointed at Seerr instead.
 *
 * Contracts with the other modules:
 *  - HeraTV.discover { openTitle, itemCard, badgeOf, seriesText, kindOf, errorStatus, errorMessage } is
 *    leaned on by hera-search.js, hera-seerr.js, hera-activity.js and hera-home.js, each guarding for it
 *    being absent. This file in turn reads HeraTV.activity (hera-activity.js) for live download wording.
 *  - DOM expandos: card.heraItem and slide.heraItem are the Seerr title a card or feature slide shows
 *    (slide.heraTrailer/heraTrailerLoaded its trailer button); data-hera-key finds them again when a
 *    request changes a status.
 *  - Borrows Jellyfin's classes on elements it makes: emby-tab-button, emby-button, show-focus,
 *    emby-button-foreground and emby-tab-button-active (the TV tab strip's tab), sectionTitle
 *    sectionTitle-cards (a results heading).
 *  - Expects hera-tv.css for cards, shelves, buttons and the home hero's pager (the feature reuses it and
 *    its hera-hero-progress animation), hera-activity.css for .hera-ext*, and html.hera-view-taken for
 *    the takeover of the home tab while the view shows (kit.view).
 */
(() => {
  "use strict";

  const HT = window.HeraTV;
  if (!HT?.kit) return;
  const { kit } = HT;
  const { el, icon } = kit;

  const scope = kit.scope();

  // Jellyfin's page ids (the keys `requires` is written in) and its numbering of the tab strip, Home
  // first: Jellyfin gives them no other mark.
  const INDEX_PAGE = "indexPage";
  const DETAIL_PAGE = "itemDetailPage";
  const HOME_TAB_INDEX = "0";

  const DISCOVER_HASH = "#/home?hera=discover";

  // ---------- data ----------------------------------------------------------------------

  const keyOf = (item) => `${item.mediaType}:${item.tmdbId}`;

  // Statuses changed by a request made here; they win over a list fetched before it.
  const overrides = new Map();
  const statusOf = (item) => overrides.get(keyOf(item)) ?? item.status ?? "none";

  const LISTS = [
    { id: "trending", name: "trending", title: "Trending" },
    { id: "films", name: "movies", title: "Popular Films" },
    { id: "tv", name: "tv", title: "Popular TV Shows" },
    { id: "upcoming-films", name: "upcoming-movies", title: "Upcoming Films", dates: true },
    { id: "upcoming-tv", name: "upcoming-tv", title: "Upcoming TV", dates: true },
  ];

  const lists = kit.ttlCache({ ttl: 3 * 60 * 1000, max: 60 });
  const titles = kit.ttlCache({ ttl: 60 * 1000, max: 60 });
  const qualities = kit.ttlCache({ ttl: 10 * 60 * 1000, max: 2 });

  // kit.track runs on a side branch: it never rejects, so wrapping a request in it would hide the
  // failure from the caller's error path and let the cache keep an empty answer.
  const fetchList = (name, page = 1) => {
    const request = lists.get(`${name}:${page}`, () => kit.hera(`discover/lists/${name}`, { query: { page } }));
    kit.track("discover", request);
    return request;
  };
  const fetchTitle = (mediaType, tmdbId) => titles.get(`${mediaType}:${tmdbId}`, () => kit.hera(`discover/titles/${mediaType}/${tmdbId}`));
  const searchTitles = (query, page = 1) => {
    const request = kit.hera("discover/search", { query: { query, page } });
    kit.track("discover", request);
    return request;
  };
  const qualitiesFor = (mediaType) => {
    const kind = mediaType === "tv" ? "tv" : "movie";
    return qualities.get(kind, () => kit.hera(`discover/qualities/${kind}`));
  };
  const qualityKey = (quality) => `${quality.serverId}:${quality.profileId}`;

  const errorStatus = (error) => error?.status ?? error?.response?.status ?? null;
  const errorMessage = async (error) => {
    try {
      const body = await (error?.json ? error.json() : null);
      return body?.message || null;
    } catch {
      return null;
    }
  };

  // ---------- cards ---------------------------------------------------------------------

  // Seerr says "Processing" for everything between approved and here, and Hera never repeats it.
  // Where the download stack knows better (the person's own requests, as the home page's Your
  // Requests row shows them) its word is used: "Awaiting Release", "Downloading", "Searching". A
  // title still to come out reads Awaiting Release even without it, and one the stack has nothing
  // on reads Approved, as Your Requests does.
  const BADGES = { partial: "Partly Available", processing: "Approved", pending: "Requested" };
  const liveLabels = new Map();
  const unreleased = (item) => !!item.releaseDate && new Date(`${item.releaseDate}T00:00:00`) > new Date();
  const badgeOf = (item) => {
    const status = statusOf(item);
    if (status === "available") return item.jellyfinId ? "In Library" : "Available";
    if (status === "none") return null;
    const live = liveLabels.get(keyOf(item));
    if (live) return live;
    if (status === "processing" && unreleased(item)) return "Awaiting Release";
    return BADGES[status] ?? null;
  };

  // Each title on screen that Seerr calls requested or processing is looked up with the download
  // stack (a few at a time, once per visit), and its card redrawn with what that says.
  const liveQueue = { keys: new Set(), waiting: [], running: 0 };
  const LIVE_AT_ONCE = 3;
  const IN_FLIGHT = new Set(["pending", "processing", "partial"]);

  const pumpLive = () => {
    const activity = HT.activity;
    while (activity && liveQueue.running < LIVE_AT_ONCE && liveQueue.waiting.length) {
      const item = liveQueue.waiting.shift();
      liveQueue.running++;
      activity
        .fetchTitle(item.mediaType, item.tmdbId)
        .then((reply) => {
          const found = reply?.activity ? activity.describe(reply.activity) : null;
          if (!found || found.final) return;
          // Only the latest few hundred are kept; the oldest label goes first.
          if (liveLabels.size >= 300) liveLabels.delete(liveLabels.keys().next().value);
          liveLabels.set(keyOf(item), found.label);
          refreshCards(keyOf(item));
        })
        .catch(() => {})
        .finally(() => {
          liveQueue.running--;
          pumpLive();
        });
    }
  };

  const askLive = (item) => {
    if (!IN_FLIGHT.has(statusOf(item)) || liveQueue.keys.has(keyOf(item))) return;
    liveQueue.keys.add(keyOf(item));
    kit.integrations().then((ints) => {
      if (!HT.activity?.activityOn(ints)) return;
      liveQueue.waiting.push(item);
      pumpLive();
    });
  };

  const kindOf = (item) => (item.mediaType === "tv" ? "TV Show" : "Film");

  const itemCard = (item, { dates = false, subtitle = null } = {}) => {
    const link = item.jellyfinId ? `#/details?id=${item.jellyfinId}` : null;
    const when = dates && item.releaseDate ? kit.shortDate(item.releaseDate) : item.year;
    const card = kit.card({
      href: link,
      onClick: link ? null : (event) => openTitle(item, { opener: event.currentTarget }),
      image: item.poster,
      title: item.title,
      subtitle: subtitle ?? [when, kindOf(item)].filter(Boolean).join(" · "),
      badge: badgeOf(item),
      badgeTone: statusOf(item) === "available" ? "light" : undefined,
    });
    card.dataset.heraKey = keyOf(item);
    askLive(item);
    card.heraItem = item;
    return card;
  };

  // A request changes a title's status everywhere it is on screen: card badges, and the feature's
  // primary button.
  const refreshCards = (key) => {
    for (const slide of document.querySelectorAll(`.hera-discover__feature-slide[data-hera-key="${CSS.escape(key)}"]`)) {
      slide.querySelector(".hera-hero__actions .hera-btn--primary")?.replaceWith(primaryButton(slide.heraItem));
    }
    for (const card of document.querySelectorAll(`.hera-card[data-hera-key="${CSS.escape(key)}"]`)) {
      const art = card.querySelector(".hera-card__art");
      if (!art || !card.heraItem) continue;
      art.querySelector(".hera-card__badge")?.remove();
      const text = badgeOf(card.heraItem);
      if (text) {
        art.append(
          el("span", {
            class: `hera-card__badge${statusOf(card.heraItem) === "available" ? " hera-card__badge--light" : ""}`,
            text,
          }),
        );
      }
      card.setAttribute(
        "aria-label",
        [card.heraItem.title, [card.heraItem.year, kindOf(card.heraItem)].filter(Boolean).join(" · ")].join(", "),
      );
    }
  };

  const setStatus = (item, status) => {
    overrides.set(keyOf(item), status);
    refreshCards(keyOf(item));
  };

  // ---------- title sheet ---------------------------------------------------------------

  const STATUS_TEXT = {
    available: "Available",
    partial: "Partly Available",
    processing: "Approved",
    pending: "Requested",
  };
  const STATUS_ICON = { available: "check_circle", partial: "timelapse", processing: "check_circle_outline", pending: "schedule" };

  // Jellyfin here says "Series 1" for seasons. Contiguous numbers read as a range: "Series 6–8".
  const seriesText = (numbers) => {
    const sorted = [...numbers].sort((a, b) => a - b);
    const contiguous = sorted.every((n, i) => i === 0 || n === sorted[i - 1] + 1);
    if (contiguous) return sorted.length === 1 ? `Series ${sorted[0]}` : `Series ${sorted[0]}–${sorted.at(-1)}`;
    return `${sorted.length} Series`;
  };
  const seasonName = (season) => {
    const match = /^Season (\d+)$/.exec(season.name || "");
    return match || !season.name ? `Series ${season.seasonNumber}` : season.name;
  };

  const sheetState = { dialog: null, close: null };

  const closeSheet = () => sheetState.close?.();

  /**
   * Opens the sheet for a title. `item` needs `mediaType` and `tmdbId`; any other fields
   * paint at once while the full details load. `options.seasons` preselects TV seasons.
   */
  const openTitle = async (item, options = {}) => {
    if (!item?.mediaType || !item?.tmdbId) return;
    closeSheet();
    const ints = await kit.integrations();
    const isTv = item.mediaType === "tv";

    const ctx = {
      item: { ...item },
      details: null,
      seasons: [],
      selected: new Set(options.seasons ?? []),
      linked: ints.seerr ? ints.seerrLinked !== false : false,
      requestable: Boolean(ints.seerr),
      seerrUrl: ints.seerrUrl,
      busy: false,
      notice: null,
      live: false,
      // The qualities this person may request in ("1080p", "4K"), and the one picked. A quality is
      // a profile on one Radarr or Sonarr server (4K may be a server of its own), so both name it.
      qualities: [],
      quality: null,
    };

    const loadQualities = async () => {
      if (!ctx.linked) return;
      const reply = await qualitiesFor(item.mediaType).catch(() => null);
      const list = reply?.qualities ?? [];
      if (closed || list.length < 2) return;
      ctx.qualities = list;
      ctx.quality = qualityKey(list.find((q) => q.isDefault) ?? list[0]);
      paintActions();
    };

    const opener = options.opener ?? document.activeElement;
    const dialog = el("dialog", { class: "hera-sheet", "aria-label": item.title || "Title details" });
    const scroll = el("div", { class: "hera-sheet__scroll" });
    const head = el("div", { class: "hera-sheet__head" });
    const body = el("div", { class: "hera-sheet__body" });
    const actions = el("div", { class: "hera-sheet__actions" });
    const seasonsBox = el("div", { class: "hera-sheet__seasons" });
    const castBox = el("div", { class: "hera-sheet__cast-wrap" });
    const activityBox = el("div", { class: "hera-sheet__activity" });
    const externalBox = el("div", { class: "hera-ext hera-sheet__ext", hidden: true });
    let activityLine = null;
    const closeButton = el(
      "button",
      { type: "button", class: "hera-btn hera-btn--glass hera-sheet__close", "aria-label": "Close", onclick: () => close() },
      icon("close"),
    );

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      activityLine?.stop();
      if (dialog.open) dialog.close();
      dialog.remove();
      if (sheetState.dialog === dialog) {
        sheetState.dialog = null;
        sheetState.close = null;
      }
      if (opener?.isConnected && typeof opener.focus === "function") opener.focus({ preventScroll: true });
      options.onClose?.(ctx);
    };
    sheetState.dialog = dialog;
    sheetState.close = close;

    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });
    // A click on the backdrop lands on the dialog itself, outside its box.
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const box = dialog.getBoundingClientRect();
      if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close();
    });
    // Escape, and the remote's Back key. Jellyfin would otherwise navigate back.
    dialog.addEventListener("keydown", (event) => {
      if (kit.keys.isBack(event)) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    });

    scroll.append(head, body);
    dialog.append(scroll, closeButton);

    // ----- painting

    const info = () => ctx.details?.item ?? ctx.item;

    const paintHead = () => {
      const current = info();
      head.replaceChildren(
        current.backdrop
          ? el("img", { class: "hera-sheet__backdrop", src: current.backdrop, alt: "" })
          : el("div", { class: "hera-sheet__backdrop hera-sheet__backdrop--empty" }),
      );
    };

    const paintBody = () => {
      const current = info();
      const d = ctx.details;
      const meta = [
        current.year ? el("span", { text: current.year }) : null,
        isTv && ctx.seasons.length ? el("span", { text: `${ctx.seasons.length} Series` }) : null,
        d?.runtime ? el("span", { text: kit.runtime(d.runtime * 600000000) }) : null,
        d?.genres?.length ? el("span", { text: d.genres.slice(0, 3).join(", ") }) : null,
        d?.certification ? el("span", { class: "hera-badge", text: d.certification }) : null,
      ].filter(Boolean);
      // replaceChildren writes a missing part as the text "null", so the parts are filtered first.
      body.replaceChildren(
        ...[
          el("h2", { class: "hera-sheet__title", text: current.title || "" }),
          meta.length ? el("p", { class: "hera-sheet__meta" }, meta) : null,
          activityBox,
          // TMDB sometimes stores the word "null" as a title's tagline.
          d?.tagline && d.tagline !== "null" ? el("p", { class: "hera-sheet__tagline", text: d.tagline }) : null,
          current.overview ? el("p", { class: "hera-sheet__overview", text: current.overview }) : null,
          actions,
          externalBox,
          seasonsBox,
          castBox,
        ].filter(Boolean),
      );
      if (!d) body.append(el("p", { class: "hera-sheet__loading", role: "status", text: "Loading…" }));
    };

    const paintCast = () => {
      const cast = (ctx.details?.cast ?? []).slice(0, 14);
      castBox.replaceChildren();
      if (!cast.length) return;
      castBox.append(
        el("h3", { class: "hera-sheet__heading", text: "Cast" }),
        el(
          "ul",
          { class: "hera-sheet__cast" },
          cast.map((person) => {
            const face = [
              person.photo
                ? el("img", { src: person.photo, alt: "", loading: "lazy", decoding: "async" })
                : el("span", { class: "hera-sheet__person-fallback" }, icon("person")),
              el("span", { class: "hera-sheet__person-name", text: person.name }),
              person.character ? el("span", { class: "hera-sheet__person-role", text: person.character }) : null,
            ];
            // The person's page (Jellyfin's if the library has them, else Seerr's filmography) is in hera-seerr.js.
            return el(
              "li",
              { class: "hera-sheet__person" },
              person.id
                ? el("a", { class: "hera-sheet__person-link", href: `#/home?hera=person&tmdb=${person.id}`, onclick: () => close() }, face)
                : face,
            );
          }),
        ),
      );
    };

    const selectable = (season) => season.status === "none";
    const selectableSeasons = () => ctx.seasons.filter(selectable);
    const canPick = () => ctx.requestable && ctx.linked && !ctx.busy;

    const paintSeasons = () => {
      seasonsBox.replaceChildren();
      if (!isTv || !ctx.seasons.length) return;
      const open = selectableSeasons();
      const all = open.length > 0 && open.every((season) => ctx.selected.has(season.seasonNumber));
      const toggle = (season) => {
        if (!selectable(season) || !canPick()) return;
        if (ctx.selected.has(season.seasonNumber)) ctx.selected.delete(season.seasonNumber);
        else ctx.selected.add(season.seasonNumber);
        ctx.notice = null;
        paintSeasons();
        paintActions();
        seasonsBox.querySelector(`[data-season="${season.seasonNumber}"]`)?.focus({ preventScroll: true });
      };
      const row = (season) => {
        const open = selectable(season);
        const checked = ctx.selected.has(season.seasonNumber);
        return el(
          "button",
          {
            type: "button",
            class: "hera-season",
            role: "checkbox",
            "aria-checked": String(checked),
            "data-season": season.seasonNumber,
            disabled: !open || !canPick(),
            onclick: () => toggle(season),
          },
          [
            icon(checked ? "check_box" : "check_box_outline_blank"),
            el("span", { class: "hera-season__name", text: seasonName(season) }),
            el("span", { class: "hera-season__count", text: season.episodeCount ? kit.text.plural(season.episodeCount, "episode") : "" }),
            el("span", { class: "hera-season__status", text: season.status === "none" ? "" : (STATUS_TEXT[season.status] ?? "") }),
          ],
        );
      };
      seasonsBox.append(
        el("div", { class: "hera-sheet__heading-row" }, [
          el("h3", { class: "hera-sheet__heading", text: "Series" }),
          open.length > 1
            ? el(
                "button",
                {
                  type: "button",
                  class: "hera-season hera-season--all",
                  role: "checkbox",
                  "aria-checked": String(all),
                  disabled: !canPick(),
                  onclick: () => {
                    for (const season of open) {
                      if (all) ctx.selected.delete(season.seasonNumber);
                      else ctx.selected.add(season.seasonNumber);
                    }
                    ctx.notice = null;
                    paintSeasons();
                    paintActions();
                    seasonsBox.querySelector(".hera-season--all")?.focus({ preventScroll: true });
                  },
                },
                [icon(all ? "check_box" : "check_box_outline_blank"), el("span", { class: "hera-season__name", text: "All" })],
              )
            : null,
        ]),
        el("div", { class: "hera-season-list", role: "group", "aria-label": "Series" }, ctx.seasons.map(row)),
      );
    };

    const pill = (status) =>
      el("span", { class: "hera-sheet__status" }, [icon(STATUS_ICON[status] ?? "check_circle"), STATUS_TEXT[status] ?? status]);

    const unlinkedNote = () =>
      el("div", { class: "hera-sheet__note", role: "note" }, [
        el("p", {
          text: "Your Jellyfin account isn't linked to Seerr, so you can't request from here. Sign in to Seerr with your Jellyfin account once, then come back.",
        }),
        ctx.seerrUrl
          ? el(
              "a",
              { class: "hera-btn hera-btn--glass hera-btn--text", href: ctx.seerrUrl, target: "_blank", rel: "noopener noreferrer" },
              [icon("open_in_new"), "Open Seerr"],
            )
          : null,
      ]);

    const paintActions = () => {
      const current = info();
      const status = statusOf(current);
      const buttons = [];
      const extras = [];

      if (ctx.details) {
        if (current.jellyfinId) {
          buttons.push(
            el(
              "a",
              { class: "hera-btn hera-btn--primary", href: `#/details?id=${current.jellyfinId}`, onclick: () => close() },
              [icon("play_arrow"), "View in Library"],
            ),
          );
        }

        // The quality picker rides beside whichever Request button is shown.
        const withQuality = (button) => (ctx.qualities.length ? [button, qualityPicker()] : [button]);
        if (ctx.requestable) {
          if (isTv) {
            const pickedNumbers = selectableSeasons().filter((season) => ctx.selected.has(season.seasonNumber)).map((season) => season.seasonNumber);
            const picked = pickedNumbers.length;
            if (selectableSeasons().length && ctx.linked) {
              buttons.push(
                ...withQuality(
                  el(
                    "button",
                    {
                      type: "button",
                      class: `hera-btn ${current.jellyfinId ? "hera-btn--glass hera-btn--text" : "hera-btn--primary"} hera-sheet__request`,
                      disabled: ctx.busy || !picked,
                      "aria-busy": ctx.busy ? "true" : null,
                      onclick: () => submit(),
                    },
                    [icon(ctx.busy ? "hourglass_top" : "add"), ctx.busy ? "Requesting…" : picked ? `Request ${seriesText(pickedNumbers)}` : "Request"],
                  ),
                ),
              );
            } else if (selectableSeasons().length && !ctx.linked) {
              extras.push(unlinkedNote());
            } else if (!current.jellyfinId && status !== "none") {
              if (!ctx.live) buttons.push(pill(status));
            }
          } else if (status === "none") {
            if (ctx.linked) {
              buttons.push(
                ...withQuality(
                  el(
                    "button",
                    {
                      type: "button",
                      class: "hera-btn hera-btn--primary hera-sheet__request",
                      disabled: ctx.busy,
                      "aria-busy": ctx.busy ? "true" : null,
                      onclick: () => submit(),
                    },
                    [icon(ctx.busy ? "hourglass_top" : "add"), ctx.busy ? "Requesting…" : "Request"],
                  ),
                ),
              );
            } else {
              extras.push(unlinkedNote());
            }
          } else if (!current.jellyfinId) {
            if (!ctx.live) buttons.push(pill(status));
          }
        }

        if (ctx.details.trailer) {
          buttons.push(
            el(
              "a",
              { class: "hera-btn hera-btn--glass hera-btn--text", href: ctx.details.trailer, target: "_blank", rel: "noopener noreferrer" },
              [icon("smart_display"), "Trailer"],
            ),
          );
        }
      }

      if (ctx.notice) {
        extras.unshift(
          el("p", { class: `hera-sheet__result hera-sheet__result--${ctx.notice.tone}`, role: ctx.notice.tone === "error" ? "alert" : "status" }, [
            icon(ctx.notice.tone === "error" ? "error_outline" : "check_circle"),
            ctx.notice.text,
          ]),
        );
      }
      actions.replaceChildren(el("div", { class: "hera-sheet__buttons" }, buttons), ...extras);
    };

    // A capsule of the resolutions on offer, as the Collections page's Groups | All switch is drawn:
    // the picked one is the white pill. Arrow keys move along it as a radio group.
    const qualityPicker = () => {
      const options = ctx.qualities.map((q) =>
        el("button", {
          type: "button",
          class: "hera-sheet__quality-option",
          role: "radio",
          "aria-checked": String(qualityKey(q) === ctx.quality),
          tabindex: qualityKey(q) === ctx.quality ? "0" : "-1",
          disabled: ctx.busy,
          text: q.label,
          onclick: () => pickQuality(qualityKey(q)),
        }),
      );
      const group = el("div", { class: "hera-sheet__quality", role: "radiogroup", "aria-label": "Quality" }, options);
      group.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        const index = ctx.qualities.findIndex((q) => qualityKey(q) === ctx.quality);
        const next = ctx.qualities[index + (event.key === "ArrowRight" ? 1 : -1)];
        if (!next) return;
        event.preventDefault();
        event.stopPropagation();
        pickQuality(qualityKey(next), true);
      });
      return group;
    };

    const pickQuality = (key, keyboard = false) => {
      if (ctx.busy || ctx.quality === key) return;
      ctx.quality = key;
      paintActions();
      if (keyboard) actions.querySelector('.hera-sheet__quality-option[aria-checked="true"]')?.focus({ preventScroll: true });
    };

    // Repainting replaces the focused control; keep focus inside the sheet.
    const keepFocus = () => {
      if (dialog.contains(document.activeElement) && document.activeElement !== dialog) return;
      (dialog.querySelector(".hera-sheet__buttons .hera-btn:not([disabled]), .hera-season:not([disabled])") ?? closeButton).focus({
        preventScroll: true,
      });
    };

    // ----- requesting

    const submit = async () => {
      if (ctx.busy) return;
      const current = info();
      const body = { mediaType: item.mediaType, tmdbId: item.tmdbId };
      const quality = ctx.qualities.find((q) => qualityKey(q) === ctx.quality);
      if (quality) Object.assign(body, { serverId: quality.serverId, profileId: quality.profileId });
      let picked = [];
      if (isTv) {
        picked = selectableSeasons()
          .filter((season) => ctx.selected.has(season.seasonNumber))
          .map((season) => season.seasonNumber)
          .sort((a, b) => a - b);
        if (!picked.length) return;
        body.seasons = picked;
      }
      ctx.busy = true;
      ctx.notice = null;
      paintSeasons();
      paintActions();
      try {
        const result = await kit.hera("discover/requests", { method: "POST", body });
        const state = result?.requestStatus;
        if (state === "declined" || state === "failed") {
          ctx.notice = { tone: "error", text: state === "declined" ? "This request was declined." : "Seerr couldn't send that request. Try again later." };
        } else {
          const next = state === "available" ? "available" : state === "approved" ? "processing" : "pending";
          if (isTv) {
            for (const season of ctx.seasons) if (picked.includes(season.seasonNumber)) season.status = next;
            ctx.selected.clear();
            const states = ctx.seasons.map((season) => season.status);
            const some = (...values) => states.some((value) => values.includes(value));
            const overall = states.every((value) => value === "none")
              ? "none"
              : some("available", "partial") && !states.every((value) => value === "available")
                ? "partial"
                : states.every((value) => value === "available")
                  ? "available"
                  : some("processing")
                    ? "processing"
                    : "pending";
            setStatus(current, overall);
            ctx.notice = { tone: "ok", text: state === "available" ? "Already available." : `Requested ${seriesText(picked)}.` };
          } else {
            setStatus(current, next);
            ctx.notice = { tone: "ok", text: state === "available" ? "Already available." : "Requested." };
          }
          titles.delete(`${item.mediaType}:${item.tmdbId}`);
          refresh(picked, next).catch(() => {});
        }
      } catch (error) {
        if (errorStatus(error) === 403) {
          ctx.linked = false;
        } else {
          ctx.notice = {
            tone: "error",
            text: (await errorMessage(error)) || "Couldn't send the request. Try again in a moment.",
          };
        }
      }
      ctx.busy = false;
      paintSeasons();
      paintActions();
      keepFocus();
    };

    // After a request, Seerr's own view of the title is the truth; keep what we set where it hasn't caught up.
    const refresh = async (picked, optimistic) => {
      const fresh = await fetchTitle(item.mediaType, item.tmdbId);
      if (closed || !fresh) return;
      ctx.details = { ...ctx.details, ...fresh };
      if (isTv) {
        ctx.seasons = (fresh.seasons ?? [])
          .filter((season) => season.seasonNumber > 0)
          .map((season) => (picked.includes(season.seasonNumber) && season.status === "none" ? { ...season, status: optimistic } : season));
      }
      if (fresh.item && fresh.item.status !== "none") setStatus(fresh.item, fresh.item.status);
      paintSeasons();
      paintActions();
      keepFocus();
    };

    // ----- open

    paintHead();
    paintBody();
    paintActions();
    document.body.append(dialog);
    dialog.showModal();
    loadQualities().catch(() => {});
    // The download stack's word on where a request stands replaces Seerr's "Processing" pill.
    if (HT.activity?.titleInfoOn(ints)) {
      activityLine = HT.activity.mountTitle(activityBox, {
        linksHost: externalBox,
        mediaType: item.mediaType,
        tmdbId: item.tmdbId,
        onChange: (found) => {
          if (ctx.live === Boolean(found)) return;
          ctx.live = Boolean(found);
          paintActions();
          keepFocus();
        },
      });
    }
    closeButton.blur();
    (dialog.querySelector(".hera-sheet__request, .hera-btn--primary") ?? closeButton).focus({ preventScroll: true });

    try {
      const details = await fetchTitle(item.mediaType, item.tmdbId);
      if (closed) return;
      ctx.details = details;
      ctx.item = { ...ctx.item, ...details.item };
      if (isTv) {
        ctx.seasons = (details.seasons ?? []).filter((season) => season.seasonNumber > 0);
        if (options.seasons) {
          ctx.selected = new Set(options.seasons.filter((n) => ctx.seasons.some((s) => s.seasonNumber === n && selectable(s))));
        }
      }
      paintHead();
      paintBody();
      paintSeasons();
      paintCast();
      paintActions();
      const focus = dialog.querySelector(".hera-sheet__buttons .hera-btn:not([disabled]), .hera-season:not([disabled])");
      if (focus && (!dialog.contains(document.activeElement) || document.activeElement === closeButton)) focus.focus({ preventScroll: true });
    } catch {
      if (closed) return;
      body.querySelector(".hera-sheet__loading")?.remove();
      body.append(el("p", { class: "hera-sheet__result hera-sheet__result--error", role: "alert", text: "Couldn't load this title. Try again in a moment." }));
    }
  };

  // ---------- discover view -------------------------------------------------------------

  const view = { root: null, abort: null };

  const primaryButton = (item, { onNavigate } = {}) => {
    const status = statusOf(item);
    if (item.jellyfinId) {
      return el("a", { class: "hera-btn hera-btn--primary", href: `#/details?id=${item.jellyfinId}`, onclick: onNavigate }, [
        icon("play_arrow"),
        "In Library",
      ]);
    }
    const label = status === "none" ? "Request" : (badgeOf(item) ?? STATUS_TEXT[status] ?? "Request");
    const glyph =
      status === "none"
        ? "add"
        : label === "Awaiting Release"
          ? "event"
          : label === "Downloading"
            ? "downloading"
            : (STATUS_ICON[status] ?? "check_circle");
    return el(
      "button",
      { type: "button", class: "hera-btn hera-btn--primary", onclick: (event) => openTitle(item, { opener: event.currentTarget }) },
      [icon(glyph), label],
    );
  };

  // The feature: what is trending this week that the library doesn't have, the way the Apple TV
  // app's Watch Now leads with what's new to it. Up to six titles take turns in the card, with the
  // home hero's pager (8 s each, held while the pointer or focus is on the card, paused for reduced
  // motion). Each says why it is here ("Trending Now"), when it comes out if it hasn't yet, where a
  // request for it stands, and offers its trailer once the title's details have loaded.
  const FEATURED = 6;
  const FEATURE_MS = 8000;

  const featureSlide = (item) => {
    const when = unreleased(item) ? `Out ${kit.text.longDate(item.releaseDate)}` : item.year;
    const meta = ["Trending Now", kindOf(item), when, item.rating ? `${item.rating.toFixed(1)} rating` : null].filter(Boolean);
    const trailer = el("a", { class: "hera-btn hera-btn--glass hera-btn--text", target: "_blank", rel: "noopener noreferrer", hidden: true }, [
      icon("smart_display"),
      "Trailer",
    ]);
    const slide = el("div", { class: "hera-discover__feature-slide", "aria-label": item.title, "data-hera-key": keyOf(item) }, [
      // No src yet: show() hands it over when the slide comes up next. Lazy loading can't defer
      // these, as the slides are stacked in the viewport, so all six would load at once.
      el("img", { class: "hera-discover__feature-art", "data-src": item.backdrop, alt: "", decoding: "async" }),
      el("div", { class: "hera-discover__feature-body" }, [
        el("h2", { class: "hera-discover__feature-title", text: item.title }),
        el("p", { class: "hera-hero__meta" }, meta.map((text) => el("span", { text }))),
        item.overview ? el("p", { class: "hera-discover__feature-overview", text: item.overview }) : null,
        el("div", { class: "hera-hero__actions" }, [
          primaryButton(item),
          el(
            "button",
            { type: "button", class: "hera-btn hera-btn--glass hera-btn--text", onclick: (event) => openTitle(item, { opener: event.currentTarget }) },
            [icon("info_outline"), "More Info"],
          ),
          trailer,
        ]),
      ]),
    ]);
    slide.heraItem = item;
    slide.heraTrailer = trailer;
    return slide;
  };

  const buildFeature = (items, signal) => {
    const slides = items.map(featureSlide);
    const dots = items.map((item, i) =>
      el("button", { type: "button", role: "tab", class: "hera-hero__dot", "aria-label": item.title, "aria-selected": "false", onclick: () => show(i, true) }),
    );
    const toggle = el("button", { type: "button", class: "hera-btn hera-btn--glass hera-hero__toggle", "aria-label": "Pause featured titles", onclick: () => setPaused(!paused) }, icon("pause"));
    const paddle = (step, label, glyph) =>
      el("button", { type: "button", class: "hera-hero__paddle", tabindex: "-1", "aria-label": label, onclick: () => show(index + step, true) }, icon(glyph));
    const box = el("section", { class: "hera-discover__feature", "aria-roledescription": "carousel", "aria-label": "Trending now" }, [
      el("div", { class: "hera-discover__feature-slides", "aria-live": "off" }, slides),
      items.length > 1
        ? el("div", { class: "hera-hero__controls hera-discover__controls" }, [
            paddle(-1, "Previous title", "chevron_left"),
            el("div", { class: "hera-hero__pager", role: "tablist", "aria-label": "Trending titles" }, dots),
            paddle(1, "Next title", "chevron_right"),
            toggle,
          ])
        : null,
    ]);

    let index = 0;
    let paused = false;
    const holds = new Set();
    // The carousel's timer is the selected dot's fill, a CSS animation (hera-tv.css .hera-hero__dot):
    // its animationend moves on, and a hold (hover, focus, off screen, hidden, paused) stops it where
    // it is. Nothing runs per frame, so a carousel nobody sees costs nothing.
    const hold = (reason, on) => {
      if (on) holds.add(reason);
      else holds.delete(reason);
      box.classList.toggle("is-held", holds.size > 0);
    };
    const setPaused = (value) => {
      paused = value;
      hold("user", value);
      toggle.setAttribute("aria-label", value ? "Play featured titles" : "Pause featured titles");
      toggle.querySelector(".hera-icon").textContent = value ? "play_arrow" : "pause";
    };
    // The trailer button appears once the title's details say it has one.
    const loadTrailer = (slide) => {
      if (slide.heraTrailerLoaded) return;
      slide.heraTrailerLoaded = true;
      fetchTitle(slide.heraItem.mediaType, slide.heraItem.tmdbId)
        .then((details) => {
          if (!details?.trailer || signal.aborted) return;
          slide.heraTrailer.href = details.trailer;
          slide.heraTrailer.hidden = false;
        })
        .catch(() => {});
    };
    const show = (target, fromUser = false) => {
      const same = target === index;
      index = (target + slides.length) % slides.length;
      slides.forEach((slide, i) => {
        slide.classList.toggle("is-active", i === index);
        slide.toggleAttribute("inert", i !== index);
      });
      dots.forEach((dot, i) => dot.setAttribute("aria-selected", String(i === index)));
      // Choosing the title already showing starts its timer again.
      if (same && fromUser) for (const animation of dots[index]?.getAnimations?.({ subtree: true }) ?? []) animation.currentTime = 0;
      if (fromUser && document.activeElement?.classList.contains("hera-hero__dot")) dots[index].focus();
      loadTrailer(slides[index]);
      for (const slide of [slides[index], slides[(index + 1) % slides.length]]) {
        const art = slide?.querySelector("img[data-src]:not([src])");
        if (art) art.src = art.dataset.src;
      }
    };
    box.style.setProperty("--hera-hero-interval", `${FEATURE_MS}ms`);
    box.addEventListener("animationend", (event) => {
      if (event.animationName === "hera-hero-progress" && event.target === dots[index]) show(index + 1);
    });
    box.addEventListener("pointerenter", () => hold("hover", true));
    box.addEventListener("pointerleave", () => hold("hover", false));
    box.addEventListener("focusin", () => hold("focus", true));
    box.addEventListener("focusout", (event) => {
      if (!box.contains(event.relatedTarget)) hold("focus", false);
    });
    box.addEventListener("keydown", (event) => {
      if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && event.target.closest(".hera-hero__pager")) {
        event.preventDefault();
        event.stopPropagation();
        show(index + (event.key === "ArrowRight" ? 1 : -1), true);
      }
    });
    show(0);
    if (kit.reduceMotion.matches) setPaused(true);
    if (slides.length > 1) {
      const seen = new IntersectionObserver(([entry]) => hold("offscreen", !(entry.isIntersecting && entry.intersectionRatio > 0.4)), { threshold: [0, 0.4, 1] });
      const onVisibility = () => hold("hidden", document.hidden);
      seen.observe(box);
      document.addEventListener("visibilitychange", onVisibility);
      onVisibility();
      signal.addEventListener("abort", () => {
        seen.disconnect();
        document.removeEventListener("visibilitychange", onVisibility);
      }, { once: true });
    } else {
      hold("single", true);
    }
    return box;
  };

  const MAX_PAGES = 5;

  const buildRow = (def, first) => {
    const row = kit.shelf({
      id: `discover-${def.id}`,
      title: def.title,
      cards: first.results.map((item) => itemCard(item, { dates: def.dates })),
    });
    const track = row.querySelector(".hera-shelf");
    let page = first.page ?? 1;
    const total = Math.min(first.totalPages ?? 1, MAX_PAGES);
    const seen = new Set(first.results.map(keyOf));
    let loading = false;
    const more = async () => {
      if (loading || page >= total) return;
      if (track.scrollLeft + track.clientWidth < track.scrollWidth - 700) return;
      loading = true;
      try {
        const next = await fetchList(def.name, page + 1);
        page = next.page ?? page + 1;
        const fresh = (next.results ?? []).filter((item) => !seen.has(keyOf(item)));
        fresh.forEach((item) => seen.add(keyOf(item)));
        track.append(...fresh.map((item) => itemCard(item, { dates: def.dates })));
        track.dispatchEvent(new Event("scroll"));
      } catch {
        page = total;
      }
      loading = false;
    };
    // The layout reads in `more` run once a frame however fast the row scrolls.
    let queued = false;
    track.addEventListener(
      "scroll",
      () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          more();
        });
      },
      { passive: true },
    );
    return row;
  };

  const SEARCH_MIN = 2;

  const buildView = (signal) => {
    const input = el("input", {
      class: "hera-discover__input",
      type: "search",
      placeholder: "Search films and TV shows",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "Search films and TV shows",
      enterkeyhint: "search",
    });
    const clear = el("button", { type: "button", class: "hera-discover__clear", hidden: true, "aria-label": "Clear search" }, icon("close"));
    const requestsLink = el(
      "a",
      { class: "hera-btn hera-btn--glass hera-btn--text hera-discover__requests", href: HT.activity?.hash ?? "#/home?hera=requests", hidden: true },
      [icon("playlist_add_check"), "Requests"],
    );
    kit.integrations().then((ints) => {
      if (!signal.aborted && HT.activity?.requestsAvailable(ints)) requestsLink.hidden = false;
    });
    // The page's header row, where every library page has its title and tools: "Discover" at the
    // left, the search field and Requests at the right, level with it.
    const search = el("div", { class: "hera-discover__search" }, [
      el("h1", { class: "hera-discover__title", text: "Discover" }),
      el("div", { class: "hera-discover__tools" }, [el("div", { class: "hera-discover__field", role: "search" }, [icon("search"), input, clear]), requestsLink]),
    ]);
    const featureSlot = el("div", { class: "hera-discover__feature-slot" });
    const rows = el("div", { class: "hera-discover__rows" });
    const results = el("div", { class: "hera-discover__results", hidden: true });
    const rootEl = el("div", { class: "hera-discover", "data-hera-discover": "" }, [search, featureSlot, rows, results]);
    // Each visit asks the download stack afresh.
    liveQueue.keys.clear();

    // Rows in a fixed order, each arriving as soon as its list does.
    const slots = LISTS.map((def) => {
      const slot = el("div", { class: "hera-discover__slot" });
      rows.append(slot);
      return slot;
    });
    let settled = 0;
    LISTS.forEach((def, index) => {
      fetchList(def.name)
        .then((data) => {
          if (signal.aborted || !data?.results?.length) return;
          slots[index].replaceChildren(buildRow(def, data));
          if (def.name === "trending" && !featureSlot.firstChild) {
            // Features worth discovering: ones the library doesn't already have.
            const fresh = data.results.filter((item) => item.backdrop && !item.jellyfinId).slice(0, FEATURED);
            const leads = fresh.length ? fresh : data.results.filter((item) => item.backdrop).slice(0, 1);
            if (leads.length) featureSlot.replaceChildren(buildFeature(leads, signal));
          }
        })
        .catch((error) => {
          if (signal.aborted || def.name !== "trending") return;
          console.error("[Hera TV:discover]", error);
          slots[index].replaceChildren(
            el("p", { class: "hera-discover__empty", role: "alert", text: "Discover isn't available right now. Try again in a moment." }),
          );
        })
        .finally(() => {
          // The feature leads; if Trending never arrives, the first card of whatever did will do.
          settled++;
          if (def.name === "trending" || settled === LISTS.length) land();
        });
    });

    // On a TV the remote moves focus; the search field would raise the on-screen keyboard.
    // Land on the feature's button (or the first card) once, and keep focus out of the field.
    let landed = false;
    const land = (force = false) => {
      if (!kit.isTv() || signal.aborted || sheetState.dialog) return;
      const active = document.activeElement;
      if (landed && !(force && active === input)) return;
      if (!force && active && rootEl.contains(active) && active !== input) {
        landed = true;
        return;
      }
      const target = rootEl.querySelector(".hera-discover__feature-slide.is-active .hera-btn--primary") ?? rootEl.querySelector(".hera-card");
      if (!target) return;
      if (active === input) input.blur();
      target.focus({ preventScroll: true });
      landed = true;
    };
    land.again = () => setTimeout(() => land(true), 450);

    // Search
    let timer = 0;
    let seq = 0;
    const showResults = (on) => {
      results.hidden = !on;
      featureSlot.hidden = on;
      rows.hidden = on;
    };
    const run = async (text, page = 1, append = null) => {
      const mine = ++seq;
      try {
        const data = await searchTitles(text, page);
        if (signal.aborted || mine !== seq) return;
        const found = data?.results ?? [];
        if (append) {
          append.grid.append(...found.map((item) => itemCard(item)));
          append.more.hidden = (data.page ?? page) >= Math.min(data.totalPages ?? 1, MAX_PAGES);
          append.more.dataset.page = String(data.page ?? page);
          return;
        }
        if (!found.length) {
          results.replaceChildren(el("p", { class: "hera-discover__empty", role: "status", text: `No results for “${text}”.` }));
          return;
        }
        const grid = el("div", { class: "hera-discover__grid" }, found.map((item) => itemCard(item)));
        const moreButton = el(
          "button",
          {
            type: "button",
            class: "hera-btn hera-btn--glass hera-btn--text hera-discover__more",
            hidden: (data.page ?? 1) >= Math.min(data.totalPages ?? 1, MAX_PAGES),
            "data-page": String(data.page ?? 1),
            onclick: () => run(text, Number(moreButton.dataset.page) + 1, { grid, more: moreButton }),
          },
          "Show More",
        );
        results.replaceChildren(
          el("h2", { class: "sectionTitle sectionTitle-cards hera-row__title hera-discover__results-title", text: "Results" }),
          grid,
          moreButton,
        );
      } catch (error) {
        if (signal.aborted || mine !== seq) return;
        console.error("[Hera TV:discover]", error);
        results.replaceChildren(el("p", { class: "hera-discover__empty", role: "alert", text: "Search isn't available right now. Try again in a moment." }));
      }
    };
    const onInput = () => {
      const text = input.value.trim();
      clear.hidden = !input.value;
      clearTimeout(timer);
      if (text.length < SEARCH_MIN) {
        seq++;
        showResults(false);
        return;
      }
      showResults(true);
      timer = setTimeout(() => run(text), 320);
    };
    input.addEventListener("input", onInput);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && input.value) {
        event.preventDefault();
        event.stopPropagation();
        input.value = "";
        onInput();
      }
    });
    clear.addEventListener("click", () => {
      input.value = "";
      onInput();
      input.focus();
    });
    signal.addEventListener("abort", () => clearTimeout(timer));
    land.again();
    return rootEl;
  };

  const mountView = (page) => {
    if (view.root?.isConnected) return;
    const host = kit.jf("discover", "homeTab", page);
    if (!host) return;
    unmountView();
    view.abort = new AbortController();
    view.root = buildView(view.abort.signal);
    host.append(view.root);
    kit.view.take("discover", { art: false });
    window.scrollTo(0, 0);
  };

  const unmountView = () => {
    view.abort?.abort();
    view.abort = null;
    if (view.root) kit.view.release("discover");
    view.root?.remove();
    view.root = null;
  };

  // ---------- tab and routing -----------------------------------------------------------

  // The `hera` query of the route showing, from kit.onRoute and from onView, which both carry it.
  let params = new URLSearchParams();
  const wantsDiscover = () => params.get("hera") === "discover";

  // The tab needs Seerr and the admin's Discover switch (Hera TV settings in the Dashboard).
  const discoverOn = (ints) => Boolean(ints.seerr) && ints.features?.discover !== false;

  // `page` is the page that is, or is about to be, showing.
  const sync = (page) => {
    page ??= kit.jf("discover", "page");
    if (wantsDiscover() && page?.id === INDEX_PAGE && kit.userId()) {
      kit.integrations().then((ints) => {
        if (discoverOn(ints) && wantsDiscover()) mountView(page);
        updateTabs();
      });
    } else {
      unmountView();
      updateTabs();
    }
  };

  // The tabs are optional chrome: with no strip to put them in, Discover is still reached by its address.
  let seerrOn = false;
  let desktopTab = null;
  let tvTab = null;

  const tabsFor = () => {
    const onHome = kit.jf("discover", "page")?.id === INDEX_PAGE;
    const stack = kit.jf("discover", "appBarTabs");
    const slider = onHome ? kit.jf("discover", "headerTabsSlider") : null;
    return { stack, slider };
  };

  const updateTabs = () => {
    attachChrome?.();
    const active = Boolean(view.root);
    const { stack, slider } = tabsFor();

    if (stack && seerrOn) {
      desktopTab ??= el("a", { class: "hera-discover-tab", href: DISCOVER_HASH, tabindex: "0", text: "Discover" });
      if (stack.lastElementChild !== desktopTab) stack.append(desktopTab);
      if (active) desktopTab.setAttribute("aria-current", "page");
      else desktopTab.removeAttribute("aria-current");
    } else if (desktopTab?.isConnected) {
      desktopTab.remove();
    }

    if (slider && seerrOn) {
      if (!tvTab) {
        tvTab = el("button", { type: "button", class: "emby-tab-button emby-button show-focus hera-discover-tab", "data-hera-tab": "discover" }, [
          el("div", { class: "emby-button-foreground", text: "Discover" }),
        ]);
      }
      if (slider.lastElementChild !== tvTab) slider.append(tvTab);
      tvTab.classList.toggle("emby-tab-button-active", active);
    } else if (tvTab?.isConnected) {
      tvTab.remove();
    }
  };

  // Jellyfin's own tab strip knows nothing of ours: Discover is routed here, and a click on its
  // other tabs first leaves Discover so the strip's own state is right again.
  const onTabClick = (event) => {
    const button = event.target.closest?.(HT.jf.headerTabButton);
    if (!button) return;
    if (button === tvTab) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!wantsDiscover()) kit.go(DISCOVER_HASH);
      return;
    }
    if (view.root) {
      unmountView();
      updateTabs();
      if (button.dataset.index === HOME_TAB_INDEX) {
        // Home is the tab the strip still thinks is selected, so it won't fire; route there ourselves.
        event.stopImmediatePropagation();
        event.preventDefault();
        window.location.replace("#/home");
      } else {
        window.history.replaceState(null, "", "#/home");
        params = new URLSearchParams();
      }
    }
  };

  // Only the header and tab strip matter here, so only they are watched: the whole page changes far
  // more often. A header that is drawn again is picked up at the next view or hash change.
  let attachChrome = null;
  const observeChrome = () => {
    let queued = false;
    const observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (seerrOn) updateTabs();
      });
    });
    const watched = new WeakSet();
    attachChrome = () => {
      for (const node of [...kit.jfAll("discover", "appBar"), ...kit.jfAll("discover", "legacyHeader")]) {
        if (watched.has(node)) continue;
        watched.add(node);
        observer.observe(node, { childList: true, subtree: true });
      }
    };
    attachChrome();
    scope.add(() => {
      observer.disconnect();
      attachChrome = null;
    });
  };

  // ---------- series pages --------------------------------------------------------------

  const missing = new Map(); // series id -> Promise<{ tmdbId, seasons[] } | null>
  const MISSING_KEPT = 30;

  const loadMissing = (itemId) => {
    if (!missing.has(itemId)) {
      if (missing.size >= MISSING_KEPT) missing.delete(missing.keys().next().value);
      missing.set(
        itemId,
        (async () => {
          const item = await kit.item(itemId);
          const tmdbId = item?.Type === "Series" ? item.ProviderIds?.Tmdb : null;
          if (!tmdbId) return null;
          const [details, have] = await Promise.all([
            fetchTitle("tv", tmdbId),
            kit.getJSON(`Shows/${itemId}/Seasons`, { userId: kit.userId() }),
          ]);
          const owned = new Set((have?.Items ?? []).map((season) => season.IndexNumber).filter((n) => n != null));
          const seasons = (details?.seasons ?? [])
            .filter((season) => season.seasonNumber > 0 && season.status === "none" && season.episodeCount > 0 && !owned.has(season.seasonNumber))
            .map((season) => season.seasonNumber);
          return seasons.length ? { tmdbId: Number(tmdbId), seasons } : null;
        })().catch(() => null),
      );
    }
    return missing.get(itemId);
  };

  const seriesWatch = { observer: null, timer: 0 };
  const stopSeriesWatch = () => {
    seriesWatch.observer?.disconnect();
    seriesWatch.observer = null;
    clearTimeout(seriesWatch.timer);
  };

  const removeMissingControls = () => document.querySelectorAll(".hera-discover-missing").forEach((node) => node.remove());

  const mountMissing = async (page, itemId) => {
    stopSeriesWatch();
    const ints = await kit.integrations();
    if (!ints.seerr) return;
    const found = await loadMissing(itemId);
    if (!found || kit.itemIdFromHash() !== itemId) return;

    const place = () => {
      const headEl = page.querySelector(`.hera-seasons[data-item="${itemId}"] .hera-seasons__head`);
      if (!headEl) return false;
      if (headEl.querySelector(".hera-discover-missing")) return true;
      removeMissingControls();
      const control = el(
        "button",
        {
          type: "button",
          class: "hera-btn hera-btn--glass hera-btn--text hera-discover-missing",
          onclick: (event) =>
            openTitle(
              { mediaType: "tv", tmdbId: found.tmdbId },
              {
                seasons: found.seasons,
                opener: event.currentTarget,
                onClose: () => {
                  missing.delete(itemId);
                  loadMissing(itemId).then((next) => {
                    if (!next) control.remove();
                    else control.querySelector(".hera-discover-missing__label").textContent = labelFor(next.seasons);
                    found.seasons = next?.seasons ?? found.seasons;
                  });
                },
              },
            ),
        },
        [icon("add"), el("span", { class: "hera-discover-missing__label", text: labelFor(found.seasons) })],
      );
      headEl.append(control);
      return true;
    };

    if (place()) return;
    // The core builds the season shelf after its own fetches; wait for it.
    seriesWatch.observer = new MutationObserver(() => {
      if (place()) stopSeriesWatch();
    });
    seriesWatch.observer.observe(page, { childList: true, subtree: true });
    seriesWatch.timer = setTimeout(stopSeriesWatch, 10000);
  };

  const labelFor = (seasons) => `Request ${seriesText(seasons)}`;

  // ---------- module --------------------------------------------------------------------

  const onRoute = (route) => {
    params = route.params;
    sync(route.page);
  };

  HT.register({
    name: "discover",
    // The view mounts into the home tab; Discover has nowhere to appear without it.
    requires: { indexPage: ["homeTab"] },
    async onView(page, { itemId, params: viewParams }) {
      params = viewParams;
      if (!kit.userId()) return;
      const ints = await kit.integrations();
      seerrOn = discoverOn(ints);
      sync(page);
      if (!ints.seerr) return;
      if (page.id !== DETAIL_PAGE) {
        stopSeriesWatch();
        removeMissingControls();
      }
      if (page.id === DETAIL_PAGE && itemId) await mountMissing(page, itemId);
    },
    // Routes, the tab click interceptor, the chrome observer and the namespace all wait for
    // start(): a module switched off in the plugin's settings must not take the home tab over.
    start() {
      HT.discover = { openTitle, itemCard, badgeOf, seriesText, kindOf, errorStatus, errorMessage };
      scope.add(kit.onRoute("discover", onRoute));
      kit.intercept("discover", document, "click", onTabClick);
      observeChrome();
    },
    teardown() {
      closeSheet();
      stopSeriesWatch();
      removeMissingControls();
      unmountView();
      // Every copy, not just this instance's: a reloaded module must not leave a second tab.
      document.querySelectorAll(".hera-discover-tab").forEach((node) => node.remove());
      document.querySelectorAll(".hera-sheet").forEach((node) => node.remove());
      scope.dispose();
      delete HT.discover;
    },
  });
})();
