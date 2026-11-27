/*
 * Hera TV: player module. Registers with window.HeraTV (hera-tv.js).
 *  - Keeps the player dark in either scheme (the picture sets the light, not the Appearance setting).
 *  - The title block at the foot of the player ("Brooklyn Nine-Nine" / "S1, E1 · Pilot").
 *  - The pause screen: after a few quiet seconds paused, the picture dims and the title's logo,
 *    synopsis, time left and a Resume / Restart pair settle at the lower left, as on tvOS.
 *  - Post-play: when the credits roll, the picture shrinks to the top left and what comes next
 *    fills the screen, as on tvOS: the next episode's still, or for a film the next one in its
 *    collection (or one like it) with its trailer playing.
 */
(() => {
  "use strict";

  const heraTv = window.HeraTV;
  if (!heraTv) return;
  const { api, el, icon, getJSON, imageUrl, runtime, userId, hera, play, reduceMotion, prefs } = heraTv.kit;
  const { jf } = heraTv;

  const PAUSE_DELAY = 3000;
  const FADE_OUT = 200;
  const NAV_KEYS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Tab"];

  const osd = { timer: 0, stop: null };

  // What the server says is playing in this browser: the item, its position and the session id
  // that remote commands (restart) are addressed to. The page has no public handle on any of it.
  const nowPlaying = async () => {
    const sessions = await getJSON("Sessions", { deviceId: api().deviceId() });
    const session = sessions?.find((s) => s.NowPlayingItem);
    return session ? { session, item: session.NowPlayingItem } : null;
  };

  const episodeCode = (item) =>
    item.Type === "Episode" && item.ParentIndexNumber != null && item.IndexNumber != null ? `S${item.ParentIndexNumber}, E${item.IndexNumber}` : null;

  // ---------- title block ------------------------------------------------------------------
  // tv.apple.com titles the player at its foot: the show (or film) large, then "S1, E1 · Pilot".
  // A light poll follows autoplay into the next episode.

  const renderOsdTitle = async (page) => {
    const controls = page.querySelector(".osdControls");
    if (!controls) return;
    const playing = await nowPlaying();
    const item = playing?.item;
    const existing = controls.querySelector(".hera-osd-title");
    if (!item) {
      existing?.remove();
      return;
    }
    if (existing?.dataset.item === item.Id) return;
    const episode = item.Type === "Episode";
    const line = episode
      ? [episodeCode(item), item.Name].filter(Boolean).join(" · ")
      : [item.ProductionYear, runtime(item.RunTimeTicks)].filter(Boolean).join(" · ");
    const node = el("div", { class: "hera-osd-title", "data-item": item.Id }, [
      el("p", { class: "hera-osd-title__name", text: episode ? item.SeriesName || item.Name : item.Name }),
      line ? el("p", { class: "hera-osd-title__line", text: line }) : null,
    ]);
    existing?.remove();
    controls.prepend(node);
  };

  // Autoplay moves on to the next episode by loading it into the same <video>, so the title is
  // looked up again when a new one loads (a moment later, once playback registers with the server).
  // A slow poll is the net under it, and nothing runs while the tab is hidden.
  const stopFollow = () => {
    clearInterval(osd.timer);
    osd.stop?.();
    osd.stop = null;
  };

  const followPlayer = (page) => {
    stopFollow();
    const tick = () => {
      if (!document.hidden) renderOsdTitle(page).catch(() => {});
    };
    renderOsdTitle(page).catch(() => {});
    // Playback registers with the server a moment after the page shows.
    setTimeout(tick, 2500);
    osd.timer = setInterval(() => {
      if (page.classList.contains("hide") || !page.isConnected) stopFollow();
      else tick();
    }, 60000);
    let settle = 0;
    // Media events do not bubble; the capture phase sees them whichever <video> the player uses.
    const onMedia = (event) => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      clearTimeout(settle);
      settle = setTimeout(tick, 2500);
    };
    document.addEventListener("loadedmetadata", onMedia, true);
    document.addEventListener("emptied", onMedia, true);
    document.addEventListener("visibilitychange", tick);
    osd.stop = () => {
      clearTimeout(settle);
      document.removeEventListener("loadedmetadata", onMedia, true);
      document.removeEventListener("emptied", onMedia, true);
      document.removeEventListener("visibilitychange", tick);
    };
  };

  // ---------- always dark ------------------------------------------------------------------
  // Light mode never reaches the player: the page, the header it borrows, and the sheets and
  // menus opened from it all take the dark token set (.hera-dark in hera-tv.css).

  const dark = { headers: [], bodyObserver: null };

  // Overlays appended to <body>, outside the page: sheets, menus and Intro Skipper's button.
  const DARK_OVERLAYS = ["dialogContainer", "MuiPopover-root", "MuiModal-root", "skip-button-container"];
  const isOverlay = (node) => node.nodeType === 1 && DARK_OVERLAYS.some((name) => node.classList.contains(name));

  const startDark = (page) => {
    page.classList.add("hera-dark");
    // Jellyfin 12 keeps two headers (the legacy one and the MUI app bar's); the player shows
    // whichever it uses, so both go dark while it is up.
    dark.headers = [...document.querySelectorAll(jf.legacyHeader)];
    dark.headers.forEach((header) => header.classList.add("hera-dark"));
    if (dark.bodyObserver) return;
    for (const node of document.body.children) if (isOverlay(node)) node.classList.add("hera-dark");
    dark.bodyObserver = new MutationObserver((records) => {
      if (page.classList.contains("hide")) return;
      for (const record of records) {
        for (const node of record.addedNodes) if (isOverlay(node)) node.classList.add("hera-dark");
      }
    });
    dark.bodyObserver.observe(document.body, { childList: true });
  };

  const stopDark = () => {
    dark.bodyObserver?.disconnect();
    dark.headers.forEach((header) => header.classList.remove("hera-dark"));
    dark.headers = [];
    dark.bodyObserver = null;
  };

  // ---------- skip button --------------------------------------------------------------------
  // Jellyfin parks Skip Intro / Skip Credits at a fixed height, which the control capsule covers
  // when it shows. While the OSD is up the button rises to sit just above the capsule, as
  // tv.apple.com lifts it over the scrubber; the gap is measured, so the TV layout's taller
  // controls are cleared too.
  const skipLift = { observer: null };

  const liftSkip = (bar) => {
    const shown = !bar.classList.contains("videoOsdBottom-hidden") && !bar.classList.contains("hide");
    const capsule = shown ? bar.querySelector(".osdControls .buttons") : null;
    const top = capsule?.getBoundingClientRect().top;
    const root = document.documentElement;
    if (top > 0) root.style.setProperty("--hera-skip-clear", `${Math.round(window.innerHeight - top + 14)}px`);
    root.classList.toggle("hera-osd-up", !!(top > 0));
  };

  const followSkip = (page) => {
    stopSkip();
    const bar = page.querySelector(jf.videoOsd);
    if (!bar) return;
    liftSkip(bar);
    // Measured again once the OSD's slide-in has finished, so the gap is to where it settles.
    skipLift.observer = new MutationObserver(() => {
      liftSkip(bar);
      setTimeout(() => liftSkip(bar), 400);
    });
    skipLift.observer.observe(bar, { attributes: true, attributeFilter: ["class"] });
  };

  const stopSkip = () => {
    skipLift.observer?.disconnect();
    skipLift.observer = null;
    document.documentElement.classList.remove("hera-osd-up");
  };

  // ---------- pause screen -----------------------------------------------------------------
  // Shown once the video has been paused for PAUSE_DELAY with the OSD out of the way (or the
  // moment the OSD hides while paused). A key, a touch or a click on the picture gives the OSD
  // back (still paused) and fades this out; resuming removes it. A mouse can move freely, so it
  // can reach the buttons; navigation keys step onto them, so a remote can use them too.

  const pauseScreen = {
    page: null,
    layer: null,
    cleanups: [],
    timer: 0,
    pausedAt: 0,
    generation: 0,
    pointer: { x: -1, y: -1 },
    details: new Map(),
  };

  const video = () => document.querySelector(".videoPlayerContainer video") || document.querySelector("video");

  const osdBar = () => pauseScreen.page?.querySelector(jf.videoOsd) ?? null;

  const osdVisible = () => {
    const bar = osdBar();
    if (!bar) return false;
    return !bar.classList.contains("videoOsdBottom-hidden") && !bar.classList.contains("hide");
  };

  // A sheet, or the post-play screen, already has the picture.
  const sheetOpen = () => !!document.querySelector(".dialogContainer .dialog") || !!post.layer;

  const isPaused = () => {
    const v = video();
    return !!v && v.paused && !v.ended && !v.seeking && v.readyState > 0;
  };

  // The few titles the pause screen has shown; the oldest goes when a new one comes in.
  const DETAILS_KEPT = 12;
  const loadDetails = async (id) => {
    const cache = pauseScreen.details;
    if (!cache.has(id)) {
      if (cache.size >= DETAILS_KEPT) cache.delete(cache.keys().next().value);
      cache.set(id, getJSON(`Users/${userId()}/Items/${id}`).catch(() => null));
    }
    return cache.get(id);
  };

  // 24-hour clock, British locale: "21:41".
  const endsAt = (ms) => new Date(Date.now() + ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });

  const timeLeft = (ticks) => {
    const minutes = Math.round(ticks / 600000000);
    return minutes < 1 ? "Less than a minute left" : `${runtime(ticks)} left`;
  };

  const logoFor = (item) => {
    if (item.ImageTags?.Logo) return imageUrl(item.Id, "Logo", { maxWidth: 700, tag: item.ImageTags.Logo });
    if (item.ParentLogoItemId && item.ParentLogoImageTag) return imageUrl(item.ParentLogoItemId, "Logo", { maxWidth: 700, tag: item.ParentLogoImageTag });
    return null;
  };

  const castStrip = (item) => {
    const cast = (item.People || []).filter((p) => p.Type === "Actor").slice(0, 6);
    if (!cast.length) return null;
    return el(
      "ul",
      { class: "hera-pause__cast", "aria-label": "Cast" },
      cast.map((person) => {
        const portrait = person.PrimaryImageTag
          ? el("img", { src: imageUrl(person.Id, "Primary", { maxWidth: 200, tag: person.PrimaryImageTag }), alt: "", loading: "lazy" })
          : icon("person");
        return el("li", { class: "hera-pause__person" }, [
          el("span", { class: "hera-pause__portrait" }, [portrait]),
          el("span", { class: "hera-pause__person-name", text: person.Name }),
        ]);
      }),
    );
  };

  const buildLayer = (playing, item, left) => {
    const shown = playing.item;
    const logo = logoFor(item);
    const episode = item.Type === "Episode";
    const line = episode
      ? [episodeCode(item), item.Name].filter(Boolean).join(" · ")
      : [item.ProductionYear, (item.Genres || []).slice(0, 2).join(", ")].filter(Boolean).join(" · ");
    const name = episode ? item.SeriesName || item.Name : item.Name;

    const resume = el("button", { class: "hera-pause__button hera-pause__button--primary", type: "button" }, [icon("play_arrow"), el("span", { text: "Resume" })]);
    const restart = el("button", { class: "hera-pause__button", type: "button" }, [icon("replay"), el("span", { text: "Restart" })]);
    // Jellyfin toggles playback on a click that reaches the page; these buttons are their own.
    resume.addEventListener("click", (event) => {
      event.stopPropagation();
      resumePlayback(playing.session.Id);
    });
    restart.addEventListener("click", (event) => {
      event.stopPropagation();
      restartPlayback(playing.session.Id);
    });

    const timeline = left > 0 ? `${timeLeft(left)} · Ends at ${endsAt(left / 10000)}` : null;

    return el("div", { class: "hera-pause hera-dark", "data-item": shown.Id, role: "region", "aria-label": "Paused" }, [
      el("div", { class: "hera-pause__scrim" }),
      el("div", { class: "hera-pause__info" }, [
        logo ? el("img", { class: "hera-pause__logo", src: logo, alt: name }) : el("h2", { class: "hera-pause__name", text: name }),
        line ? el("p", { class: "hera-pause__line", text: line }) : null,
        item.Overview ? el("p", { class: "hera-pause__overview", text: item.Overview }) : null,
        timeline ? el("p", { class: "hera-pause__time", text: timeline }) : null,
        el("div", { class: "hera-pause__actions" }, [resume, restart]),
      ]),
      castStrip(item),
    ]);
  };

  const hideLayer = () => {
    const layer = pauseScreen.layer;
    if (!layer) return;
    pauseScreen.layer = null;
    layer.classList.remove("is-on");
    // Focus must not stay on a control that is leaving.
    if (layer.contains(document.activeElement)) document.activeElement.blur();
    setTimeout(() => layer.remove(), FADE_OUT);
  };

  const cancelTimer = () => {
    clearTimeout(pauseScreen.timer);
    pauseScreen.timer = 0;
  };

  const showLayer = async () => {
    const generation = ++pauseScreen.generation;
    const page = pauseScreen.page;
    if (!page || pauseScreen.layer) return;
    const playing = await nowPlaying().catch(() => null);
    if (!playing || generation !== pauseScreen.generation) return;
    const item = await loadDetails(playing.item.Id);
    // The world moved on while the data loaded: the user resumed, or woke the OSD.
    if (!item || generation !== pauseScreen.generation || !isPaused() || !osdBar() || osdVisible() || sheetOpen()) return;
    const total = playing.item.RunTimeTicks || item.RunTimeTicks || 0;
    const left = total ? Math.max(0, total - (playing.session.PlayState?.PositionTicks || 0)) : 0;
    // Nothing to rest on at the very end: Up Next takes over there.
    if (total && left < 30000000) return;
    const layer = buildLayer(playing, item, left);
    pauseScreen.layer = layer;
    // First child: beneath the OSD, which is later in the page.
    page.prepend(layer);
    // Two frames: the hidden state must paint once for the fade to run.
    requestAnimationFrame(() => requestAnimationFrame(() => layer.classList.add("is-on")));
  };

  // Decide what the pause screen should be doing right now.
  const reconcile = (immediate) => {
    // With no OSD to read, the pause screen cannot tell when it would sit over the controls.
    if (!isPaused() || !osdBar() || osdVisible() || sheetOpen()) {
      cancelTimer();
      pauseScreen.generation++;
      hideLayer();
      return;
    }
    if (pauseScreen.layer || pauseScreen.timer) return;
    const wait = immediate ? 0 : Math.max(0, PAUSE_DELAY - (Date.now() - pauseScreen.pausedAt));
    pauseScreen.timer = setTimeout(() => {
      pauseScreen.timer = 0;
      if (isPaused() && !osdVisible()) showLayer().catch(() => {});
    }, wait);
  };

  // Activity of any kind hands the screen back to the OSD. The timer restarts so a still-paused
  // picture settles again once the OSD has gone quiet.
  const wake = () => {
    cancelTimer();
    pauseScreen.generation++;
    hideLayer();
    pauseScreen.pausedAt = Date.now();
    if (isPaused()) setTimeout(() => reconcile(false), 0);
  };

  const focusables = () => [...(pauseScreen.layer?.querySelectorAll(".hera-pause__button") || [])];

  const onKey = (event) => {
    const layer = pauseScreen.layer;
    if (!layer) return;
    if (NAV_KEYS.includes(event.key)) {
      const buttons = focusables();
      const index = buttons.indexOf(document.activeElement);
      // First nav key lands on Resume; then left/right (or Tab) move along the row.
      let next = 0;
      if (index >= 0) {
        const step = event.key === "ArrowLeft" || (event.key === "Tab" && event.shiftKey) ? -1 : event.key === "ArrowRight" || event.key === "Tab" ? 1 : 0;
        if (!step) return wake();
        next = index + step;
        if (next < 0 || next >= buttons.length) return wake();
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      buttons[next]?.focus();
      return;
    }
    // Enter or Space on a focused button does that button's job, not "toggle playback".
    if ((event.key === "Enter" || event.key === " ") && layer.contains(document.activeElement)) {
      event.stopImmediatePropagation();
      return;
    }
    wake();
  };

  // With a mouse, the pause screen must survive the pointer travelling to its buttons, so
  // movement alone never dismisses it (and never reaches Jellyfin, which would raise the OSD over
  // it). A press on the picture hands the screen back to the OSD, still paused: the press is
  // swallowed, so it doesn't also toggle playback underneath.
  const onPointer = (event) => {
    if (!pauseScreen.layer) {
      if (event.type === "click" || event.type === "pointerup" || event.type === "mouseup") {
        if (pauseScreen.swallow) {
          event.stopPropagation();
          event.preventDefault();
          if (event.type === "click") pauseScreen.swallow = false;
        }
        return;
      }
      if (event.type === "mousemove" || event.type === "pointermove") {
        // Chrome repeats a move when content appears under a resting pointer.
        const { x, y } = pauseScreen.pointer;
        pauseScreen.pointer = { x: event.clientX, y: event.clientY };
        if (event.clientX === x && event.clientY === y) return;
      }
      return wake();
    }
    if (event.target.closest?.(".hera-pause__actions")) {
      // Jellyfin never sees a pointer that is using the buttons.
      if (event.type !== "click") event.stopPropagation();
      return;
    }
    if (event.type === "mousemove" || event.type === "pointermove") {
      event.stopPropagation();
      // Jellyfin hid the cursor with the OSD and never hears this move, so show it here, and
      // hide it again once the pointer rests.
      const layer = pauseScreen.layer;
      layer.classList.add("has-pointer");
      clearTimeout(pauseScreen.pointerTimer);
      pauseScreen.pointerTimer = setTimeout(() => layer.classList.remove("has-pointer"), 2500);
      return;
    }
    if (event.type === "pointerdown" || event.type === "mousedown" || event.type === "touchstart") {
      event.stopPropagation();
      pauseScreen.swallow = true;
      setTimeout(() => (pauseScreen.swallow = false), 600);
      wake();
      // The press was the user reaching for the controls: raise the OSD the way Jellyfin does,
      // from a pointer move, which it never got while the pause screen held the pointer. Jellyfin
      // ignores moves under 10px of screen distance from the last it saw, so two moves 24px apart
      // guarantee one counts.
      const point = event.touches?.[0] || event;
      setTimeout(() => {
        for (const step of [0, 24]) {
          const init = { bubbles: true, pointerType: "mouse", clientX: point.clientX + step, clientY: point.clientY, screenX: point.screenX + step, screenY: point.screenY };
          document.dispatchEvent(new PointerEvent("pointermove", init));
          document.dispatchEvent(new MouseEvent("mousemove", init));
        }
      }, 0);
      return;
    }
    wake();
  };

  const onMedia = (event) => {
    const target = event.target;
    if (!(target instanceof HTMLVideoElement)) return;
    if (event.type === "pause" || event.type === "seeked" || event.type === "canplay") {
      // A transcode reloads its stream on a seek and stays paused without a pause event of its
      // own, so the end of a seek starts the wait again.
      if (event.type === "pause" || isPaused()) {
        pauseScreen.pausedAt = Date.now();
        reconcile(false);
      }
    } else {
      cancelTimer();
      pauseScreen.generation++;
      hideLayer();
    }
  };

  // Resume and Restart go through Jellyfin's own session commands, so a transcode seeks properly.
  const sessionCommand = (sessionId, command, query) =>
    api().ajax({ type: "POST", url: api().getUrl(`Sessions/${sessionId}/Playing/${command}`, query) });

  const resumePlayback = async (sessionId) => {
    hideLayer();
    await sessionCommand(sessionId, "Unpause").catch(() => video()?.play());
  };

  const restartPlayback = async (sessionId) => {
    hideLayer();
    const v = video();
    // An Unpause that lands while the stream is still re-seeking is dropped, so wait for the
    // seek to finish (a transcode restarts its stream) before resuming.
    const landed = v ? new Promise((done) => v.addEventListener("seeked", done, { once: true })) : Promise.resolve();
    await sessionCommand(sessionId, "Seek", { seekPositionTicks: 0 }).catch(() => {
      if (v) v.currentTime = 0;
    });
    await Promise.race([landed, new Promise((done) => setTimeout(done, 2500))]);
    await sessionCommand(sessionId, "Unpause").catch(() => {});
    // Belt and braces: the element itself, should the command have been dropped regardless.
    setTimeout(() => {
      if (isPaused()) video()?.play();
    }, 800);
  };

  const bindPause = (page) => {
    if (pauseScreen.page === page) return;
    unbindPause();
    pauseScreen.page = page;
    const on = (target, type, fn, capture) => {
      target.addEventListener(type, fn, capture);
      pauseScreen.cleanups.push(() => target.removeEventListener(type, fn, capture));
    };
    // Media events do not bubble, but they can be caught on the way down; that survives the
    // <video> element being replaced between items.
    for (const type of ["pause", "seeked", "canplay", "play", "playing", "ended", "emptied", "seeking"]) on(document, type, onMedia, true);
    on(window, "keydown", onKey, true);
    for (const type of ["pointermove", "mousemove", "pointerdown", "mousedown", "touchstart", "wheel", "pointerup", "mouseup", "click"]) on(window, type, onPointer, true);

    // The OSD hiding while paused is the other trigger.
    const bar = page.querySelector(jf.videoOsd);
    if (bar) {
      let visible = osdVisible();
      const observer = new MutationObserver(() => {
        const now = osdVisible();
        if (now === visible) return;
        visible = now;
        reconcile(!now);
      });
      observer.observe(bar, { attributes: true, attributeFilter: ["class"] });
      pauseScreen.cleanups.push(() => observer.disconnect());
    }
    // A sheet closing hands the screen back as well.
    const sheets = new MutationObserver(() => reconcile(false));
    sheets.observe(document.body, { childList: true });
    pauseScreen.cleanups.push(() => sheets.disconnect());
  };

  const unbindPause = () => {
    cancelTimer();
    pauseScreen.generation++;
    pauseScreen.layer?.remove();
    pauseScreen.layer = null;
    pauseScreen.cleanups.splice(0).forEach((fn) => fn());
    pauseScreen.page = null;
    pauseScreen.details.clear();
  };

  // ---------- post-play ----------------------------------------------------------------------
  // tvOS at the credits: the picture shrinks into the top left corner and keeps playing, and what
  // comes next takes the screen. An episode offers the next one, its still filling the screen, and
  // fills its Play button as the episode runs out when autoplay is on; Jellyfin's own Up Next still
  // does the playing, so the queue and the person's autoplay setting hold. A film offers the next
  // unwatched film in its collection, or else an unwatched one like it, with its trailer playing
  // silently behind, and never starts it unasked. Watch Credits, the shrunken picture, Escape or
  // Back put the credits back full screen (Jellyfin's own Up Next card stays for an episode).
  // The credits start where Intro Skipper's outro segment says; an episode without one starts
  // when Jellyfin raises its Up Next, and a film without one gets no post-play.

  const post = {
    page: null,
    itemId: null,
    item: null,
    creditsAt: null,
    dismissed: null,
    preparing: null,
    opening: false,
    layer: null,
    backdrop: null,
    ticker: 0,
    autoplay: null,
    // A film's trailer: its frame, the volume it plays at and whether it's muted; the credits'
    // own volume to give back, and whether they were paused when the trailer took over.
    trailer: null,
    creditsVolume: null,
    creditsPaused: false,
    fadeTimer: 0,
    focusTimer: 0,
    // The volume popup raised for the trailer, and its fade timer.
    hud: null,
    hudTimer: 0,
    cleanups: [],
  };

  const playerFrame = () => document.querySelector(".videoPlayerContainer");
  const jellyfinUpNext = () => document.querySelector(".upNextDialog:not(.hide)");

  // The end credits: the last outro segment, and only one that runs to within a minute of the end.
  const creditsStart = async (item) => {
    const result = await getJSON(`MediaSegments/${item.Id}`, { includeSegmentTypes: "Outro" }).catch(() => null);
    const total = (item.RunTimeTicks || 0) / 1e7;
    const outro = (result?.Items || [])
      .filter((segment) => !total || total - segment.EndTicks / 1e7 < 60)
      .sort((a, b) => b.StartTicks - a.StartTicks)[0];
    return outro ? outro.StartTicks / 1e7 : null;
  };

  const nextEpisode = async (item) => {
    if (!item.SeriesId) return null;
    const result = await getJSON(`Shows/${item.SeriesId}/Episodes`, { userId: userId(), startItemId: item.Id, limit: 2, Fields: "Overview" });
    const next = result?.Items?.[1];
    return next ? { kind: "episode", item: next } : null;
  };

  const nextFilm = async (item) => {
    const chained = await hera(`collections/next/${item.Id}`).catch(() => null);
    if (chained?.id) {
      const film = await getJSON(`Users/${userId()}/Items/${chained.id}`).catch(() => null);
      if (film) return { kind: "film", item: film, reason: `Next in ${chained.collection}` };
    }
    const similar = await getJSON(`Items/${item.Id}/Similar`, { userId: userId(), limit: 12 }).catch(() => null);
    const pick = (similar?.Items || []).find((candidate) => candidate.Type === "Movie" && !candidate.UserData?.Played);
    const film = pick ? await getJSON(`Users/${userId()}/Items/${pick.Id}`).catch(() => null) : null;
    return film ? { kind: "film", item: film, reason: `Because you watched ${item.Name}` } : null;
  };

  const stillFor = (next) => {
    const item = next.item;
    if (next.kind === "episode" && item.ImageTags?.Primary) return imageUrl(item.Id, "Primary", { maxWidth: 1920, tag: item.ImageTags.Primary });
    if (item.BackdropImageTags?.length) return imageUrl(item.Id, "Backdrop", { maxWidth: 1920, tag: item.BackdropImageTags[0] });
    if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) {
      return imageUrl(item.ParentBackdropItemId, "Backdrop", { maxWidth: 1920, tag: item.ParentBackdropImageTags[0] });
    }
    return null;
  };

  const youTubeId = (url) => /(?:v=|youtu\.be\/|embed\/)([\w-]{11})/.exec(url || "")?.[1] ?? null;

  // The trailer is driven through YouTube's postMessage API (enablejsapi=1); nothing loads its script.
  const YOUTUBE = "https://www.youtube-nocookie.com";
  const youTube = (frame, func, args = []) => frame?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), YOUTUBE);

  // ---------- trailers that play ----------------------------------------------------------
  // A video's owner can turn off playback outside youtube.com, and YouTube then draws its own
  // "Video unavailable" page in the frame. The server asks YouTube beforehand which of a title's
  // trailers may be embedded (/HeraTV/trailers); and a frame stays hidden until it reports that
  // it is playing, so one that fails anyway gives way to the next unseen.
  const START_MS = 12000;

  // A title page mounts twice (its viewshow, then the late remount for redrawn sections): ask the
  // server once per title for the session, forgetting a failed ask; the server keeps its own answer.
  const trailerChecks = new Map(); // itemId -> promise of the server's answer
  const trailerIds = async (item) => {
    if (!trailerChecks.has(item.Id)) {
      if (trailerChecks.size >= 50) trailerChecks.delete(trailerChecks.keys().next().value);
      const ask = hera(`trailers/${item.Id}`).catch(() => {
        trailerChecks.delete(item.Id);
        return null;
      });
      trailerChecks.set(item.Id, ask);
    }
    const checked = await trailerChecks.get(item.Id);
    if (Array.isArray(checked?.youtube)) return checked.youtube;
    return [...new Set((item.RemoteTrailers || []).map((trailer) => youTubeId(trailer.Url)).filter(Boolean))];
  };

  const trailerFrame = (id, { className, title, controls, muted }) =>
    el("iframe", {
      class: className,
      src: `${YOUTUBE}/embed/${id}?${new URLSearchParams({
        autoplay: "1",
        mute: muted ? "1" : "0",
        controls: controls ? "1" : "0",
        playsinline: "1",
        rel: "0",
        modestbranding: "1",
        iv_load_policy: "3",
        disablekb: controls ? "0" : "1",
        enablejsapi: "1",
        origin: window.location.origin,
      })}`,
      title,
      allow: "autoplay; encrypted-media; fullscreen; picture-in-picture",
      allowfullscreen: controls ? true : null,
      tabindex: controls ? null : "-1",
      referrerpolicy: "strict-origin-when-cross-origin",
    });

  const youTubeMessage = (event, frame) => {
    if (event.origin !== YOUTUBE || event.source !== frame.contentWindow) return null;
    try {
      return JSON.parse(event.data);
    } catch {
      return null;
    }
  };

  /**
   * Settles once the frame is playing ("playing"), YouTube refuses it ("error") or it has said
   * nothing for START_MS ("timeout"). Until it answers, the frame is asked to report its state,
   * which also lets the caller hear it end.
   */
  const startOf = (frame) =>
    new Promise((resolve) => {
      let heard = false;
      const ask = setInterval(() => {
        if (!heard) frame.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: "hera-trailer", channel: "widget" }), YOUTUBE);
      }, 300);
      const finish = (result) => {
        clearInterval(ask);
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(result);
      };
      const onMessage = (event) => {
        const data = youTubeMessage(event, frame);
        if (!data) return;
        heard = true;
        if (data.event === "onError") finish("error");
        else if (data.info?.playerState === 1) finish("playing");
      };
      const timer = setTimeout(() => finish("timeout"), START_MS);
      window.addEventListener("message", onMessage);
    });

  /**
   * Tries the ids in turn: `make(id)` builds a frame, `place(frame)` puts it in the page. The
   * first that plays is returned in place; a refused one is removed and the next tried. `alive()`
   * false stops it (the layer has gone). `keepWaiting` keeps a frame that only timed out (one a
   * click may still start) rather than move on.
   */
  const firstThatPlays = async (ids, { make, place, alive, keepWaiting = false }) => {
    for (const id of ids) {
      const frame = make(id);
      place(frame);
      const result = await startOf(frame);
      if (!alive()) {
        frame.remove();
        return null;
      }
      if (result === "playing" || (result === "timeout" && keepWaiting)) return { frame, id };
      frame.remove();
    }
    return null;
  };

  // The trailer's level at the player's full volume. Trailers are mixed far louder than a film's
  // credits, so it starts at half, scaled by the player's own volume, in the slider's steps of 5.
  const TRAILER_VOLUME = 50;
  const trailerLevel = (v) => Math.max(5, Math.round((TRAILER_VOLUME * (v ? v.volume : 1)) / 5) * 5);
  const FADE_MS = 1500;
  const FOCUS_AFTER_MS = 30000;

  // Under the shrunken picture: the next title's still or backdrop, and a film's trailer fading in
  // over it once it is playing (loadTrailer), so YouTube's loading frame or its "Video
  // unavailable" page never shows. Reduced motion keeps the still, and the credits' sound.
  const buildBackdrop = (next) => {
    const still = stillFor(next);
    return el("div", { class: "hera-post-backdrop", "aria-hidden": "true" }, [
      still ? el("img", { class: "hera-post-backdrop__still", src: still, alt: "" }) : null,
      el("div", { class: "hera-post-backdrop__scrim" }),
    ]);
  };

  // Muted to begin with, so it may start on its own; startTrailer brings its sound up. It plays
  // once: when it ends, the film's artwork takes the screen back. A film none of whose trailers
  // will play keeps its still.
  const loadTrailer = async (next, backdrop) => {
    if (next.kind !== "film" || reduceMotion.matches || !(await prefs.on("postplayTrailers"))) return;
    const ids = await trailerIds(next.item);
    const alive = () => post.backdrop === backdrop && !!post.layer;
    if (!ids.length || !alive()) return;
    const found = await firstThatPlays(ids, {
      make: (id) => trailerFrame(id, { className: "hera-post-backdrop__trailer", title: `${next.item.Name} trailer`, controls: false, muted: true }),
      place: (frame) => backdrop.insertBefore(frame, backdrop.lastChild),
      alive,
    });
    if (!found) return;
    found.frame.classList.add("is-on");
    startTrailer(found.frame);
  };

  // The credits' music fades out as the trailer's comes up. Thirty seconds in, the credits leave:
  // the picture fades from its corner and pauses, and the film being offered has the screen.
  const startTrailer = (frame) => {
    if (!post.layer || post.trailer) return;
    const v = video();
    post.trailer = { frame, volume: trailerLevel(v), muted: false };
    post.creditsVolume = v ? v.volume : null;
    youTube(frame, "setVolume", [0]);
    youTube(frame, "unMute");
    const start = Date.now();
    clearInterval(post.fadeTimer);
    post.fadeTimer = setInterval(() => {
      const t = Math.min(1, (Date.now() - start) / FADE_MS);
      if (v && post.creditsVolume !== null) v.volume = post.creditsVolume * (1 - t);
      if (!post.trailer.muted) youTube(frame, "setVolume", [Math.round(post.trailer.volume * t)]);
      if (t >= 1) clearInterval(post.fadeTimer);
    }, 100);
    post.layer.classList.add("has-trailer");
    syncSound();
    post.focusTimer = setTimeout(focusTrailer, FOCUS_AFTER_MS);
  };

  // The trailer has finished: it fades back to the film's artwork, its sound controls go, and
  // the credits (if still in their corner) leave too, paused and silent until Watch Credits.
  const endTrailer = () => {
    const trailer = post.trailer;
    if (!trailer || !post.layer) return;
    trailer.frame.classList.remove("is-on");
    post.layer.classList.remove("has-trailer");
    post.trailer = null;
    clearInterval(post.fadeTimer);
    clearTimeout(post.focusTimer);
    hideHud();
    focusTrailer();
  };

  // The player reports its state once asked (startOf); 0 is "ended".
  const onTrailerMessage = (event) => {
    const trailer = post.trailer;
    if (trailer && youTubeMessage(event, trailer.frame)?.info?.playerState === 0) endTrailer();
  };

  // ---------- the volume popup, for the trailer --------------------------------------------
  // The same popup Jellyfin raises for the player's volume (restyled in hera-player.css), raised
  // for the trailer's: by the wheel, the mute button and the level.
  const HUD_MS = 1400;

  const showHud = (volume, muted) => {
    if (!post.hud) {
      const inner = el("div", { class: "iconOsdProgressInner" });
      post.hud = el("div", { class: "iconOsd volumeOsd hera-volume-hud", "aria-hidden": "true" }, [
        el("span", { class: "material-icons iconOsdIcon" }),
        el("div", { class: "iconOsdProgressOuter" }, inner),
      ]);
      post.hud.heraInner = inner;
      document.body.append(post.hud);
    }
    const silent = muted || volume === 0;
    post.hud.querySelector(".iconOsdIcon").textContent = silent ? "volume_off" : volume < 40 ? "volume_down" : "volume_up";
    post.hud.heraInner.style.width = `${silent ? 0 : volume}%`;
    post.hud.classList.add("is-on");
    clearTimeout(post.hudTimer);
    post.hudTimer = setTimeout(hideHud, HUD_MS);
  };

  const hideHud = () => {
    clearTimeout(post.hudTimer);
    post.hud?.classList.remove("is-on");
  };

  // The wheel turns the trailer up or down, as it turns the player's volume; Jellyfin never hears
  // it meanwhile, so the credits' volume stays where it was. With the credits paused and no
  // trailer left, the wheel does nothing.
  const onPostWheel = (event) => {
    if (!post.layer) return;
    if (!post.trailer && !post.creditsPaused) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!post.trailer || !event.deltaY) return;
    const trailer = post.trailer;
    const from = trailer.muted ? 0 : trailer.volume;
    setTrailerVolume(from + (event.deltaY < 0 ? 5 : -5));
  };

  const focusTrailer = () => {
    if (!post.layer) return;
    document.documentElement.classList.add("hera-postplay-focus");
    const v = video();
    if (v && !v.paused) {
      v.pause();
      post.creditsPaused = true;
    }
  };

  const syncSound = () => {
    const sound = post.layer?.querySelector(".hera-post__sound");
    const trailer = post.trailer;
    if (!sound || !trailer) return;
    const silent = trailer.muted || trailer.volume === 0;
    const mute = sound.querySelector(".hera-post__mute");
    mute.setAttribute("aria-label", silent ? "Unmute trailer" : "Mute trailer");
    mute.setAttribute("aria-pressed", String(silent));
    mute.querySelector(".material-icons").textContent = silent ? "volume_off" : trailer.volume < 40 ? "volume_down" : "volume_up";
    const slider = sound.querySelector(".hera-post__volume");
    slider.value = String(trailer.muted ? 0 : trailer.volume);
    slider.style.setProperty("--hera-level", `${trailer.muted ? 0 : trailer.volume}%`);
  };

  const setTrailerVolume = (volume) => {
    const trailer = post.trailer;
    if (!trailer) return;
    clearInterval(post.fadeTimer);
    trailer.volume = Math.max(0, Math.min(100, volume));
    trailer.muted = trailer.volume === 0;
    youTube(trailer.frame, trailer.muted ? "mute" : "unMute");
    youTube(trailer.frame, "setVolume", [trailer.volume]);
    syncSound();
    showHud(trailer.volume, trailer.muted);
  };

  const toggleTrailerMute = () => {
    const trailer = post.trailer;
    if (!trailer) return;
    clearInterval(post.fadeTimer);
    trailer.muted = !trailer.muted;
    if (!trailer.muted && trailer.volume === 0) trailer.volume = TRAILER_VOLUME;
    youTube(trailer.frame, trailer.muted ? "mute" : "unMute");
    if (!trailer.muted) youTube(trailer.frame, "setVolume", [trailer.volume]);
    syncSound();
    showHud(trailer.volume, trailer.muted);
  };

  // Back leaves the player altogether, as the player's own back arrow does.
  const leavePlayer = () => {
    hidePost({ dismiss: true, resume: false });
    window.history.back();
  };

  const buildPost = (next) => {
    const item = next.item;
    const episode = next.kind === "episode";
    const logo = logoFor(item);
    const name = episode ? item.SeriesName || item.Name : item.Name;
    const line = episode
      ? [episodeCode(item), item.Name].filter(Boolean).join(" · ")
      : [item.ProductionYear, (item.Genres || []).slice(0, 2).join(", "), runtime(item.RunTimeTicks)].filter(Boolean).join(" · ");
    const primary = el("button", { class: "hera-pause__button hera-pause__button--primary hera-post__play", type: "button" }, [
      el("span", { class: "hera-post__fill", "aria-hidden": "true" }),
      icon("play_arrow"),
      el("span", { text: episode ? "Play Next Episode" : "Play" }),
    ]);
    const credits = el("button", { class: "hera-pause__button hera-post__credits", type: "button", text: "Watch Credits" });
    const frame = el("button", { class: "hera-post__frame", type: "button", "aria-label": "Watch Credits", title: "Watch Credits" });
    const back = el("button", { class: "hera-post__back", type: "button", "aria-label": "Back", title: "Back" }, icon("arrow_back"));
    primary.addEventListener("click", () => startNext(next, primary));
    credits.addEventListener("click", () => hidePost({ dismiss: true }));
    frame.addEventListener("click", () => hidePost({ dismiss: true }));
    back.addEventListener("click", leavePlayer);
    // The trailer's sound: a mute toggle and a level, shown once the trailer is playing.
    const sound =
      next.kind === "film"
        ? el("div", { class: "hera-post__sound", role: "group", "aria-label": "Trailer sound" }, [
            el("button", { class: "hera-post__mute", type: "button", "aria-pressed": "false", "aria-label": "Mute trailer", onclick: toggleTrailerMute }, icon("volume_up")),
            el("input", {
              class: "hera-post__volume",
              type: "range",
              min: "0",
              max: "100",
              step: "5",
              value: String(TRAILER_VOLUME),
              "aria-label": "Trailer volume",
              oninput: (event) => setTrailerVolume(Number(event.target.value)),
            }),
          ])
        : null;
    return el("div", { class: "hera-post hera-dark", role: "dialog", "aria-label": episode ? "Next episode" : "Up next" }, [
      back,
      frame,
      el("div", { class: "hera-post__info" }, [
        logo ? el("img", { class: "hera-pause__logo", src: logo, alt: name }) : el("h2", { class: "hera-pause__name", text: name }),
        line ? el("p", { class: "hera-pause__line", text: line }) : null,
        next.reason ? el("p", { class: "hera-post__reason", text: next.reason }) : null,
        item.Overview ? el("p", { class: "hera-pause__overview", text: item.Overview }) : null,
        el("div", { class: "hera-pause__actions" }, [primary, credits]),
      ]),
      sound,
    ]);
  };

  // The next title starts the way every Hera Play button starts one: the server's PlayNow to this
  // browser's session. (Pressing Jellyfin's own Start Now from script does nothing: it only
  // answers a real press.) An episode started this way gets Jellyfin's usual queue of the rest of
  // the series, so autoplay carries on after it. The screen stays until the new stream begins.
  const startNext = async (next, button) => {
    button?.setAttribute("aria-busy", "true");
    try {
      await play(next.item);
    } catch (error) {
      console.error("[Hera TV:postplay]", error);
      hidePost({ dismiss: true });
    }
  };

  const autoplayOn = async () => {
    if (post.autoplay === null) {
      const user = await getJSON(`Users/${userId()}`).catch(() => null);
      post.autoplay = user?.Configuration?.EnableNextEpisodeAutoPlay !== false;
    }
    return post.autoplay;
  };

  // The Play button fills as the episode runs out, ending as Jellyfin starts the next one.
  const startCountdown = (fill) => {
    const v = video();
    const total = (post.item?.RunTimeTicks || 0) / 1e7;
    if (!v || !total) return;
    const from = Math.max(1, total - v.currentTime);
    clearInterval(post.ticker);
    post.ticker = setInterval(() => {
      const left = Math.max(0, total - (video()?.currentTime ?? total));
      fill.style.transform = `scaleX(${Math.min(1, 1 - left / from)})`;
    }, 250);
  };

  const showPost = async () => {
    const item = post.item;
    if (!item || post.layer || post.opening || post.dismissed === item.Id) return;
    post.opening = true;
    // Switched off in Settings > Playback: Jellyfin's own Up Next takes the credits, as without Hera.
    const wanted = await prefs.on("postplay");
    const next = wanted ? await (item.Type === "Episode" ? nextEpisode(item) : item.Type === "Movie" ? nextFilm(item) : Promise.resolve(null)).catch(() => null) : null;
    post.opening = false;
    // Nothing to offer (a finale, a film with no match), or not wanted: leave the credits alone for this item.
    if (!next) post.dismissed = item.Id;
    if (!next || post.itemId !== item.Id || post.dismissed === item.Id || !post.page || post.page.classList.contains("hide")) return;
    const frame = playerFrame();
    if (!frame) return;
    const backdrop = buildBackdrop(next);
    const layer = buildPost(next);
    post.backdrop = backdrop;
    post.layer = layer;
    // The backdrop goes in before the player, so the shrunken picture paints over it; the layer
    // goes over everything, Jellyfin's page included.
    document.body.insertBefore(backdrop, frame);
    document.body.append(layer);
    document.documentElement.classList.add("hera-postplay-on");
    frame.classList.add("hera-postplay-video");
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        backdrop.classList.add("is-on");
        layer.classList.add("is-on");
      }),
    );
    layer.querySelector(".hera-post__play")?.focus({ preventScroll: true });
    loadTrailer(next, backdrop).catch((error) => console.warn("[Hera TV:postplay] trailer", error));
    if (next.kind === "episode" && (await autoplayOn()) && post.layer === layer) startCountdown(layer.querySelector(".hera-post__fill"));
  };

  // `resume` plays the credits again if the trailer had paused them (Watch Credits); leaving or
  // moving on to the next title doesn't.
  const hidePost = ({ dismiss = false, resume = dismiss } = {}) => {
    if (dismiss && post.itemId) post.dismissed = post.itemId;
    clearInterval(post.ticker);
    clearInterval(post.fadeTimer);
    clearTimeout(post.focusTimer);
    const v = video();
    if (v && post.creditsVolume !== null) v.volume = post.creditsVolume;
    if (v && post.creditsPaused && resume) v.play()?.catch?.(() => {});
    post.trailer = null;
    hideHud();
    post.creditsVolume = null;
    post.creditsPaused = false;
    document.documentElement.classList.remove("hera-postplay-on", "hera-postplay-focus");
    playerFrame()?.classList.remove("hera-postplay-video");
    const { layer, backdrop } = post;
    post.layer = null;
    post.backdrop = null;
    if (layer?.contains(document.activeElement)) document.activeElement.blur();
    for (const node of [layer, backdrop]) {
      if (!node) continue;
      node.classList.remove("is-on");
      setTimeout(() => node.remove(), 360);
    }
  };

  // What is playing, learnt once per item: the session's item, its details and where its credits start.
  const preparePost = () => {
    if (post.preparing) return post.preparing;
    post.preparing = (async () => {
      const playing = await nowPlaying().catch(() => null);
      const item = playing ? await loadDetails(playing.item.Id) : null;
      if (!item || item.Id === post.itemId) return;
      hidePost();
      post.itemId = item.Id;
      post.item = item;
      post.creditsAt = item.Type === "Episode" || item.Type === "Movie" ? await creditsStart(item) : null;
    })().finally(() => {
      post.preparing = null;
    });
    return post.preparing;
  };

  const onPostTime = (event) => {
    if (!(event.target instanceof HTMLVideoElement) || !post.page) return;
    const v = event.target;
    if (!post.item || post.stale) {
      post.stale = false;
      preparePost().catch(() => {});
      return;
    }
    if (post.layer) {
      // Rewound out of the credits: back to the programme.
      if (post.creditsAt !== null && v.currentTime < post.creditsAt - 2) hidePost();
      return;
    }
    if (post.dismissed === post.itemId) return;
    const total = (post.item.RunTimeTicks || 0) / 1e7;
    const inCredits = post.creditsAt !== null && v.currentTime >= post.creditsAt && (!total || v.currentTime < total - 1);
    const upNext = post.item.Type === "Episode" && post.creditsAt === null && !!jellyfinUpNext();
    if (inCredits || upNext) showPost().catch(() => {});
  };

  // A new stream means a new item, or the same one again: learn it afresh on the next tick.
  const onPostReset = (event) => {
    if (!(event.target instanceof HTMLVideoElement)) return;
    if (event.type === "ended") return hidePost();
    post.stale = true;
  };

  // Left and right step along the row (Play, Watch Credits, the trailer's mute), Up reaches Back,
  // Down returns to the row; on the volume level left and right change it. Escape or the remote's
  // Back gives the credits back; the on-screen Back arrow leaves the player.
  const onPostKey = (event) => {
    const layer = post.layer;
    if (!layer) return;
    const active = document.activeElement;
    const row = [...layer.querySelectorAll(".hera-pause__button, .hera-post.has-trailer .hera-post__mute")];
    const all = [layer.querySelector(".hera-post__back"), ...row, layer.classList.contains("has-trailer") ? layer.querySelector(".hera-post__volume") : null].filter(Boolean);
    if (["Escape", "Backspace", "GoBack", "BrowserBack"].includes(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      hidePost({ dismiss: true });
      return;
    }
    if (active?.classList.contains("hera-post__volume") && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.stopImmediatePropagation();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      event.stopImmediatePropagation();
      const index = all.indexOf(active);
      all[(index + (event.shiftKey ? -1 : 1) + all.length) % all.length]?.focus();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      event.stopImmediatePropagation();
      const index = row.indexOf(active);
      row[Math.min(row.length - 1, Math.max(0, index < 0 ? 0 : index + (event.key === "ArrowLeft" ? -1 : 1)))]?.focus();
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      event.stopImmediatePropagation();
      (event.key === "ArrowUp" ? layer.querySelector(".hera-post__back") : row[0])?.focus();
      return;
    }
    // Enter on a control is that control's; nothing else reaches Jellyfin's player keys meanwhile.
    if (event.key !== "Enter" && event.key !== " ") event.preventDefault();
    event.stopImmediatePropagation();
  };

  const bindPost = (page) => {
    if (post.page === page) return;
    unbindPost();
    post.page = page;
    post.stale = true;
    const on = (target, type, fn, capture) => {
      target.addEventListener(type, fn, capture);
      post.cleanups.push(() => target.removeEventListener(type, fn, capture));
    };
    on(document, "timeupdate", onPostTime, true);
    for (const type of ["loadstart", "emptied", "ended"]) on(document, type, onPostReset, true);
    on(window, "keydown", onPostKey, true);
    on(window, "wheel", onPostWheel, { capture: true, passive: false });
    on(window, "message", onTrailerMessage, false);
  };

  const unbindPost = () => {
    hidePost();
    post.cleanups.splice(0).forEach((fn) => fn());
    Object.assign(post, { page: null, itemId: null, item: null, creditsAt: null, dismissed: null, autoplay: null });
  };

  // ---------- a title's trailer, from its page ---------------------------------------------
  // Jellyfin's Trailer button hands a remote trailer to its YouTube player, which shows YouTube's
  // "Video unavailable" page for a video that can't be embedded. Hera plays it instead, in a layer
  // of its own over the whole screen: the title's backdrop, dimmed, until the first trailer that
  // will play starts, then that trailer with YouTube's controls. Back, Escape or the trailer's end
  // close it. A title none of whose trailers will play loses the button; trailer files stay Jellyfin's.

  const detail = { itemId: null, item: null, ids: null, run: 0, bound: new WeakSet() };
  const sheet = { node: null, opener: null, inert: [], cleanups: [] };

  const BACK_KEYS = new Set(["Escape", "Backspace", "BrowserBack", "GoBack"]);

  const closeTrailerSheet = () => {
    const { node, opener } = sheet;
    if (!node) return;
    sheet.node = null;
    sheet.cleanups.splice(0).forEach((fn) => fn());
    sheet.inert.splice(0).forEach((other) => (other.inert = false));
    node.classList.remove("is-on");
    setTimeout(() => node.remove(), 360);
    if (opener?.isConnected) opener.focus({ preventScroll: true });
  };

  const openTrailerSheet = async (item, ids, opener) => {
    closeTrailerSheet();
    const tag = item.BackdropImageTags?.[0];
    const still = tag ? imageUrl(item.Id, "Backdrop", { maxWidth: 1920, tag }) : null;
    const close = el("button", { class: "hera-post__back hera-trailer__close", type: "button", "aria-label": "Close trailer", title: "Close" }, icon("arrow_back"));
    const watch = item.RemoteTrailers?.[0]?.Url || `https://www.youtube.com/watch?v=${ids[0]}`;
    const note = el("div", { class: "hera-trailer__note", hidden: true }, [
      el("p", { class: "hera-trailer__text", text: "This trailer can't be played here." }),
      el("a", { class: "hera-btn hera-btn--glass hera-btn--text", href: watch, target: "_blank", rel: "noopener noreferrer" }, [icon("open_in_new"), "Watch on YouTube"]),
    ]);
    const node = el("div", { class: "hera-trailer hera-dark", role: "dialog", "aria-modal": "true", "aria-label": `${item.Name} trailer` }, [
      still ? el("img", { class: "hera-trailer__still", src: still, alt: "" }) : null,
      close,
      note,
    ]);
    sheet.node = node;
    sheet.opener = opener;
    document.body.append(node);
    // The page behind is out of reach (keyboard, remote, screen reader) while the trailer is up.
    for (const other of document.body.children) {
      if (other === node || other.inert) continue;
      other.inert = true;
      sheet.inert.push(other);
    }
    const on = (target, type, fn, options) => {
      target.addEventListener(type, fn, options);
      sheet.cleanups.push(() => target.removeEventListener(type, fn, options));
    };
    close.addEventListener("click", closeTrailerSheet);
    on(window, "keydown", (event) => {
      if (!BACK_KEYS.has(event.key) && event.keyCode !== 461) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeTrailerSheet();
    }, true);
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add("is-on")));
    close.focus({ preventScroll: true });

    const alive = () => sheet.node === node;
    const found = await firstThatPlays(ids, {
      make: (id) => trailerFrame(id, { className: "hera-trailer__frame", title: `${item.Name} trailer`, controls: true, muted: false }),
      place: (frame) => node.insertBefore(frame, close),
      alive,
      // A trailer that waits for a press (the browser held back its sound) stays, to be pressed.
      keepWaiting: true,
    });
    if (!alive()) return;
    if (!found) {
      note.hidden = false;
      return;
    }
    found.frame.classList.add("is-on");
    node.classList.add("is-playing");
    on(window, "message", (event) => {
      if (youTubeMessage(event, found.frame)?.info?.playerState === 0) closeTrailerSheet();
    });
  };

  // On a title's page: learn which of its trailers will play, and drop the button if none will.
  const mountTrailer = async (page, itemId) => {
    const run = ++detail.run;
    Object.assign(detail, { itemId, item: null, ids: null });
    page.classList.remove("hera-no-trailer");
    if (!detail.bound.has(page)) {
      detail.bound.add(page);
      page.addEventListener("click", onTrailerButton, true);
    }
    const item = await heraTv.kit.item(itemId).catch(() => null);
    // A trailer file, or no trailer at all: Jellyfin's button as it is.
    if (!item || run !== detail.run || item.LocalTrailerCount > 0 || !item.RemoteTrailers?.length) return;
    detail.item = item;
    detail.ids = trailerIds(item);
    const ids = await detail.ids;
    if (run === detail.run && !ids.length) page.classList.add("hera-no-trailer");
  };

  const onTrailerButton = (event) => {
    const button = event.target.closest?.(".btnPlayTrailer");
    const { item, ids } = detail;
    if (!button || !item || !ids || detail.itemId !== heraTv.kit.itemIdFromHash()) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    ids.then((list) => list.length && openTrailerSheet(item, list, button)).catch((error) => console.error("[Hera TV:trailer]", error));
  };

  // ---------- lifecycle --------------------------------------------------------------------
  // Four modules: the dark scheme and the title block need nothing of Jellyfin's OSD, and the dark
  // scheme must hold even when the pause screen or post-play has stood aside (light mode would
  // otherwise put dark text on the picture). The trailer layer belongs to a title's page.

  heraTv.register({
    name: "player",
    onView(page) {
      if (page?.id !== "videoOsdPage") {
        stopFollow();
        stopDark();
        stopSkip();
        return;
      }
      startDark(page);
      followPlayer(page);
      followSkip(page);
    },
    teardown() {
      stopFollow();
      stopDark();
      stopSkip();
    },
  });

  heraTv.register({
    name: "pause",
    // The pause screen stays out of the way of the OSD, so it has to be able to see it.
    requires: { videoOsdPage: ["videoOsd"] },
    onView(page) {
      if (page?.id === "videoOsdPage") bindPause(page);
      else unbindPause();
    },
    teardown() {
      unbindPause();
    },
  });

  heraTv.register({
    name: "postplay",
    onView(page) {
      if (page?.id === "videoOsdPage") bindPost(page);
      else unbindPost();
    },
    teardown() {
      unbindPost();
    },
  });

  heraTv.register({
    name: "trailer",
    requires: { itemDetailPage: ["detailButtons"] },
    onView(page, { itemId }) {
      closeTrailerSheet();
      if (page?.id === "itemDetailPage" && itemId) mountTrailer(page, itemId).catch((error) => console.error("[Hera TV:trailer]", error));
      else detail.run++;
    },
    teardown() {
      closeTrailerSheet();
      detail.run++;
    },
  });
})();
