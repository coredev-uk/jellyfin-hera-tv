/*
 * Hera TV: request activity. Registers with window.HeraTV (hera-tv.js).
 * Seerr says "processing" for everything between "approved" and "here". Sonarr, Radarr and
 * SABnzbd know better, and the server (Integrations/ArrActivity.cs) joins them to the title:
 *  - HeraTV.activity.describe/requestCard/mountTitle: one wording and one look for a title's real state
 *    ("Downloading 42% · 12 min left", "Searching", "Series 4: 6 of 10"), used by the home row,
 *    the title sheet and film and series pages.
 *  - A state line on film and series pages, under the meta line, while a title is requested or
 *    monitored and not yet complete.
 *  - A Requests view at #/home?hera=requests: the person's own requests with live progress and,
 *    for an administrator, a Downloads list of the whole queue with SABnzbd's speed.
 * Everything refreshes while visible, and nothing here is drawn when no download service is set up.
 *
 * Contracts with the other modules:
 *  - HeraTV.activity is read by hera-home.js (the Your Requests row: fetchRequests, describeRequest,
 *    requestCard, updateCard, keyOf, rankOf, pacer, hash) and hera-discover.js (fetchTitle, describe,
 *    activityOn, titleInfoOn, requestsAvailable, mountTitle, hash). A title with no Jellyfin page opens
 *    HeraTV.discover.openTitle (hera-discover.js).
 *  - DOM expandos: line.heraLine and row.heraParts hold the parts a repaint fills in place; row.heraRequest
 *    is the request a row shows. data-hera-request marks a request's card on the home row.
 *  - Expects hera-tv.css for cards, shelves and buttons, and html.hera-view-taken for the takeover of the
 *    home tab while the Requests view shows (kit.view). `.hera-ext` (the "open in" links) is styled here and
 *    shared with the title sheet in hera-discover.css.
 */
