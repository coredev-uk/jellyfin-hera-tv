/*
 * Hera TV: grouped collections. Registers with window.HeraTV (hera-tv.js).
 * Jellyfin's Collections library is one grid of every BoxSet. This turns it into shelves, one per
 * group (Seasonal, Franchises, Universes, Awards, Streaming, ...), from the server's own
 * GET /HeraTV/collections/groups: the franchises the TMDb Box Sets plugin makes and the
 * collections Hera builds, already filtered to what this person can see.
 *  - Streaming and Networks are wide cards: the service's name over its dimmed backdrop. Every
 *    other group is posters.
 *  - A Groups | All switch, remembered in this browser, keeps Jellyfin's own grid one tap away.
 *  - Jellyfin's grid is hidden only while the shelves are on the page (`hera-collections-on`);
 *    if the endpoint fails or has nothing to show, the stock grid is left as it is.
 * HeraTV.collections.render(container, data) draws the shelves from any response, so the same
 * code paints the live page and a sample.
 */
(() => {
  "use strict";

  const HT = window.HeraTV;
  if (!HT?.kit) return;
  const { kit } = HT;
  const { el } = kit;

  const root = document.documentElement;
  const PAGE_ID = "boxsetsPage";
  const MODE_KEY = "hera-collections-view";
  const REFRESH_MS = 60 * 1000;
  // Services read better as a backdrop with a name over it than as a poster of one film.
  const WIDE_GROUPS = new Set(["streaming", "networks"]);
  // The Seasonal shelf leads while it is in season; the rest follow the server's order.
  const LEADING_GROUP = "seasonal";

  const state = { root: null, token: 0, at: 0, pageWatch: null, loaded: null };

  // ---------- the remembered view -----------------------------------------------------------

  const readMode = () => {
    try {
      return localStorage.getItem(MODE_KEY) === "all" ? "all" : "groups";
    } catch {
      return "groups";
    }
  };

  const rememberMode = (mode) => {
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      /* no storage: the choice lasts until the page is left */
    }
  };

  // ---------- data --------------------------------------------------------------------------

  // One fetch per person, kept for a minute so flipping between tabs doesn't refetch each time;
  // a failure is forgotten at once.
  const fetchGroups = () => {
    const user = kit.userId();
    if (state.loaded?.user === user && Date.now() - state.loaded.at < REFRESH_MS) return state.loaded.promise;
    const promise = Promise.resolve(kit.hera("collections/groups")).catch((error) => {
      if (state.loaded?.promise === promise) state.loaded = null;
      throw error;
    });
    state.loaded = { user, at: Date.now(), promise };
    return promise;
  };

  // Empty collections and groups are dropped, so a shelf never has nothing on it.
  const normalise = (data) => {
    const groups = (data?.groups ?? [])
      .map((group) => ({ ...group, collections: (group.collections ?? []).filter((c) => c?.id && c.count > 0) }))
      .filter((group) => group.id && group.collections.length);
    const lead = groups.filter((group) => group.id === LEADING_GROUP);
    return [...lead, ...groups.filter((group) => group.id !== LEADING_GROUP)];
  };

  // ---------- cards -------------------------------------------------------------------------

  // "3 films" for a set of films (franchises are, and a collection may say so itself with `kind`),
  // "12 titles" for anything that may hold a series.
  const countText = (collection, group) => {
    const films = collection.kind ? collection.kind === "movie" : group.id === "franchises";
    const n = collection.count;
    return `${n.toLocaleString()} ${films ? (n === 1 ? "film" : "films") : n === 1 ? "title" : "titles"}`;
  };

  const detailsHref = (collection) => `#/details?id=${collection.id}`;

  // Hera's own sets show the art the server picked first (`imageId`/`backdropId`: a member's own
  // image, distinct across sets, under an id whose image never changes, so a cached copy is always
  // right; asked for without a tag, a BoxSet's image can be a cached older one after Hera re-picks
  // its art). Franchise sets from TMDb Box Sets have artwork of their own, so theirs comes first.
  // Each image that fails to load hands over to the next; with none left the card shows its name.
  const sourcesFor = (collection, type, width, group) => {
    const picked = type === "Backdrop" ? collection.backdropId : collection.imageId;
    const order = group?.id === "franchises" ? [collection.id, picked] : [picked, collection.id];
    return order.filter((id, index, ids) => id && ids.indexOf(id) === index).map((id) => kit.imageUrl(id, type, { maxWidth: width }));
  };

  const chainArt = (art, img, sources, onBare) => {
    let next = 1;
    img.addEventListener("error", () => {
      if (next < sources.length) {
        img.src = sources[next++];
        return;
      }
      img.remove();
      onBare();
    });
  };

  const posterCard = (collection, group) => {
    const sources = sourcesFor(collection, "Primary", 400, group);
    const subtitle = countText(collection, group);
    const card = kit.card({ href: detailsHref(collection), image: sources[0], title: collection.name, subtitle });
    const art = card.querySelector(".hera-card__art");
    const img = art.querySelector("img");
    if (img) {
      chainArt(art, img, sources, () => art.prepend(el("span", { class: "hera-card__fallback", text: collection.name })));
    }
    return card;
  };

  // A wide card has no title line under it: the service's name is on the artwork. The art comes
  // from the set's best member, so a logo or an undimmed backdrop would read as that show.
  const wideCard = (collection, group) => {
    const sources = sourcesFor(collection, "Backdrop", 640, group);
    const subtitle = countText(collection, group);
    const card = kit.card({
      href: detailsHref(collection),
      image: sources[0],
      shape: "wide",
      subtitle,
      label: `${collection.name}, ${subtitle}`,
    });
    const art = card.querySelector(".hera-card__art");
    art.classList.add("hera-collections__art");
    art.querySelector(".hera-card__fallback")?.remove();
    const img = art.querySelector("img");
    const bare = () => art.classList.add("is-bare");
    if (img) chainArt(art, img, sources, bare);
    else bare();

    const name = el("span", { class: "hera-collections__name", text: collection.name });
    // `hera-dark` keeps the name white in the light scheme too: it sits on artwork, not on the page.
    const face = el("span", { class: "hera-collections__face hera-dark" }, name);
    art.append(face);
    logoOn(face, name, collection.logo);
    return card;
  };

  // A streaming service's card shows its logo, the way Seerr's Networks row does: the TMDB network
  // wordmark through TMDB's white duotone filter, or, for a service with no network of its own, its
  // app icon. Either replaces the name; the card's label still says it, so the image is decorative.
  // One that fails to load brings the name back.
  const TMDB = "https://image.tmdb.org/t/p/";
  const logoOn = (face, name, logo) => {
    const path = logo?.wordmark || logo?.icon;
    if (!path) return;
    const wordmark = !!logo.wordmark;
    const img = el("img", {
      class: wordmark ? "hera-collections__wordmark" : "hera-collections__icon",
      src: wordmark ? `${TMDB}w300_filter(duotone,ffffff,bababa)${path}` : `${TMDB}w154${path}`,
      alt: "",
      decoding: "async",
      loading: "lazy",
    });
    img.addEventListener("error", () => {
      img.remove();
      face.classList.remove("has-logo");
    }, { once: true });
    face.classList.add("has-logo");
    face.insertBefore(img, name);
  };

  const shelfFor = (group) => {
    const wide = WIDE_GROUPS.has(group.id);
    return kit.shelf({
      id: `collections:${group.id}`,
      title: group.title || group.id,
      shape: wide ? "wide" : "poster",
      cards: group.collections.map((collection) => (wide ? wideCard(collection, group) : posterCard(collection, group))),
    });
  };

  // ---------- the switch --------------------------------------------------------------------

  const MODES = [
    { mode: "groups", label: "Groups", description: "Collections in groups" },
    { mode: "all", label: "All", description: "All collections" },
  ];

  const modeSwitch = (mode, onPick) => {
    const buttons = MODES.map((entry) =>
      el("button", {
        type: "button",
        class: "hera-collections__mode",
        "aria-pressed": String(entry.mode === mode),
        "aria-label": entry.description,
        text: entry.label,
        onclick: () => onPick(entry.mode),
      }),
    );
    return el("div", { class: "hera-collections__switch", role: "group", "aria-label": "View" }, buttons);
  };

  // ---------- drawing -----------------------------------------------------------------------

  /**
   * Draws the switch and one shelf per group into `container` from one /collections/groups
   * response and returns how many shelves there are (0 draws nothing). `opts`: `mode`
   * ("groups" or "all") and `onMode(mode)` when the switch is used.
   */
  const render = (container, data, opts = {}) => {
    const groups = normalise(data);
    container.classList.add("hera-collections");
    container.removeAttribute("aria-busy");
    if (!groups.length) {
      container.replaceChildren();
      return 0;
    }
    const body = el("div", { class: "hera-collections__groups" }, groups.map(shelfFor));
    const apply = (mode) => {
      container.dataset.mode = mode;
      body.hidden = mode !== "groups";
      container.querySelectorAll(".hera-collections__mode").forEach((button, index) => {
        button.setAttribute("aria-pressed", String(MODES[index].mode === mode));
      });
    };
    const bar = el("div", { class: "hera-collections__bar" }, modeSwitch(opts.mode ?? "groups", (mode) => {
      apply(mode);
      opts.onMode?.(mode);
    }));
    container.replaceChildren(bar, body);
    apply(opts.mode ?? "groups");
    return groups.length;
  };

  const loading = (container) => {
    container.classList.add("hera-collections");
    container.dataset.mode = "groups";
    container.setAttribute("aria-busy", "true");
    const row = (wide) =>
      el("div", { class: "hera-collections__bones", "aria-hidden": "true" }, [
        el("span", { class: "hera-collections__bone hera-collections__bone--title" }),
        el(
          "div",
          { class: `hera-collections__bones-row${wide ? " is-wide" : ""}` },
          Array.from({ length: wide ? 5 : 8 }, () => el("span", { class: "hera-collections__bone hera-collections__bone--card" })),
        ),
      ]);
    container.replaceChildren(
      el("div", { class: "hera-collections__skeleton", role: "status" }, [
        el("span", { class: "hera-collections__sr", text: "Loading collections" }),
        row(false),
        row(false),
        row(true),
      ]),
    );
  };

  // ---------- the view ----------------------------------------------------------------------

  const unmount = () => {
    state.token++;
    state.pageWatch?.disconnect();
    state.pageWatch = null;
    state.root?.remove();
    state.root = null;
    root.classList.remove("hera-collections-on");
  };

  // The stock grid took focus when the page showed; with it hidden, a remote has nothing under
  // its thumb until focus moves to the first card.
  const settleFocus = (container) => {
    if (!kit.isTv()) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.isConnected && !active.closest(`#${PAGE_ID} .padded-bottom-page`)) return;
    if (active?.closest(".hera-collections")) return;
    container.querySelector(".hera-collections__groups:not([hidden]) .hera-card, .hera-collections__mode[aria-pressed='true']")?.focus({ preventScroll: true });
  };

  const draw = (container, data, mode) => {
    const count = render(container, data, {
      mode,
      onMode: (next) => {
        rememberMode(next);
        root.classList.toggle("hera-collections-on", next === "groups");
      },
    });
    state.at = Date.now();
    return count;
  };

  // Jellyfin's page can swap its own body (switching library tabs); the shelves are put back.
  const watchPage = (page) => {
    state.pageWatch?.disconnect();
    const watch = new MutationObserver(() => {
      if (!state.root?.isConnected && !page.classList.contains("hide")) mount(page);
    });
    watch.observe(page, { childList: true });
    state.pageWatch = watch;
  };

  const mount = async (page) => {
    const body = page.querySelector(HT.jf.libraryBody);
    if (!body || !kit.userId()) return;
    if (state.root?.isConnected && body.contains(state.root)) {
      // Back on a page Jellyfin kept: quietly bring the shelves up to date.
      if (Date.now() - state.at > REFRESH_MS) {
        const mine = state.root;
        const token = ++state.token;
        try {
          const data = await fetchGroups();
          if (token === state.token && mine.isConnected) draw(mine, data, mine.dataset.mode === "all" ? "all" : "groups");
        } catch {
          /* the shelves on show stand */
        }
      }
      return;
    }
    unmount();
    const mine = el("div", { class: "hera-collections", "data-hera-collections": "" });
    body.prepend(mine);
    state.root = mine;
    const token = ++state.token;
    const mode = readMode();
    // Skeleton and hidden grid only for the view the person chose; "All" keeps the stock grid up
    // while we find out whether there are groups to switch to.
    if (mode === "groups") {
      loading(mine);
      root.classList.add("hera-collections-on");
    }
    let data = null;
    try {
      data = await fetchGroups();
    } catch (error) {
      console.warn("[Hera TV:collections]", error);
    }
    if (token !== state.token || !mine.isConnected) return;
    if (!draw(mine, data, mode)) {
      unmount();
      return;
    }
    root.classList.toggle("hera-collections-on", mode === "groups");
    watchPage(page);
    settleFocus(mine);
  };

  HT.register({
    name: "collections-browse",
    // The shelves sit in the library page's body, in front of Jellyfin's own grid.
    requires: { [PAGE_ID]: ["libraryBody"] },
    onView(page) {
      if (page.id !== PAGE_ID) {
        if (state.root) unmount();
        return;
      }
      return mount(page);
    },
    teardown() {
      unmount();
      delete HT.collections;
    },
  });

  HT.collections = { render, loading };
})();
