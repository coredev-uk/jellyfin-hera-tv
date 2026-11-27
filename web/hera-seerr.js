/*
 * Hera TV: Seerr as an extension of the library. Registers with window.HeraTV (hera-tv.js) and
 * builds on the title sheet and cards in hera-discover.js.
 *  - People: on a person's page, their role and a "More" on the biography, then a filmography
 *    from Seerr: "In Your Library" first, then Films / TV Shows (or what they directed, wrote,
 *    produced), each card showing Seerr's state and opening the title sheet to request. A person
 *    only Seerr knows is shown by the same renderer at #/home?hera=person&tmdb=<id>.
 *  - Film and series pages: a "More Like This" row of the library's own similar titles and
 *    Seerr's recommendations, the ones not in the library requestable.
 *  - Collection (box set) pages: the films the library lacks join the collection's own shelf
 *    in release order, dimmed, opening the title sheet, with "Request Missing" by its title.
 * Everything goes through the plugin's server: the Seerr key never reaches the browser, and
 * requests are made as the viewer's own Seerr account. With Seerr off, Jellyfin's stock sections stay.
 */
(() => {
  "use strict";

  const HT = window.HeraTV;
  if (!HT?.kit) return;
  const { kit } = HT;
  const { el, icon } = kit;

  const root = document.documentElement;
  const cleanups = [];
  const listen = (target, type, handler, options) => {
    target.addEventListener(type, handler, options);
    cleanups.push(() => target.removeEventListener(type, handler, options));
  };

  const discover = () => HT.discover;

  // ---------- data ----------------------------------------------------------------------

  const memo = new Map();
  const cached = (key, load, ttl) => {
    const now = Date.now();
    const hit = memo.get(key);
    if (hit && now - hit.at < hit.ttl) return hit.promise;
    const promise = Promise.resolve(load()).catch((error) => {
      memo.delete(key);
      throw error;
    });
    // Expired answers go as new ones arrive, so a long session keeps only what it just asked for.
    for (const [k, v] of memo) if (now - v.at >= v.ttl) memo.delete(k);
    memo.set(key, { at: now, ttl, promise });
    return promise;
  };

  const fetchPerson = (tmdbId) => cached(`person:${tmdbId}`, () => kit.hera(`discover/person/${tmdbId}`), 2 * 60 * 1000);
  const fetchPersonShelf = (tmdbId, shelf) =>
    cached(`person:${tmdbId}:${shelf}`, () => kit.hera(`discover/person/${tmdbId}/shelf/${shelf}`), 2 * 60 * 1000);
  const fetchRelated = (type, tmdbId) =>
    cached(`related:${type}:${tmdbId}`, () => kit.hera(`discover/titles/${type}/${tmdbId}/related`), 5 * 60 * 1000);
  const fetchCollection = (id) => cached(`collection:${id}`, () => kit.hera(`discover/collections/${id}`), 60 * 1000);

  const errorStatus = (error) => error?.status ?? error?.response?.status ?? null;
  const errorMessage = async (error) => {
    try {
      const body = await (error?.json ? error.json() : null);
      return body?.message || null;
    } catch {
      return null;
    }
  };

  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const kindText = (item) => (item.mediaType === "tv" ? "TV Show" : "Film");
  const detailsHref = (id) => `#/details?id=${id}`;
  const poster = (id) => kit.imageUrl(id, "Primary", { maxWidth: 400 });

  /** Before `ref` when it is a direct child of `host`, else last: a stock section that has moved must not make the insert throw. */
  const insertBefore = (host, node, ref) => host.insertBefore(node, ref?.parentNode === host ? ref : null);

  /** A card for something the library holds: its own artwork, a link to its page, and Play. */
  const libraryCard = ({ id, title, subtitle, badge, series }) =>
    kit.card({ href: detailsHref(id), image: poster(id), title, subtitle, badge, action: kit.playAction({ Id: id, Type: series ? "Series" : "Movie", Name: title }) });

  // ---------- expandable text -----------------------------------------------------------

  // A biography is clamped to three lines; "More" opens it, only when something is hidden.
  const addMore = (text) => {
    if (text.nextElementSibling?.classList.contains("hera-readmore")) return;
    if (text.scrollHeight <= text.clientHeight + 1) return;
    const button = el("button", { type: "button", class: "hera-readmore", "aria-expanded": "false", text: "More" });
    button.addEventListener("click", () => {
      const open = text.classList.toggle("is-open");
      button.setAttribute("aria-expanded", String(open));
      button.textContent = open ? "Less" : "More";
    });
    text.after(button);
  };

  // ---------- filmography ---------------------------------------------------------------

  // The server decides which shelf a credit is on and what sits under its card, and sends each shelf's
  // top SHELF_FIRST in either order; the rest of a shelf comes when "Show all" is pressed.
  const SHELF_FIRST = 40; // cards a shelf draws before "Show all"; the server sends at least this many per order

  const SORTS = {
    popular: (a, b) => (b.popularity ?? 0) - (a.popularity ?? 0),
    newest: (a, b) => (b.releaseDate || "").localeCompare(a.releaseDate || ""),
  };

  const creditKey = (credit) => `${credit.mediaType}:${credit.tmdbId}`;

  /**
   * The filmography of a person: `data` is the server's person record, `extras` the Jellyfin
   * films and shows the library credits to them (which cover what Seerr's TMDB credits miss).
   * Returns `{ node, covers }`; `covers` is the set of Jellyfin ids the library row shows.
   */
  const buildFilms = (data, extras = []) => {
    // The library row's entries all come with the page: they are the few titles the viewer holds.
    const ranked = [...(data.library ?? [])];
    const held = new Set(ranked.map((entry) => entry.jellyfinId));
    const keys = new Set(ranked.map(creditKey));
    for (const item of extras) {
      if (held.has(item.Id)) continue;
      const mediaType = item.Type === "Series" ? "tv" : "movie";
      const key = item.ProviderIds?.Tmdb ? `${mediaType}:${item.ProviderIds.Tmdb}` : `jellyfin:${item.Id}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const year = item.ProductionYear ? String(item.ProductionYear) : null;
      ranked.push({
        jellyfinId: item.Id,
        mediaType,
        title: item.Name,
        year,
        releaseDate: item.PremiereDate?.slice(0, 10),
        popularity: 0,
        subtitle: [kindText({ mediaType }), year].filter(Boolean).join(" · "),
      });
    }

    const node = el("div", { class: "hera-films hera-seerr" });
    let sort = "popular";
    const shelves = [];

    const sortBar = el(
      "div",
      { class: "hera-films__sort", role: "group", "aria-label": "Sort by" },
      [["popular", "Popular"], ["newest", "Newest"]].map(([key, label]) =>
        el("button", {
          type: "button",
          class: "hera-films__sort-button",
          "data-sort": key,
          "aria-pressed": String(key === sort),
          text: label,
          onclick: () => {
            if (sort === key) return;
            sort = key;
            for (const button of sortBar.children) button.setAttribute("aria-pressed", String(button.dataset.sort === key));
            // The cards stay; the shelves put them in the new order.
            for (const shelf of shelves) shelf.paint();
            sortBar.querySelector(`[data-sort="${key}"]`).focus({ preventScroll: true });
          },
        }),
      ),
    );

    /**
     * One shelf: the first `SHELF_FIRST` entries in the current order, `total` of them after "Show all".
     * `entries` is what the page came with; `load`, when there is more, fetches the rest of the shelf.
     * A card is built once, the first time its entry is drawn, and only moved after.
     */
    const filmShelf = ({ id, title, entries, total, card, load }) => {
      const cards = new Map();
      const row = kit.shelf({ id, title, cards: [] });
      const track = row.querySelector(".hera-shelf");
      let current = entries;
      let expanded = false;
      let loading = false;
      let loaded = !load;
      const all =
        total > SHELF_FIRST
          ? el("button", {
              type: "button",
              class: "hera-films__all",
              text: `Show all ${total}`,
              onclick: async () => {
                if (loading) return;
                if (!loaded) {
                  loading = true;
                  all.setAttribute("aria-busy", "true");
                  all.textContent = "Loading…";
                  try {
                    const full = await load();
                    // Entries the page already drew keep their cards.
                    const known = new Map(current.map((entry) => [creditKey(entry), entry]));
                    current = full.items.map((entry) => known.get(creditKey(entry)) ?? entry);
                    loaded = true;
                  } catch (error) {
                    console.error("[Hera TV:seerr]", error);
                    all.textContent = "Couldn't load. Try again";
                    return;
                  } finally {
                    loading = false;
                    all.removeAttribute("aria-busy");
                  }
                }
                expanded = true;
                all.remove();
                paint();
                const first = track.children[SHELF_FIRST];
                (first?.querySelector("a, button") ?? first)?.focus();
              },
            })
          : null;
      if (all) row.querySelector(".hera-row__head").append(all);
      const paint = () => {
        const ordered = [...current].sort(SORTS[sort]).slice(0, expanded ? total : Math.min(total, SHELF_FIRST));
        track.replaceChildren(
          ...ordered.map((entry) => {
            let node = cards.get(entry);
            if (!node) {
              node = card(entry);
              cards.set(entry, node);
            }
            return node;
          }),
        );
      };
      paint();
      return { row, paint };
    };

    if (ranked.length) {
      shelves.push(
        filmShelf({
          id: "seerr-person-library",
          title: "In Your Library",
          entries: ranked,
          total: ranked.length,
          card: (entry) => libraryCard({ id: entry.jellyfinId, title: entry.title, subtitle: entry.subtitle, series: entry.mediaType === "tv" }),
        }),
      );
    }
    for (const shelf of data.shelves ?? []) {
      shelves.push(
        filmShelf({
          id: `seerr-person-${shelf.id}`,
          title: shelf.title,
          entries: shelf.items,
          total: shelf.total,
          load: () => fetchPersonShelf(data.tmdbId, shelf.id),
          card: (credit) => discover().itemCard(credit, { subtitle: credit.subtitle }),
        }),
      );
    }
    node.replaceChildren(...shelves.map((shelf) => shelf.row));
    const total = ranked.length + (data.shelves ?? []).reduce((sum, shelf) => sum + shelf.total, 0);
    if (shelves.length && total > 6) shelves[0].row.querySelector(".hera-row__head").append(sortBar);
    return { node, covers: new Set(ranked.map((entry) => entry.jellyfinId)), empty: !node.children.length };
  };

  // ---------- Jellyfin person pages -----------------------------------------------------

  const personItems = (id) =>
    kit
      .getJSON(`Users/${kit.userId()}/Items`, {
        PersonIds: id,
        IncludeItemTypes: "Movie,Series",
        Recursive: true,
        Fields: "ProviderIds,PremiereDate",
      })
      .then((result) => result?.Items ?? [])
      .catch(() => []);

  const stockWatch = { observer: null, timer: 0 };
  const stopStockWatch = () => {
    stockWatch.observer?.disconnect();
    stockWatch.observer = null;
    clearTimeout(stockWatch.timer);
  };

  // Jellyfin's own Movies and Shows sections on a person's page are hidden once the library row
  // holds every title in them; its Episodes section (what Seerr doesn't list) always stays.
  const coverStock = (page, held) => {
    stopStockWatch();
    const cover = () => {
      for (const section of page.querySelectorAll("#childrenContent > .verticalSection")) {
        const cards = [...section.querySelectorAll(".card[data-id]")];
        const covered = cards.length > 0 && cards.every((card) => /^(Movie|Series)$/.test(card.dataset.type) && held.has(card.dataset.id));
        section.classList.toggle("hera-seerr-covered", covered);
      }
    };
    cover();
    const children = page.querySelector("#childrenContent");
    if (!children) return;
    stockWatch.observer = new MutationObserver(cover);
    stockWatch.observer.observe(children, { childList: true, subtree: true });
    stockWatch.timer = setTimeout(stopStockWatch, 10000);
  };

  const mountPerson = async (page, item, tmdbId) => {
    const [data, extras] = await Promise.all([fetchPerson(tmdbId), personItems(item.Id)]);
    if (!isCurrent(page, item.Id) || page.querySelector('[data-hera-seerr="films"]')) return;

    const info = page.querySelector(`${HT.jf.detailRibbon} .infoWrapper`);
    info?.querySelector(".hera-person-role")?.remove();
    if (data.role) info?.querySelector(".nameContainer")?.after(el("p", { class: "hera-person-role", text: data.role }));
    watchBio(info);

    const films = buildFilms(data, extras);
    if (films.empty) return;
    films.node.dataset.heraSeerr = "films";
    const host = page.querySelector(HT.jf.detailSection);
    if (!host) return;
    insertBefore(host, films.node, host.querySelector("#listChildrenCollapsible"));
    coverStock(page, films.covers);
  };

  // The stock page's biography is drawn by hera-tv.js a moment after the page shows.
  const bioWatch = { observer: null, timer: 0 };
  const watchBio = (info) => {
    bioWatch.observer?.disconnect();
    clearTimeout(bioWatch.timer);
    if (!info) return;
    const place = () => {
      const text = info.querySelector(".hera-detail-overview");
      if (!text) return false;
      addMore(text);
      return true;
    };
    if (place()) return;
    bioWatch.observer = new MutationObserver(() => place() && bioWatch.observer.disconnect());
    bioWatch.observer.observe(info, { childList: true });
    bioWatch.timer = setTimeout(() => bioWatch.observer?.disconnect(), 6000);
  };

  // ---------- a person only Seerr knows -------------------------------------------------

  const view = { root: null, abort: null, tmdb: null, classWatch: null };

  const wantedPerson = () => {
    const [path, query = ""] = window.location.hash.split("?");
    if (!path.startsWith("#/home")) return null;
    const params = new URLSearchParams(query);
    return params.get("hera") === "person" && /^\d+$/.test(params.get("tmdb") || "") ? params.get("tmdb") : null;
  };

  const longDate = (iso) => new Date(`${iso}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

  const buildHeader = (data) => {
    const meta = [
      data.role,
      data.birthday ? `Born ${longDate(data.birthday)}` : null,
      data.deathday ? `Died ${longDate(data.deathday)}` : null,
      data.placeOfBirth,
    ].filter(Boolean);
    const bio = data.biography?.trim() ? el("p", { class: "hera-pv__bio", text: data.biography.trim() }) : null;
    const head = el("header", { class: "hera-pv__head" }, [
      data.profile
        ? el("img", { class: "hera-pv__portrait", src: data.profile, alt: "" })
        : el("span", { class: "hera-pv__portrait hera-pv__portrait--empty", "aria-hidden": "true" }, icon("person")),
      el("div", { class: "hera-pv__who" }, [
        el("h1", { class: "hera-pv__name", text: data.name }),
        meta.length ? el("p", { class: "hera-pv__meta" }, meta.map((text) => el("span", { text }))) : null,
        bio,
      ]),
    ]);
    return { head, bio };
  };

  const stripHomeClass = () => {
    view.classWatch?.disconnect();
    // The home page marks the root for its hero; there is none here, and its header tokens would be wrong on the page's ground.
    root.classList.remove("hera-home");
    view.classWatch = new MutationObserver(() => root.classList.contains("hera-home") && root.classList.remove("hera-home"));
    view.classWatch.observe(root, { attributes: true, attributeFilter: ["class"] });
  };

  const unmountView = () => {
    view.abort?.abort();
    view.abort = null;
    view.root?.remove();
    view.root = null;
    view.tmdb = null;
    view.classWatch?.disconnect();
    view.classWatch = null;
    root.classList.remove("hera-person-on");
  };

  const mountView = async (page, tmdb) => {
    const host = page.querySelector(HT.jf.homeTab);
    if (!host) return;
    unmountView();
    const abort = (view.abort = new AbortController());
    view.tmdb = tmdb;
    view.root = el("div", { class: "hera-pv hera-seerr", "data-hera-person": tmdb }, [
      el("p", { class: "hera-pv__status", role: "status", text: "Loading…" }),
    ]);
    host.append(view.root);
    root.classList.add("hera-person-on");
    stripHomeClass();
    window.scrollTo(0, 0);
    const mine = view.root;

    try {
      const data = await fetchPerson(tmdb);
      if (abort.signal.aborted) return;
      // Someone the library has has a page of their own.
      if (data.jellyfinId) {
        window.location.replace(`${window.location.pathname}${window.location.search}${detailsHref(data.jellyfinId)}`);
        return;
      }
      const { head, bio } = buildHeader(data);
      const films = buildFilms(data);
      mine.replaceChildren(head, films.empty ? el("p", { class: "hera-pv__status", text: "Seerr has no titles for this person." }) : films.node);
      document.title = data.name;
      if (bio) requestAnimationFrame(() => addMore(bio));
      // A remote needs focus somewhere. The TV layout scrolls focus into view as it lands; while
      // focus is still on that first card, bring the person's header back.
      if (kit.isTv()) {
        const first = mine.querySelector(".hera-card");
        first?.focus({ preventScroll: true });
        setTimeout(() => document.activeElement === first && window.scrollTo(0, 0), 400);
      }
    } catch (error) {
      if (abort.signal.aborted) return;
      console.error("[Hera TV:seerr]", error);
      mine.replaceChildren(el("p", { class: "hera-pv__status", role: "alert", text: "Couldn't load this person. Try again in a moment." }));
    }
  };

  const syncView = async (page) => {
    const tmdb = wantedPerson();
    if (!tmdb || page?.id !== "indexPage" || !kit.userId()) {
      if (view.root) unmountView();
      return;
    }
    if (view.tmdb === tmdb && view.root?.isConnected) return;
    const ints = await kit.integrations();
    if (wantedPerson() !== tmdb) return;
    if (!ints.seerr || !discover()) {
      kit.go("#/home");
      return;
    }
    if (view.tmdb === tmdb && view.root?.isConnected) return;
    await mountView(page, tmdb);
  };

  // ---------- More Like This ------------------------------------------------------------

  const mountRelated = async (page, item, tmdbId) => {
    const type = item.Type === "Series" ? "tv" : "movie";
    const [related, similar] = await Promise.all([
      fetchRelated(type, tmdbId).catch(() => null),
      kit
        .getJSON(`Items/${item.Id}/Similar`, { userId: kit.userId(), limit: 12, fields: "ProviderIds,PremiereDate" })
        .then((result) => result?.Items ?? [])
        .catch(() => []),
    ]);
    if (!isCurrent(page, item.Id)) return;
    // Seerr unreachable: Jellyfin's own row stays as it is.
    if (!related?.results?.length) return;

    // Seerr's recommendations in the order it ranks them, each marked when the library holds it;
    // then Jellyfin's own similar titles that Seerr didn't name, so the stock row loses nothing.
    const held = new Set();
    const cards = [];
    const addLibrary = (id, title, year, kind) => {
      if (held.has(id)) return;
      held.add(id);
      cards.push(libraryCard({ id, title, subtitle: [year, kind].filter(Boolean).join(" · "), badge: "In Library", series: kind === "TV Show" }));
    };
    for (const other of related.results) {
      if (other.jellyfinId) addLibrary(other.jellyfinId, other.title, other.year, kindText(other));
      else cards.push(discover().itemCard(other));
    }
    for (const other of similar) addLibrary(other.Id, other.Name, other.ProductionYear, other.Type === "Series" ? "TV Show" : "Film");

    // Jellyfin keeps earlier detail pages in the document, hidden: look only inside this one.
    const host = page.querySelector(HT.jf.detailSecondary);
    if (!host) return;
    const row = kit.shelf({ id: "seerr-related", title: "More Like This", cards });
    row.classList.add("hera-seerr");
    row.dataset.heraSeerr = "related";
    page.querySelector('[data-hera-seerr="related"]')?.remove();
    insertBefore(host, row, host.querySelector("#similarCollapsible"));
    page.querySelector("#similarCollapsible")?.classList.add("hera-seerr-covered");
  };

  // ---------- collections ---------------------------------------------------------------

  const futureText = (film) => {
    if (!film.releaseDate) return "To be announced";
    const date = new Date(`${film.releaseDate}T00:00:00`);
    return date > new Date() ? date.toLocaleDateString("en-GB", { month: "short", year: "numeric" }) : film.year;
  };

  // Seerr's id for a box set: its own TMDB id, else the one collection all its films belong to.
  const collectionIdOf = async (item) => {
    if (item.ProviderIds?.Tmdb) return item.ProviderIds.Tmdb;
    const children = await kit
      .getJSON(`Users/${kit.userId()}/Items`, { ParentId: item.Id, Fields: "ProviderIds" })
      .then((result) => result?.Items ?? [])
      .catch(() => []);
    const ids = new Set(children.map((child) => child.ProviderIds?.TmdbCollection).filter(Boolean));
    return ids.size === 1 ? [...ids][0] : null;
  };

  const MISSING_STATUS = { pending: "Requested", processing: "Processing", partial: "Partly Available" };

  // A film the library lacks, on the collection's own shelf in its place: its TMDB art dimmed,
  // and Request (the title sheet) where a library film has Play. `onClose` runs when the sheet
  // closes, so a request made there shows on the shelf.
  const missingCard = (film, onClose) => {
    const status = MISSING_STATUS[film.status] ?? "Not in Your Library";
    const card = kit.shelfCard({
      image: film.backdrop ?? film.poster,
      numbered: true,
      name: film.title,
      overview: film.overview,
      meta: [futureText(film), status].filter(Boolean).join(" · "),
      className: "is-missing",
      label: `${film.title}, ${futureText(film)}, ${status}`,
      action: {
        icon: MISSING_STATUS[film.status] ? "schedule" : "add",
        run: (event) => discover().openTitle(film, { opener: event.currentTarget, onClose: () => onClose(film) }),
      },
    });
    card.dataset.heraSeerr = "collection";
    card.dataset.heraTmdb = String(film.tmdbId);
    return card;
  };

  const mountCollection = async (page, item) => {
    const [collectionId, ints, handle] = await Promise.all([collectionIdOf(item), kit.integrations(), kit.collectionShelf(page, item.Id)]);
    if (!collectionId || !handle || !isCurrent(page, item.Id)) return;
    const data = await fetchCollection(collectionId).catch(() => null);
    if (!data || !isCurrent(page, item.Id) || !handle.section.isConnected || handle.section.querySelector('[data-hera-seerr="collection"]')) return;

    let current = data;
    let notice = null;
    let busy = false;

    const paint = () => {
      handle.section.querySelectorAll('[data-hera-seerr="collection"]').forEach((node) => node.remove());
      const missing = current.parts.filter((film) => !film.jellyfinId);
      for (const film of missing) handle.place(missingCard(film, refresh), film.releaseDate);
      handle.refit();
      const count = current.requestable.length;
      if (ints.seerrLinked && count) {
        handle.head.append(
          el(
            "button",
            {
              type: "button",
              class: "hera-btn hera-btn--glass hera-btn--text hera-seerr__action",
              "data-hera-seerr": "collection",
              disabled: busy,
              "aria-busy": busy ? "true" : null,
              onclick: requestMissing,
            },
            [icon(busy ? "hourglass_top" : "add"), busy ? "Requesting…" : `Request ${count === 1 ? "Missing Film" : `${count} Missing Films`}`],
          ),
        );
      }
      if (notice) {
        handle.shelf.after(
          el("p", { class: `hera-note hera-note--${notice.tone}`, role: notice.tone === "error" ? "alert" : "status", "data-hera-seerr": "collection" }, [
            icon(notice.tone === "error" ? "error_outline" : "check_circle"),
            notice.text,
          ]),
        );
      }
    };

    // After the title sheet closes: fetch the collection again and repaint, keeping focus on the
    // film that was open.
    const refresh = async (film) => {
      memo.delete(`collection:${data.id}`);
      try {
        current = await fetchCollection(data.id);
      } catch {
        return;
      }
      if (busy || !handle.section.isConnected) return;
      const hadFocus = handle.section.contains(document.activeElement);
      paint();
      if (hadFocus) handle.shelf.querySelector(`[data-hera-tmdb="${film.tmdbId}"]`)?.focus({ preventScroll: true });
    };

    const requestMissing = async () => {
      if (busy) return;
      busy = true;
      notice = null;
      paint();
      try {
        const result = await kit.hera(`discover/collections/${data.id}/request`, { method: "POST" });
        notice = result.failed
          ? { tone: "error", text: `Requested ${plural(result.requested, "film")}; ${plural(result.failed, "film")} couldn't be sent.` }
          : { tone: "ok", text: `Requested ${plural(result.requested, "film")}.` };
      } catch (error) {
        notice = { tone: "error", text: errorStatus(error) === 403 ? "Your Jellyfin account isn't linked to Seerr." : (await errorMessage(error)) || "Couldn't send the request. Try again in a moment." };
      }
      memo.delete(`collection:${data.id}`);
      try {
        current = await fetchCollection(data.id);
      } catch {
        /* the cards keep their last state */
      }
      busy = false;
      if (!handle.section.isConnected) return;
      paint();
      handle.head.querySelector(".hera-seerr__action")?.focus({ preventScroll: true });
    };

    paint();
  };

  // ---------- detail pages --------------------------------------------------------------

  const isCurrent = (page, itemId) => kit.itemIdFromHash() === itemId && !page.classList.contains("hide");

  // Jellyfin reuses one page element for every item; what was added for the last one goes first.
  const clean = (page, itemId) => {
    if (page.dataset.heraSeerrItem === itemId) return;
    page.dataset.heraSeerrItem = itemId || "";
    stopStockWatch();
    page.querySelectorAll("[data-hera-seerr]").forEach((node) => node.remove());
    page.querySelectorAll(".hera-person-role, .hera-readmore:not(.hera-detail-more)").forEach((node) => node.remove());
    page.querySelectorAll(".hera-seerr-covered").forEach((node) => node.classList.remove("hera-seerr-covered"));
  };

  const busy = new Set();

  const onDetails = async (page, itemId) => {
    clean(page, itemId);
    const ints = await kit.integrations();
    if (!ints.seerr || !discover()) return;
    const item = await kit.item(itemId);
    if (!item || !isCurrent(page, itemId)) return;
    const tmdbId = item.ProviderIds?.Tmdb;
    const key = `${item.Type}:${itemId}`;
    if (busy.has(key)) return;
    busy.add(key);
    try {
      if (item.Type === "Person" && tmdbId) await mountPerson(page, item, tmdbId);
      else if ((item.Type === "Movie" || item.Type === "Series") && tmdbId) await mountRelated(page, item, tmdbId);
      else if (item.Type === "BoxSet") await mountCollection(page, item);
    } finally {
      busy.delete(key);
    }
  };

  const onHash = () => requestAnimationFrame(() => syncView(document.querySelector(".page:not(.hide)")));

  const start = () => {
    listen(window, "hashchange", onHash);
  };

  HT.register({
    name: "seerr",
    // A person only Seerr knows is drawn in the home tab; titles and people in the library get
    // their rows in the detail page's main and secondary sections.
    requires: { indexPage: ["homeTab"], itemDetailPage: ["detailSection", "detailSecondary"] },
    async onView(page, { itemId }) {
      if (!kit.userId()) return;
      await syncView(page);
      if (page.id === "itemDetailPage" && itemId) await onDetails(page, itemId);
    },
    teardown() {
      unmountView();
      stopStockWatch();
      bioWatch.observer?.disconnect();
      clearTimeout(bioWatch.timer);
      document.querySelectorAll("[data-hera-seerr], .hera-person-role, .hera-readmore:not(.hera-detail-more)").forEach((node) => node.remove());
      document.querySelectorAll(".hera-seerr-covered").forEach((node) => node.classList.remove("hera-seerr-covered"));
      cleanups.splice(0).forEach((fn) => fn());
    },
  });

  start();
})();