(() => {
  "use strict";

  const HT = window.HeraTV;
  if (!HT?.kit) return;
  const { kit } = HT;
  const { el, icon } = kit;

  const scope = kit.scope();

  // Jellyfin's page ids, the keys `requires` is written in.
  const INDEX_PAGE = "indexPage";
  const DETAIL_PAGE = "itemDetailPage";

  const REQUESTS_HASH = "#/home?hera=requests";
  // How often to look again. A title that moves (downloading, importing, queued, searching) is
  // worth 8 s; one that only waits on a person or a release (awaiting approval, approved) backs
  // off 8, 15, 30 then 60 s for as long as the answer stays the same; a settled list takes 30 s.
  const BUSY_MS = 8000;
  const IDLE_MS = 30000;
  const BACKOFF_MS = [8000, 15000, 30000, 60000];
  const SHOW_FIRST = 12; // rows of Available and Declined shown before "Show more"

  // ---------- wording ----------------------------------------------------------------------

  const bytes = (n) => {
    if (!(n > 0)) return "";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    const value = n / 1024 ** i;
    return `${value >= 100 || i < 2 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
  };

  const eta = (seconds) => {
    const total = Math.max(0, Math.round(seconds));
    if (total < 60) return "under a minute";
    const minutes = Math.round(total / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
    const days = Math.floor(hours / 24);
    return hours % 24 ? `${days} d ${hours % 24} h` : `${days} d`;
  };

  const dateText = (iso) => {
    if (!iso) return null;
    const date = new Date(`${iso}T00:00:00`);
    if (Number.isNaN(date.getTime())) return null;
    const options = { day: "numeric", month: "short" };
    if (date.getFullYear() !== new Date().getFullYear()) options.year = "numeric";
    return date.toLocaleDateString(undefined, options);
  };

  const kindOf = (mediaType) => (mediaType === "tv" ? "TV Show" : "Film");

  // The first series still short of what has aired: "Series 4: 6 of 10", and how many more there are.
  // A series Sonarr is no longer watching and holds nothing of reads "Series 1–2 not monitored".
  const seasonLine = (a) => {
    const rows = a.seasons ?? [];
    const open = rows.filter((s) => s.want > 0 && s.have < s.want);
    if (open.length) {
      const first = open[0];
      const more = open.length - 1;
      return `Series ${first.seasonNumber}: ${first.have} of ${first.want}${more ? ` · ${more} more` : ""}`;
    }
    const idle = rows.filter((s) => s.state === "unmonitored").map((s) => s.seasonNumber);
    return idle.length ? `${seriesText(idle)} not monitored` : null;
  };

  /**
   * The words and icon for a state. `label` is the short form (a badge), `detail` what follows it,
   * `full` the whole line, `extra` a quieter second line. `progress` is 0 to 100 only while a
   * download moves.
   */
  const describe = (a) => {
    const seasons = seasonLine(a);
    const base = { state: a.state, progress: null, detail: null, extra: null, final: false };
    switch (a.state) {
      case "downloading": {
        const percent = Math.round(a.progress ?? 0);
        const left = a.etaSeconds ? `${eta(a.etaSeconds)} left` : null;
        const detail = [`${percent}%`, left].filter(Boolean).join(" · ");
        const done = a.sizeBytes ? `${bytes(a.sizeBytes - (a.sizeLeftBytes ?? 0)) || "0 B"} of ${bytes(a.sizeBytes)}` : null;
        const speed = a.speedBps > 0 ? `${bytes(a.speedBps)}/s` : null;
        return {
          ...base,
          label: "Downloading",
          detail,
          full: `Downloading ${detail}`,
          icon: "downloading",
          progress: a.progress ?? 0,
          extra: [seasons, done, speed].filter(Boolean).join(" · ") || null,
        };
      }
      case "queued":
        return a.paused
          ? { ...base, label: "Paused", full: "Paused", icon: "pause_circle_outline", extra: seasons }
          : { ...base, label: "Queued", full: "Queued", icon: "schedule", extra: seasons };
      case "importing":
        return { ...base, label: "Importing", full: "Importing", icon: "move_to_inbox", extra: seasons };
      case "attention":
        return { ...base, label: "Needs Attention", full: "Needs attention", icon: "error_outline" };
      case "failed":
        return { ...base, label: "Failed", full: "Download failed", icon: "error_outline" };
      case "searching":
        return { ...base, label: "Searching", full: "Searching", icon: "search", extra: seasons };
      case "waiting": {
        const when = dateText(a.releaseDate ?? a.nextAiring);
        return { ...base, label: "Awaiting Release", detail: when, full: `Awaiting release${when ? ` · ${when}` : ""}`, icon: "event" };
      }
      case "partial": {
        const line = seasons ?? (a.want ? `${a.have} of ${a.want}` : "Partly available");
        return { ...base, label: "Partly Available", detail: line, full: line, icon: "timelapse" };
      }
      case "available": {
        const next = a.nextAiring ? `Next episode ${dateText(a.nextAiring)}` : null;
        return { ...base, label: "Available", detail: next, full: ["Available", next].filter(Boolean).join(" · "), icon: "check_circle", final: true };
      }
      case "unmonitored":
        return { ...base, label: "Not Monitored", full: "Not monitored", icon: "visibility_off" };
      default:
        return { ...base, label: "Requested", full: "Requested", icon: "schedule" };
    }
  };

  // Without the download stack's word on it, Seerr's own: the request's status, then the title's.
  const describeRequest = (request) => {
    if (request.activity) return describe(request.activity);
    switch (request.requestStatus) {
      case "pending":
        return { state: "pending", label: "Awaiting Approval", full: "Awaiting approval", icon: "schedule", progress: null, detail: null, extra: null, final: false };
      case "declined":
        return { state: "declined", label: "Declined", full: "Declined", icon: "block", progress: null, detail: null, extra: null, final: true };
      case "failed":
        return { state: "failed", label: "Failed", full: "Request failed", icon: "error_outline", progress: null, detail: null, extra: null, final: false };
      case "available":
        return { state: "available", label: "Available", full: "Available", icon: "check_circle", progress: null, detail: null, extra: null, final: true };
      default: {
        const processing = request.item?.status === "processing";
        return { state: processing ? "processing" : "approved", label: "Approved", full: "Approved", icon: processing ? "sync" : "check_circle_outline", progress: null, detail: null, extra: null, final: false };
      }
    }
  };

  // What to list first: what moves, then what waits, then what is done.
  const RANK = { downloading: 0, importing: 1, queued: 2, attention: 3, failed: 4, searching: 5, partial: 6, waiting: 7, pending: 8, processing: 9, approved: 9, unmonitored: 10, available: 20, declined: 21 };
  const rankOf = (d) => RANK[d.state] ?? 12;
  const LIVE = new Set(["downloading", "importing", "queued", "searching"]);
  const WAITING = new Set(["attention", "partial", "pending", "processing", "approved"]);
  const stateOf = (tag) => tag.slice(tag.lastIndexOf(":") + 1);

  /**
   * Decides how long to wait before asking again. `tags` is a list of `"key:state"` strings, one
   * per title. Anything live is 8 s; otherwise titles that wait back off while the same set waits.
   */
  const pacer = () => {
    let last = null;
    let stage = 0;
    return (tags) => {
      if (tags.some((tag) => LIVE.has(stateOf(tag)))) {
        last = null;
        return BUSY_MS;
      }
      const waiting = tags.filter((tag) => WAITING.has(stateOf(tag))).sort().join("|");
      if (!waiting) {
        last = null;
        return IDLE_MS;
      }
      stage = waiting === last ? Math.min(stage + 1, BACKOFF_MS.length - 1) : 0;
      last = waiting;
      return BACKOFF_MS[stage];
    };
  };

  // ---------- data ----------------------------------------------------------------------------

  const memo = kit.ttlCache({ ttl: 4000, max: 40 });
  // A failed fetch answers null, so a line or a view that can't reach the server just draws nothing.
  const cached = (key, load) => {
    const request = memo.get(key, () => Promise.resolve().then(load));
    kit.track("activity", request);
    return request.catch((error) => {
      console.warn(`[Hera TV:activity] ${key}`, error);
      return null;
    });
  };

  /** What the server says of a title: `{ activity, links }`. Several parts of one page share one fetch. */
  const fetchTitle = (mediaType, tmdbId, tvdb) =>
    cached(`title:${mediaType}:${tmdbId}`, async () => {
      const reply = await kit.hera(`activity/title/${mediaType === "tv" ? "tv" : "movie"}/${tmdbId}`, { query: tvdb ? { tvdb } : undefined });
      return reply ?? null;
    });

  const fetchRequests = (take = 20) => cached(`requests:${take}`, async () => (await kit.hera("activity/requests", { query: { take } })) || []);

  const fetchDownloads = () => cached("downloads", () => kit.hera("activity/downloads"));

  /** Whether the download stack is connected and switched on for this server. */
  const activityOn = (ints) => Boolean(ints?.activity) && ints.features?.activity !== false;

  // The Requests view is for people who can request, and for administrators who can see the queue.
  const requestsAvailable = (ints) => Boolean(ints?.seerrLinked) || (Boolean(ints?.admin) && activityOn(ints));

  // A title's state and "open in" links are worth a call when Seerr or the download stack is there.
  const titleInfoOn = (ints) => Boolean(ints?.seerr) || activityOn(ints);

  /**
   * Runs `step` while `alive()`; `step` returns the wait in ms before the next run. Nothing runs
   * while the tab is hidden, and the poll picks up again when it shows.
   */
  const poll = (step, alive) => {
    let timer = 0;
    let stopped = false;
    const tick = async () => {
      timer = 0;
      if (stopped || !alive() || document.hidden) return;
      let wait = IDLE_MS;
      try {
        wait = await step();
      } catch (error) {
        console.warn("[Hera TV:activity]", error);
      }
      if (!stopped && !timer && !document.hidden) timer = setTimeout(tick, wait);
    };
    const onVisible = () => {
      if (!document.hidden && !stopped && !timer) timer = setTimeout(tick, 0);
    };
    document.addEventListener("visibilitychange", onVisible);
    timer = setTimeout(tick, BUSY_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  };

  // ---------- the state line ----------------------------------------------------------------

  const buildLine = (modifier) => {
    const glyph = el("span", { class: "material-icons", "aria-hidden": "true" });
    const text = el("span", { class: "hera-activity__text" });
    const fill = el("span", { class: "hera-activity__fill" });
    const bar = el("span", { class: "hera-activity__bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", hidden: true }, fill);
    const extra = el("span", { class: "hera-activity__extra", hidden: true });
    const node = el("div", { class: `hera-activity ${modifier || ""}`.trim() }, [el("span", { class: "hera-activity__main" }, [glyph, text]), bar, extra]);
    node.heraLine = { glyph, text, bar, fill, extra };
    return node;
  };

  /** Paints a described state onto a line from `buildLine`, in place, so a moving bar keeps moving. */
  const fillLine = (node, d) => {
    const { glyph, text, bar, fill, extra } = node.heraLine;
    node.dataset.state = d.state;
    glyph.textContent = d.icon;
    text.textContent = d.full;
    const moving = d.progress != null;
    bar.hidden = !moving;
    if (moving) {
      const percent = Math.min(100, Math.max(2, d.progress));
      fill.style.width = `${percent}%`;
      bar.setAttribute("aria-valuenow", String(Math.round(d.progress)));
      bar.setAttribute("aria-label", d.full);
    }
    extra.hidden = !d.extra;
    extra.textContent = d.extra || "";
    node.hidden = false;
  };

  // States a film or series page, or a title sheet, is worth a line for. A finished or untouched title has none.
  const SHOWN = new Set(["downloading", "queued", "importing", "attention", "failed", "searching", "partial", "waiting"]);

  // ---------- "open in" links ---------------------------------------------------------------
  // The server names only the services this person may open: Seerr for everyone, Radarr, Sonarr
  // and SABnzbd for administrators. Each opens in a new tab, so none is drawn in the TV layout
  // (kit.externalLink).

  const EXTERNAL = [["seerr", "Seerr"], ["radarr", "Radarr"], ["sonarr", "Sonarr"], ["sabnzbd", "SABnzbd"]];

  const externalLinks = (links, { short = false } = {}) =>
    EXTERNAL.filter(([key]) => links?.[key])
      .map(([key, name]) =>
        kit.externalLink(
          {
            class: "hera-ext__link",
            href: links[key],
            title: `Open in ${name}`,
            "aria-label": `Open in ${name}, opens in a new tab`,
          },
          [icon("open_in_new"), el("span", { text: short ? name : `Open in ${name}` })],
        ),
      )
      .filter(Boolean);

  /** Fills a `.hera-ext` host; unchanged links leave the nodes alone, so a focused one stays focused. */
  const paintLinks = (host, links, options) => {
    const sig = JSON.stringify([links ?? null, Boolean(options?.short)]);
    if (host.dataset.sig === sig) return;
    host.dataset.sig = sig;
    const nodes = externalLinks(links, options);
    host.replaceChildren(...nodes);
    host.hidden = !nodes.length;
  };

  const linksHost = () => el("div", { class: "hera-ext", hidden: true });

  /**
   * Keeps a title's state line, and its "open in" links, in `host`: fetched now and again while the
   * host is on screen. `options.linksHost` puts the links elsewhere. `options.onChange(activity | null)`
   * hears whether a state line is showing.
   */
  const mountTitle = (host, { mediaType, tmdbId, tvdb, onChange, linksHost: separate }) => {
    const line = buildLine("hera-activity--block");
    line.hidden = true;
    host.hidden = true;
    const ext = separate ?? linksHost();
    host.replaceChildren(...(separate ? [line] : [line, ext]));
    let stopped = false;
    const pace = pacer();
    const refresh = async () => {
      const reply = await fetchTitle(mediaType, tmdbId, tvdb);
      if (stopped || !host.isConnected) return IDLE_MS;
      const a = reply?.activity ?? null;
      const show = Boolean(a && SHOWN.has(a.state));
      if (show) fillLine(line, describe(a));
      else line.hidden = true;
      paintLinks(ext, reply?.links);
      host.hidden = line.hidden && (separate ? true : ext.hidden);
      onChange?.(show ? a : null);
      return pace(show ? [`title:${a.state}`] : []);
    };
    const stopPoll = poll(refresh, () => !stopped && host.isConnected);
    refresh();
    return {
      refresh,
      stop() {
        stopped = true;
        stopPoll();
      },
    };
  };

  // ---------- cards (the home row) -----------------------------------------------------------

  const keyOf = (request) => `${request.item.mediaType}:${request.item.tmdbId}`;

  const seriesText = (numbers) => (HT.discover?.seriesText ? HT.discover.seriesText(numbers) : `Series ${numbers.join(", ")}`);

  const cardSubtitle = (request, d) => {
    if (d.detail && d.state !== "available") return d.detail;
    return [request.item.year, kindOf(request.item.mediaType)].filter(Boolean).join(" · ");
  };

  const cardLabel = (request, d) => [request.item.title, d.full].filter(Boolean).join(", ");

  /** A poster card for a request: its state as the badge, a progress bar while it downloads. */
  const requestCard = (request, { onOpen } = {}) => {
    const d = describeRequest(request);
    const link = request.item.jellyfinId ? `#/details?id=${request.item.jellyfinId}` : null;
    const card = kit.card({
      href: link,
      onClick: link ? null : (event) => onOpen?.(request.item, event.currentTarget),
      image: request.item.poster,
      title: request.item.title,
      subtitle: cardSubtitle(request, d),
      badge: d.label,
      badgeTone: d.final && d.state === "available" ? "light" : undefined,
      progress: d.progress,
      label: cardLabel(request, d),
    });
    card.dataset.heraRequest = keyOf(request);
    return card;
  };

  /** Repaints a card from `requestCard` in place when its request moves on. */
  const updateCard = (card, request) => {
    const d = describeRequest(request);
    const art = card.querySelector(".hera-card__art");
    if (!art) return;
    let badge = art.querySelector(".hera-card__badge");
    if (!badge) {
      badge = el("span", { class: "hera-card__badge" });
      art.append(badge);
    }
    badge.textContent = d.label;
    badge.classList.toggle("hera-card__badge--light", d.final && d.state === "available");
    let bar = art.querySelector(".hera-card__progress");
    if (d.progress > 0) {
      if (!bar) {
        bar = el("span", { class: "hera-card__progress" }, el("span"));
        art.append(bar);
      }
      bar.firstElementChild.style.width = `${Math.min(100, Math.max(3, d.progress))}%`;
    } else {
      bar?.remove();
    }
    const subtitle = card.querySelector(".hera-card__subtitle");
    if (subtitle) subtitle.textContent = cardSubtitle(request, d);
    card.setAttribute("aria-label", cardLabel(request, d));
  };

  // ---------- film and series pages ---------------------------------------------------------

  // `run` ends a mount still waiting on the network when the page moves on or mounts again; two
  // mounts would otherwise leave two slots after the meta line, each putting itself first.
  const detail = { page: null, id: null, stop: null, watch: null, node: null, run: 0 };

  const clearDetail = () => {
    detail.run++;
    detail.stop?.();
    detail.watch?.disconnect();
    Object.assign(detail, { page: null, id: null, stop: null, watch: null, node: null });
    document.querySelectorAll(".hera-activity-slot").forEach((node) => node.remove());
  };

  const mountDetail = async (page, itemId) => {
    if (detail.page === page && detail.id === itemId && detail.node?.isConnected) return;
    clearDetail();
    if (!itemId) return;
    const run = detail.run;
    const ints = await kit.integrations();
    if (run !== detail.run || !titleInfoOn(ints)) return;
    const item = await kit.item(itemId);
    if (run !== detail.run) return;
    const tmdbId = item?.ProviderIds?.Tmdb;
    if (!tmdbId || (item.Type !== "Movie" && item.Type !== "Series")) return;
    if (kit.itemIdFromHash() !== itemId || !page.isConnected || kit.jf("activity", "page") !== page) return;

    const slot = el("div", { class: "hera-activity-slot" });
    const place = () => {
      const meta = kit.jf("activity", "detailMisc", page);
      if (!meta || slot.previousElementSibling === meta) return Boolean(meta);
      meta.after(slot);
      return true;
    };
    place();
    const mounted = mountTitle(slot, {
      mediaType: item.Type === "Series" ? "tv" : "movie",
      tmdbId,
      tvdb: item.ProviderIds?.Tvdb,
    });
    detail.page = page;
    detail.id = itemId;
    detail.node = slot;
    detail.stop = mounted.stop;
    // Jellyfin draws the meta line again when the item loads; the slot follows it.
    const target = kit.jf("activity", "detailMisc", page)?.parentElement || page;
    detail.watch = new MutationObserver(() => {
      if (!slot.isConnected || slot.previousElementSibling !== kit.jf("activity", "detailMisc", page)) place();
    });
    detail.watch.observe(target, { childList: true });
  };

  // ---------- the Requests view -------------------------------------------------------------

  const view = { root: null, abort: null, stop: null };

  // The `hera` query of the route showing, from kit.onRoute and from onView, which both carry it.
  let params = new URLSearchParams();
  const wantsView = () => params.get("hera") === "requests";

  /** Puts `nodes` in `host` in order, moving as little as possible so focus survives a refresh. */
  const arrange = (host, nodes) => {
    let ref = host.firstElementChild;
    for (const node of nodes) {
      if (node === ref) ref = ref.nextElementSibling;
      else host.insertBefore(node, ref);
    }
    while (ref) {
      const next = ref.nextElementSibling;
      ref.remove();
      ref = next;
    }
  };

  const requestRow = (request) => {
    const art = request.item.poster
      ? el("img", { class: "hera-av-row__art", src: request.item.poster, alt: "", loading: "lazy", decoding: "async" })
      : el("span", { class: "hera-av-row__art hera-av-row__art--empty", "aria-hidden": "true" }, icon(request.item.mediaType === "tv" ? "tv" : "movie"));
    const title = el("span", { class: "hera-av-row__title" });
    const meta = el("span", { class: "hera-av-row__meta" });
    const line = buildLine("hera-activity--row");
    const children = [art, el("span", { class: "hera-av-row__main" }, [title, meta, line])];
    const link = request.item.jellyfinId
      ? el("a", { class: "hera-av-row__link", href: `#/details?id=${request.item.jellyfinId}` }, children)
      : el("button", { class: "hera-av-row__link", type: "button" }, children);
    const node = el("div", { class: "hera-av-row" });
    if (!request.item.jellyfinId) {
      link.addEventListener("click", (event) => HT.discover?.openTitle?.(node.heraRequest.item, { opener: event.currentTarget }));
    }
    const ext = linksHost();
    node.append(link, ext);
    node.heraParts = { title, meta, line, link, ext };
    node.dataset.key = keyOf(request);
    return node;
  };

  const updateRequestRow = (node, request) => {
    node.heraRequest = request;
    const { title, meta, line, link, ext } = node.heraParts;
    const d = describeRequest(request);
    title.textContent = request.item.title;
    const parts = [kindOf(request.item.mediaType)];
    if (request.item.year) parts.push(request.item.year);
    if (request.item.mediaType === "tv" && request.seasons?.length) parts.push(seriesText(request.seasons));
    const asked = dateText(String(request.requestedAt || "").slice(0, 10));
    if (asked) parts.push(`Requested ${asked}`);
    meta.textContent = parts.join(" · ");
    fillLine(line, d);
    paintLinks(ext, request.links, { short: true });
    link.setAttribute("aria-label", [request.item.title, d.full].join(", "));
  };

  const downloadSubtitle = (item) => {
    if (item.kind === "movie") return item.year ? String(item.year) : null;
    if (item.episodes === 1 && item.episode != null) {
      return [item.season != null ? `Series ${item.season}, Episode ${item.episode}` : `Episode ${item.episode}`, item.episodeTitle].filter(Boolean).join(" · ");
    }
    if (item.episodes > 1) return [item.season != null ? `Series ${item.season}` : null, kit.text.plural(item.episodes, "episode")].filter(Boolean).join(" · ");
    return null;
  };

  const downloadRow = (item) => {
    const glyph = icon("downloading");
    const title = el("span", { class: "hera-av-row__title" });
    const meta = el("span", { class: "hera-av-row__meta" });
    const line = buildLine("hera-activity--row");
    const note = el("span", { class: "hera-av-row__note", hidden: true });
    const ext = linksHost();
    const node = el("div", { class: "hera-av-row hera-av-row--static", tabindex: "0", role: "group" }, [
      el("span", { class: "hera-av-row__art hera-av-row__art--icon", "aria-hidden": "true" }, glyph),
      el("span", { class: "hera-av-row__main" }, [title, meta, line, note]),
      ext,
    ]);
    node.heraParts = { glyph, title, meta, line, note, ext };
    node.dataset.key = item.id;
    return node;
  };

  const updateDownloadRow = (node, item) => {
    const { glyph, title, meta, line, note, ext } = node.heraParts;
    const d = describe({ ...item, items: item.episodes });
    glyph.textContent = d.icon;
    title.textContent = item.title;
    meta.textContent = [downloadSubtitle(item), bytes(item.sizeBytes), item.client].filter(Boolean).join(" · ");
    meta.hidden = !meta.textContent;
    fillLine(line, d);
    paintLinks(ext, item.links, { short: true });
    note.hidden = !item.message;
    note.textContent = item.message || "";
    node.setAttribute("aria-label", [item.title, d.full].join(", "));
  };

  const sabSummary = (downloads) => {
    if (!downloads?.services?.sabnzbd) return "";
    const sab = downloads.sab;
    if (!sab) return "SABnzbd isn't answering";
    if (sab.paused) return "SABnzbd paused";
    if (sab.speedBps > 0) return ["SABnzbd", `${bytes(sab.speedBps)}/s`, sab.etaSeconds ? `${eta(sab.etaSeconds)} left` : null].filter(Boolean).join(" · ");
    return sab.queued > 0 ? `SABnzbd · ${kit.text.plural(sab.queued, "download")} waiting` : "SABnzbd idle";
  };

  const buildView = (ints, signal) => {
    const back = el("a", { class: "hera-av__back", href: "#/home?hera=discover" }, [icon("chevron_left"), "Discover"]);
    const heading = el("h1", { class: "hera-av__title", text: "Requests" });
    const head = el("header", { class: "hera-av__head" }, [ints.seerr ? back : null, heading]);

    const section = (id, title, { aside = false, collapsible = false } = {}) => {
      const list = el("div", { class: "hera-av__list", role: "group", "aria-labelledby": `hera-av-${id}` });
      const summary = aside ? el("p", { class: "hera-av__summary" }) : null;
      const links = aside ? linksHost() : null;
      const more = collapsible ? el("button", { class: "hera-btn hera-btn--glass hera-btn--text hera-av__more", type: "button", hidden: true }) : null;
      const node = el("section", { class: "hera-av__section", hidden: true }, [
        el("div", { class: "hera-av__section-head" }, [
          el("h2", { class: "hera-av__heading", id: `hera-av-${id}`, text: title }),
          aside ? el("div", { class: "hera-av__aside" }, [summary, links]) : null,
        ]),
        list,
        more,
      ]);
      return { node, list, summary, links, more, expanded: false };
    };

    const progress = section("progress", "In Progress");
    const done = section("done", "Available", { collapsible: true });
    const declined = section("declined", "Declined", { collapsible: true });
    const downloads = section("downloads", "Downloads", { aside: true });

    for (const box of [done, declined]) {
      box.more.addEventListener("click", () => {
        box.expanded = true;
        const first = box.list.children.length;
        render(last.requests, last.queue);
        box.list.children[first]?.querySelector("a, button")?.focus();
      });
    }

    const empty = el("p", { class: "hera-av__empty", role: "status", hidden: true });
    const rootEl = el("div", { class: "hera-av", "data-hera-requests": "" }, [head, empty, progress.node, done.node, declined.node, downloads.node]);

    // Only the first rows of a long section are built; "Show more" brings in the rest.
    const rows = new Map();
    const place = (box, entries, build, update, keyFn) => {
      const shown = box.more && !box.expanded ? entries.slice(0, SHOW_FIRST) : entries;
      const nodes = shown.map((entry) => {
        const key = keyFn(entry);
        let node = rows.get(key);
        if (!node) {
          node = build(entry);
          rows.set(key, node);
        }
        update(node, entry);
        return node;
      });
      arrange(box.list, nodes);
      if (box.more) {
        box.more.hidden = shown.length >= entries.length;
        box.more.textContent = `Show ${entries.length - shown.length} more`;
      }
      box.node.hidden = !nodes.length;
    };

    const pace = pacer();
    let last = { requests: [], queue: null };

    /** Paints both lists; returns a `"key:state"` tag per title for the pacer. */
    const render = (requests, queue) => {
      last = { requests, queue };
      const described = requests
        .filter((r) => r.item?.title)
        .map((request) => ({ request, d: describeRequest(request) }))
        .sort((a, b) => rankOf(a.d) - rankOf(b.d) || String(b.request.requestedAt).localeCompare(String(a.request.requestedAt)));
      const pick = (test) => described.filter(test).map((entry) => entry.request);
      place(progress, pick((e) => !e.d.final), requestRow, updateRequestRow, keyOf);
      place(done, pick((e) => e.d.final && e.d.state === "available"), requestRow, updateRequestRow, keyOf);
      place(declined, pick((e) => e.d.final && e.d.state !== "available"), requestRow, updateRequestRow, keyOf);
      // A title that moved on is the same row in a new section; rows no section kept are forgotten.
      for (const [key, node] of rows) if (!node.isConnected) rows.delete(key);

      if (queue) {
        place(downloads, queue.items ?? [], downloadRow, updateDownloadRow, (item) => item.id);
        downloads.node.hidden = false;
        downloads.summary.textContent = sabSummary(queue);
        paintLinks(downloads.links, queue.links);
        if (!queue.items?.length) {
          downloads.list.replaceChildren(el("p", { class: "hera-av__none", text: "Nothing is downloading." }));
        } else {
          downloads.list.querySelector(".hera-av__none")?.remove();
        }
      } else {
        downloads.node.hidden = true;
      }

      const none = !described.length;
      empty.hidden = !none;
      if (none) {
        empty.textContent = ints.seerrLinked
          ? "You haven't requested anything yet. Find something in Discover and it will show up here."
          : "Your Jellyfin account isn't linked to Seerr, so there are no requests to show.";
      }
      const tags = described.map((entry) => `${keyOf(entry.request)}:${entry.d.state}`);
      if (queue?.items?.length) tags.push("queue:downloading");
      return tags;
    };

    const load = async () => {
      const wantQueue = Boolean(ints.admin) && activityOn(ints);
      const [requests, queue] = await Promise.all([
        ints.seerrLinked ? fetchRequests(60) : Promise.resolve([]),
        wantQueue ? fetchDownloads() : Promise.resolve(null),
      ]);
      if (signal.aborted) return IDLE_MS;
      return pace(render(requests ?? [], queue));
    };

    // The first paint shows what is there; a failed load says so.
    const first = load();
    kit.track("activity", first);
    first.catch((error) => {
      if (signal.aborted) return;
      console.error("[Hera TV:activity]", error);
      empty.hidden = false;
      empty.textContent = "Requests aren't available right now. Try again in a moment.";
    });
    view.stop = poll(load, () => !signal.aborted && rootEl.isConnected);
    return rootEl;
  };

  const unmountView = () => {
    view.abort?.abort();
    view.abort = null;
    view.stop?.();
    view.stop = null;
    if (view.root) kit.view.release("requests");
    view.root?.remove();
    view.root = null;
  };

  const mountView = (page, ints) => {
    const host = kit.jf("activity", "homeTab", page);
    if (!host) return;
    unmountView();
    view.abort = new AbortController();
    view.root = buildView(ints, view.abort.signal);
    host.append(view.root);
    kit.view.take("requests", { art: false });
    window.scrollTo(0, 0);
    // A remote needs focus somewhere once the first rows land.
    if (kit.isTv()) setTimeout(() => view.root?.querySelector(".hera-av-row, .hera-av__back")?.focus({ preventScroll: true }), 600);
  };

  const syncView = async (page) => {
    if (!wantsView() || page?.id !== INDEX_PAGE || !kit.userId()) {
      if (view.root) unmountView();
      return;
    }
    if (view.root?.isConnected) return;
    const ints = await kit.integrations();
    if (!wantsView()) return;
    if (!requestsAvailable(ints)) {
      kit.go("#/home");
      return;
    }
    if (view.root?.isConnected) return;
    mountView(page, ints);
  };

  // ---------- module -------------------------------------------------------------------------

  const onRoute = (route) => {
    params = route.params;
    syncView(route.page ?? kit.jf("activity", "page"));
  };

  HT.register({
    name: "activity",
    // The Requests view mounts into the home tab, and a title's download state sits after the meta line.
    requires: { indexPage: ["homeTab"], itemDetailPage: ["detailMisc"] },
    async onView(page, { itemId, params: viewParams }) {
      params = viewParams;
      if (!kit.userId()) return;
      await syncView(page);
      if (page.id === DETAIL_PAGE) await mountDetail(page, itemId);
      else clearDetail();
    },
    // Routes and the namespace (home and Control Center read HT.activity) wait for start().
    start() {
      scope.add(kit.onRoute("activity", onRoute));
      HT.activity = {
        describe,
        describeRequest,
        activityOn,
        requestsAvailable,
        titleInfoOn,
        requestCard,
        updateCard,
        mountTitle,
        fetchRequests,
        fetchTitle,
        keyOf,
        pacer,
        rankOf,
        hash: REQUESTS_HASH,
      };
    },
    teardown() {
      unmountView();
      clearDetail();
      memo.clear();
      scope.dispose();
      delete HT.activity;
    },
  });
})();
