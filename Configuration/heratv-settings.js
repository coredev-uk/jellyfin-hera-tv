/*
 * Hera TV's page in Jellyfin's Dashboard (Plugins > Hera TV): Seerr and Maintainerr setup and the
 * server-wide switches for the home page and Discover. Jellyfin loads this as the page's
 * controller (`data-controller="__plugin/heratv-settings.js"`); the markup is drawn here, in the
 * Settings app's grouped-list components (styles in hera-settings.css).
 *
 * Everything goes through /HeraTV/settings (admin only). Fields the server's HERATV_* environment
 * variables own are shown read-only with their value (the API key is never shown), because those
 * variables win over anything saved here. The Seerr API key is write-only: the page learns only
 * whether one is set.
 *
 * The Compatibility section at the foot reads /HeraTV/health: which parts of Hera the web clients
 * say have stood aside because this Jellyfin's web client no longer matches what they expect.
 */

const el = (tag, attrs = {}, children = []) => {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
};

const icon = (name) => el("span", { class: "material-icons", "aria-hidden": "true", text: name });

const send = (method, path, body) =>
  window.ApiClient.ajax({
    type: method,
    url: window.ApiClient.getUrl(`HeraTV/settings${path}`),
    data: body === undefined ? undefined : JSON.stringify(body),
    contentType: body === undefined ? undefined : "application/json",
    dataType: "json",
  });

/** The server's own words for a failed call, when it sent any. */
const reason = async (error) => {
  try {
    const body = await error.json();
    if (body && body.message) return body.message;
  } catch {
    /* not JSON */
  }
  return "Couldn't reach the server. Check your connection and try again.";
};

// Page ids as the web client names them, for the Compatibility section's sentences.
const PAGE_NAMES = {
  indexPage: "the home page",
  itemDetailPage: "detail pages",
  loginPage: "the sign-in page",
  videoOsdPage: "the video player",
};

// [feature key in /HeraTV/settings, request field, icon, label, description]
const SWITCHES = [
  ["discover", "discoverEnabled", "explore", "Discover tab", "A tab on the home page for browsing and requesting films and shows through Seerr."],
  ["leavingSoon", "leavingSoonEnabled", "hourglass_bottom", "Leaving Soon", "A home row, and a chip on each title page, for what Maintainerr will remove soon."],
  ["requests", "requestsRowEnabled", "playlist_add_check", "Your Requests", "A home row of each person's own Seerr requests and where they stand."],
  ["trending", "trendingRowEnabled", "trending_up", "Trending to Request", "A home row of what's trending on Seerr, ready to request."],
  ["activity", "activityEnabled", "downloading", "Request progress", "Live download state on requests and title pages, and a Downloads view for administrators. Needs Sonarr or Radarr."],
];

// The download stack: [id in /HeraTV/settings, name, example address, where the key lives]. SABnzbd only adds speed and time left.
const ARR = [
  ["sonarr", "Sonarr", "http://sonarr:8989", "Sonarr's Settings > General > API Key."],
  ["radarr", "Radarr", "http://radarr:7878", "Radarr's Settings > General > API Key."],
  ["sabnzbd", "SABnzbd", "http://sabnzbd:8080", "SABnzbd's Config > General > API Key."],
];

// What film and series pages add. Ratings and "Also on" come from Seerr; quality badges need nothing.
const TITLE_SWITCHES = [
  ["elsewhere", "elsewhereEnabled", "connected_tv", "Also on", "The streaming services that carry a title in the region below, from Seerr."],
  ["ratings", "ratingsEnabled", "grade", "Ratings", "IMDb and Rotten Tomatoes scores beside the year and runtime, from Seerr."],
  ["qualityBadges", "qualityBadgesEnabled", "high_quality", "Quality badges", "4K, HDR, Dolby Vision and Atmos on title pages and on posters."],
];

// The groups Hera can build as collections: [id in /HeraTV/settings, icon, label, description]. Franchises are the TMDb Box Sets plugin's and have no switch.
const COLLECTION_GROUPS = [
  ["universes", "hub", "Universes", "Marvel, Star Wars, Star Trek and other shared worlds, from a list built into Hera TV."],
  ["awards", "emoji_events", "Awards", "Best Picture and the BAFTAs, from a list built into Hera TV."],
  ["streaming", "connected_tv", "Streaming", "What you have that streams on Netflix, Prime Video, Disney+, Apple TV+, NOW, Paramount+, ITVX, BBC iPlayer, Channel 4 and Sky Go. Needs Seerr."],
  ["seasonal", "celebration", "Seasonal", "Christmas, Halloween, Bonfire Night, Mothering Sunday, Easter and more, only while they are on."],
  ["homegrown", "flag", "Homegrown", "British-made films and series, with Classic Cinema, Contemporary Cinema, Comedy Greats and Crime Drama."],
  ["decades", "history", "Decades", "The best rated titles of each decade, from the 1950s to the 2020s."],
  ["genres", "category", "Genres", "One collection for each genre with enough titles."],
  ["studios", "movie", "Studios", "One collection for each film studio with enough films. There can be a lot of these."],
  ["networks", "tv", "Networks", "One collection for each TV network or producer with enough series."],
  ["certificates", "shield", "Certificates", "Rated U, PG, 12A, 15 and 18, with US ratings mapped across."],
];

export default function (view) {
  const root = view.querySelector("#heraCfg");
  let server = null;
  let jellyfinUsers = [];
  let directory = null; // The Seerr accounts: { ok, message, users }
  let links = new Map(); // Jellyfin username (lower case) -> Seerr id, as edited
  let refs = null;
  let dirty = false;
  let clearKey = false;
  const clearArrKeys = new Set(); // service ids whose saved key is removed on the next save
  let barTimer = 0;
  let compat = null; // The last /HeraTV/health answer, or { error }

  const lower = (name) => String(name || "").toLowerCase();

  // ---------- pieces --------------------------------------------------------------------------

  const lockPill = (variable) =>
    el("span", { class: "hera-cfg-pill", title: `Set by ${variable} on the server` }, [icon("lock"), el("span", { text: "Server environment" })]);

  /** A labelled text field. `locked` (the variable name) makes it read-only with a note. */
  const field = ({ id, label, description, value, placeholder, type = "text", variable, locked, pill, actions, mode }) => {
    const input = el("input", {
      id,
      class: "hera-set-input",
      type,
      value: value || "",
      placeholder: placeholder || undefined,
      readonly: locked || undefined,
      spellcheck: "false",
      autocomplete: type === "password" ? "new-password" : "off",
      inputmode: mode,
      "aria-describedby": `${id}-note`,
    });
    if (!locked) input.addEventListener("input", markDirty);
    const note = locked
      ? el("p", { id: `${id}-note`, class: "hera-cfg-field__note is-locked" }, [icon("lock"), el("span", { text: `Set by ${variable} on the server. Change it there; edits here don't apply.` })])
      : el("p", { id: `${id}-note`, class: "hera-cfg-field__note", text: description });
    const node = el("div", { class: "hera-cfg-field" }, [
      el("div", { class: "hera-cfg-field__head" }, [
        el("label", { class: "hera-set-field__label", for: id, text: label }),
        locked ? lockPill(variable) : pill,
        actions,
      ]),
      input,
      note,
    ]);
    return { node, input };
  };

  const button = (label, { primary = false, iconName, onclick } = {}) => {
    const node = el("button", { class: `hera-set-btn${primary ? " hera-set-btn--primary" : ""}`, type: "button" }, [
      iconName ? icon(iconName) : null,
      el("span", { text: label }),
    ]);
    node.addEventListener("click", onclick);
    return node;
  };

  const group = (title, body, foot) =>
    el("section", { class: "hera-set-group", "aria-label": title }, [
      el("h2", { class: "hera-set-group__title", text: title }),
      body,
      foot,
    ]);

  const foot = (text, lockedBy) =>
    el("p", { class: "hera-set-group__foot" }, [lockedBy ? icon("lock") : null, el("span", { text })]);

  /** The outcome of a test: an icon and a sentence, announced politely. */
  const verdict = () => el("p", { class: "hera-set-status hera-cfg-verdict", role: "status" });
  const showVerdict = (node, state, text) => {
    node.classList.toggle("is-error", state === false);
    node.replaceChildren(icon(state === "pending" ? "hourglass_empty" : state ? "check_circle" : "error_outline"), el("span", { text }));
  };

  const switchRow = (iconName, label, description, checked) => {
    const node = el("button", { class: "hera-set-row", type: "button", role: "switch", "aria-checked": String(checked) }, [
      el("span", { class: "hera-set-row__icon" }, icon(iconName)),
      el("span", { class: "hera-set-row__text" }, [
        el("span", { class: "hera-set-row__label", text: label }),
        el("span", { class: "hera-set-row__desc", text: description }),
      ]),
      el("span", { class: "hera-set-switch", "aria-hidden": "true" }, el("span", { class: "hera-set-switch__knob" })),
    ]);
    node.addEventListener("click", () => {
      node.setAttribute("aria-checked", String(node.getAttribute("aria-checked") !== "true"));
      markDirty();
    });
    return node;
  };

  const numberRow = (id, iconName, label, description, value, min, max) => {
    const input = el("input", { id, class: "hera-set-input hera-cfg-number", type: "number", min, max, step: "1", value, inputmode: "numeric" });
    input.addEventListener("input", markDirty);
    const row = el("div", { class: "hera-set-row hera-set-row--static" }, [
      el("span", { class: "hera-set-row__icon" }, icon(iconName)),
      el("label", { class: "hera-set-row__text", for: id }, [
        el("span", { class: "hera-set-row__label", text: label }),
        el("span", { class: "hera-set-row__desc", text: description }),
      ]),
      input,
    ]);
    return { row, input };
  };

  // ---------- sections ------------------------------------------------------------------------

  const seerrSection = () => {
    const s = server.seerr;
    const url = field({
      id: "heraSeerrUrl",
      label: "Server address",
      description: "Where Jellyfin reaches Seerr from the server, such as http://seerr:5055.",
      value: s.url.value,
      placeholder: "http://seerr:5055",
      type: "url",
      variable: s.url.variable,
      locked: s.url.source === "env",
      mode: "url",
    });
    const publicUrl = field({
      id: "heraSeerrPublic",
      label: "Public address",
      description: "What people open in a browser; the \"Open in Seerr\" links go here.",
      value: s.publicUrl.value,
      placeholder: "https://seerr.example.com",
      type: "url",
      variable: s.publicUrl.variable,
      locked: s.publicUrl.source === "env",
      mode: "url",
    });

    const keyLocked = s.apiKey.source === "env";
    const keySaved = s.apiKey.set && !clearKey;
    const remove = !keyLocked && s.apiKey.source === "config" && !clearKey
      ? button("Remove", { onclick: () => { clearKey = true; markDirty(); renderSeerr(); } })
      : null;
    if (remove) remove.classList.add("hera-set-btn--small");
    const key = field({
      id: "heraSeerrKey",
      label: "API key",
      description: clearKey
        ? "The saved key is removed when you save."
        : "Seerr's Settings > General > API Key. It stays on the server and is never shown again once saved.",
      value: "",
      placeholder: keyLocked ? `Set by ${s.apiKey.variable}` : keySaved ? "••••••••••••••••" : "Paste the key",
      type: "password",
      variable: s.apiKey.variable,
      locked: keyLocked,
      pill: keySaved && !keyLocked ? el("span", { class: "hera-cfg-pill" }, [icon("check"), el("span", { text: "Saved" })]) : null,
      actions: remove,
    });

    const result = verdict();
    const test = button("Test connection", {
      iconName: "bolt",
      onclick: async () => {
        test.disabled = true;
        showVerdict(result, "pending", "Testing…");
        try {
          const body = {};
          if (!url.input.readOnly) body.url = url.input.value.trim();
          if (key.input.value.trim()) body.apiKey = key.input.value.trim();
          const answer = await send("POST", "/test/seerr", body);
          showVerdict(result, answer.ok, answer.message);
          if (answer.ok) {
            await loadDirectory(body);
            renderMapping();
          }
        } catch (error) {
          showVerdict(result, false, await reason(error));
        } finally {
          test.disabled = false;
        }
      },
    });

    refs.seerrUrl = url.input;
    refs.seerrPublicUrl = publicUrl.input;
    refs.seerrApiKey = key.input;
    return el("div", { class: "hera-set-list hera-cfg-card" }, [
      url.node,
      publicUrl.node,
      key.node,
      el("div", { class: "hera-cfg-test" }, [test, result]),
    ]);
  };

  const renderSeerr = () => {
    const next = group("Seerr", seerrSection());
    sections.seerr.replaceWith(next);
    sections.seerr = next;
  };

  const seerrName = (id) => {
    const found = directory && directory.users.find((u) => u.id === id);
    return found ? found.displayName : `Seerr user ${id}`;
  };

  const mappingSection = () => {
    const locked = server.seerr.users.source === "env";
    const rows = [];
    refs.selects = new Map();

    const intro = !jellyfinUsers.length
      ? el("p", { class: "hera-set-status hera-cfg-empty", text: "No Jellyfin users found." })
      : !locked && !(directory && directory.ok)
        ? el("p", { class: "hera-set-status hera-cfg-empty" }, [
            icon("info"),
            el("span", { text: !directory ? "Loading Seerr's accounts…" : directory.message ? `Couldn't load Seerr's accounts: ${directory.message}` : "Test the Seerr connection above to load its accounts." }),
          ])
        : null;
    if (intro) rows.push(intro);

    for (const user of jellyfinUsers) {
      const id = links.get(lower(user.Name));
      const avatar = user.PrimaryImageTag
        ? el("img", { class: "hera-set-avatar hera-cfg-avatar", alt: "", src: window.ApiClient.getUrl(`Users/${user.Id}/Images/Primary`, { tag: user.PrimaryImageTag, maxWidth: 72, quality: 90 }) })
        : el("span", { class: "hera-set-avatar hera-cfg-avatar", "aria-hidden": "true", text: (user.Name || "?").slice(0, 1).toUpperCase() });
      const who = el("span", { class: "hera-set-row__text" }, [
        el("span", { class: "hera-set-row__label", text: user.Name }),
        user.Policy && user.Policy.IsAdministrator ? el("span", { class: "hera-set-row__desc", text: "Administrator" }) : null,
      ]);

      let control;
      if (locked || !(directory && directory.ok)) {
        control = el("span", { class: "hera-set-row__value", text: id ? seerrName(id) : "Not linked" });
      } else {
        const select = el("select", { class: "hera-set-input hera-cfg-select", "aria-label": `Seerr account for ${user.Name}` });
        select.append(el("option", { value: "", text: "Not linked" }));
        const known = new Set(directory.users.map((u) => u.id));
        if (id && !known.has(id)) select.append(el("option", { value: String(id), text: `Seerr user ${id} (not found)` }));
        for (const account of directory.users) {
          select.append(el("option", { value: String(account.id), text: account.email ? `${account.displayName} · ${account.email}` : account.displayName }));
        }
        select.value = id ? String(id) : "";
        select.addEventListener("change", () => {
          if (select.value) links.set(lower(user.Name), Number(select.value));
          else links.delete(lower(user.Name));
          markDirty();
        });
        refs.selects.set(lower(user.Name), select);
        control = select;
      }
      rows.push(el("div", { class: "hera-set-row hera-set-row--static" }, [avatar, who, control]));
    }

    return group(
      "Seerr accounts",
      el("div", { class: "hera-set-list" }, rows),
      locked
        ? foot(`Set by ${server.seerr.users.variable} on the server. Change it there; edits here don't apply.`, true)
        : foot("Requests are made as the linked Seerr account. People without one can browse Discover but can't request."),
    );
  };

  const renderMapping = () => {
    const next = mappingSection();
    sections.mapping.replaceWith(next);
    sections.mapping = next;
  };

  const maintainerrSection = () => {
    const m = server.maintainerr;
    const url = field({
      id: "heraMaintainerrUrl",
      label: "Server address",
      description: "Where Jellyfin reaches Maintainerr from the server, such as http://maintainerr:6246. Leaving Soon reads its active collections.",
      value: m.url.value,
      placeholder: "http://maintainerr:6246",
      type: "url",
      variable: m.url.variable,
      locked: m.url.source === "env",
      mode: "url",
    });
    refs.maintainerrUrl = url.input;
    const result = verdict();
    const test = button("Test connection", {
      iconName: "bolt",
      onclick: async () => {
        test.disabled = true;
        showVerdict(result, "pending", "Testing…");
        try {
          const body = url.input.readOnly ? {} : { url: url.input.value.trim() };
          const answer = await send("POST", "/test/maintainerr", body);
          showVerdict(result, answer.ok, answer.message);
        } catch (error) {
          showVerdict(result, false, await reason(error));
        } finally {
          test.disabled = false;
        }
      },
    });
    return el("div", { class: "hera-set-list hera-cfg-card" }, [url.node, el("div", { class: "hera-cfg-test" }, [test, result])]);
  };

  /** Sonarr, Radarr or SABnzbd: address, write-only key, Test connection. */
  const arrSection = ([id, name, example, keyHelp]) => {
    const s = server[id];
    const url = field({
      id: `hera-${id}-url`,
      label: "Server address",
      description: `Where Jellyfin reaches ${name} from the server, such as ${example}.`,
      value: s.url.value,
      placeholder: example,
      type: "url",
      variable: s.url.variable,
      locked: s.url.source === "env",
      mode: "url",
    });
    const publicUrl = field({
      id: `hera-${id}-public`,
      label: "Public address",
      description: `What people open in a browser; the "Open in ${name}" buttons go here. Shown to administrators only.`,
      value: s.publicUrl.value,
      placeholder: `https://${id}.example.com`,
      type: "url",
      variable: s.publicUrl.variable,
      locked: s.publicUrl.source === "env",
      mode: "url",
    });
    const keyLocked = s.apiKey.source === "env";
    const removed = clearArrKeys.has(id);
    const keySaved = s.apiKey.set && !removed;
    const remove = !keyLocked && s.apiKey.source === "config" && !removed
      ? button("Remove", { onclick: () => { clearArrKeys.add(id); markDirty(); renderArr(id); } })
      : null;
    if (remove) remove.classList.add("hera-set-btn--small");
    const key = field({
      id: `hera-${id}-key`,
      label: "API key",
      description: removed ? "The saved key is removed when you save." : `${keyHelp} It stays on the server and is never shown again once saved.`,
      value: "",
      placeholder: keyLocked ? `Set by ${s.apiKey.variable}` : keySaved ? "••••••••••••••••" : "Paste the key",
      type: "password",
      variable: s.apiKey.variable,
      locked: keyLocked,
      pill: keySaved && !keyLocked ? el("span", { class: "hera-cfg-pill" }, [icon("check"), el("span", { text: "Saved" })]) : null,
      actions: remove,
    });
    refs.arr[id] = { url: url.input, publicUrl: publicUrl.input, key: key.input };

    const result = verdict();
    const test = button("Test connection", {
      iconName: "bolt",
      onclick: async () => {
        test.disabled = true;
        showVerdict(result, "pending", "Testing…");
        try {
          const body = {};
          if (!url.input.readOnly) body.url = url.input.value.trim();
          if (key.input.value.trim()) body.apiKey = key.input.value.trim();
          const answer = await send("POST", `/test/${id}`, body);
          showVerdict(result, answer.ok, answer.message);
        } catch (error) {
          showVerdict(result, false, await reason(error));
        } finally {
          test.disabled = false;
        }
      },
    });
    return group(name, el("div", { class: "hera-set-list hera-cfg-card" }, [url.node, publicUrl.node, key.node, el("div", { class: "hera-cfg-test" }, [test, result])]));
  };

  const renderArr = (id) => {
    const next = arrSection(ARR.find((entry) => entry[0] === id));
    sections.arr[id].replaceWith(next);
    sections.arr[id] = next;
  };

  const homeSection = () => {
    const count = numberRow("heraHeroCount", "view_carousel", "Hero titles", "How many unwatched titles the home hero rotates through, 1 to 20.", server.hero.count, 1, 20);
    const interval = numberRow("heraHeroInterval", "timer", "Seconds per title", "How long each hero title stays before the next, 4 to 60.", server.hero.intervalSeconds, 4, 60);
    refs.heroCount = count.input;
    refs.heroInterval = interval.input;
    return group("Home hero", el("div", { class: "hera-set-list" }, [count.row, interval.row]));
  };

  const rowsSection = () => {
    refs.switches = {};
    const rows = SWITCHES.map(([key, , iconName, label, description]) => {
      const node = switchRow(iconName, label, description, server.features[key]);
      refs.switches[key] = node;
      return node;
    });
    return group(
      "Home and Discover",
      el("div", { class: "hera-set-list" }, rows),
      foot("These apply to everyone on this server. Rows that need Seerr or Maintainerr stay hidden until it's connected."),
    );
  };

  const titleSection = () => {
    const rows = TITLE_SWITCHES.map(([key, , iconName, label, description]) => {
      const node = switchRow(iconName, label, description, server.features[key]);
      refs.switches[key] = node;
      return node;
    });
    const region = el("input", { id: "heraRegion", class: "hera-set-input hera-cfg-number", type: "text", maxlength: "2", value: server.elsewhere.region, spellcheck: "false", autocomplete: "off" });
    region.addEventListener("input", markDirty);
    refs.region = region;
    rows.push(
      el("div", { class: "hera-set-row hera-set-row--static" }, [
        el("span", { class: "hera-set-row__icon" }, icon("public")),
        el("label", { class: "hera-set-row__text", for: "heraRegion" }, [
          el("span", { class: "hera-set-row__label", text: "Streaming region" }),
          el("span", { class: "hera-set-row__desc", text: "A two-letter country code, such as GB or US." }),
        ]),
        region,
      ]),
    );
    return group("Title pages", el("div", { class: "hera-set-list" }, rows), foot("These apply to everyone on this server."));
  };

  const notifySection = () => {
    refs.notifySwitch = switchRow(
      "notifications",
      "Notifications",
      "A bell in the header with each person's own request progress, new episodes of shows they're watching, and a daily summary of new films and series. Each person chooses which of these they get.",
      server.features.notifications,
    );
    const hour = numberRow("heraArrivalsHour", "schedule", "Daily summary hour", "The hour of the day, 0 to 23 in the server's time, from which the summary of new arrivals is written.", server.notifications.arrivalsHour, 0, 23);
    refs.arrivalsHour = hour.input;
    return group("Notifications", el("div", { class: "hera-set-list" }, [refs.notifySwitch, hour.row]), foot("These apply to everyone on this server."));
  };

  // ---------- collections ---------------------------------------------------------------------

  let buildWatch = 0; // Bumped to stop a status poll when the page is left or another build starts.

  /** What the last build did, from /HeraTV/settings's `collections.build.last`. */
  const buildSentence = (last) => {
    if (!last) return "Not built since the server started. It runs every morning at 04:00.";
    if (last.note) return `${when(last.at)}: ${last.note}`;
    const parts = [`${last.created} created`, `${last.updated} updated`, `${last.removed} removed`, `${last.unchanged} unchanged`];
    if (last.failed) parts.push(`${last.failed} failed, see the server log`);
    return `Last built ${when(last.at)}: ${parts.join(", ")}.`;
  };

  const collectionsSection = () => {
    const c = server.collections;
    refs.collectionsSwitch = switchRow(
      "folder_special",
      "Build collections",
      "Every morning Hera TV makes real Jellyfin collections, so Swiftfin, the Android TV app and the rest show them too. Turning this off removes the ones it made; collections you made yourself are never touched.",
      c.enabled,
    );
    refs.homeRowsSwitch = switchRow(
      "view_carousel",
      "Collection rows on Home",
      "Newly Released, Popular This Month, Highly Rated, a streaming service, two genres, a decade, award winners and Homegrown, with a new pick each day. These are live lists, not collections.",
      c.homeRows,
    );
    refs.collectionGroups = {};
    const groupRows = COLLECTION_GROUPS.map(([id, iconName, label, description]) => {
      const node = switchRow(iconName, label, description, c.groups[id] === true);
      refs.collectionGroups[id] = node;
      return node;
    });

    const lastLine = el("p", { class: "hera-set-status", role: "status" }, [icon("history"), el("span", { text: buildSentence(c.build.last) })]);
    const setLast = (last) => lastLine.querySelector("span:last-child").replaceChildren(buildSentence(last));
    const result = verdict();
    const run = button("Build collections now", {
      iconName: "play_arrow",
      onclick: async () => {
        if (dirty) {
          showVerdict(result, false, "Save your changes first. The build uses what is saved.");
          return;
        }
        run.disabled = true;
        showVerdict(result, "pending", "Starting…");
        const token = ++buildWatch;
        try {
          const answer = await send("POST", "/collections/build");
          showVerdict(result, "pending", answer.message);
          // The task is queued, not started: wait for it to show as running, then for it to finish.
          let started = false;
          for (let tick = 0; tick < 120; tick += 1) {
            await new Promise((resolve) => setTimeout(resolve, 3000));
            if (token !== buildWatch || !root.isConnected) return;
            const status = await send("GET", "/collections/status");
            if (status.running) {
              started = true;
              showVerdict(result, "pending", "Building…");
            } else if (started || tick >= 3) {
              setLast(status.last);
              showVerdict(result, !status.last || status.last.failed === 0, status.last && status.last.failed ? "Built, with some failures." : "Built.");
              break;
            }
          }
        } catch (error) {
          showVerdict(result, false, await reason(error));
        } finally {
          if (token === buildWatch) run.disabled = false;
        }
      },
    });

    return group(
      "Collections",
      el("div", { class: "hera-set-list" }, [refs.collectionsSwitch, refs.homeRowsSwitch, ...groupRows]),
      el("div", { class: "hera-cfg-compat" }, [el("div", { class: "hera-cfg-test" }, [run, result]), lastLine]),
    );
  };

  // ---------- compatibility -------------------------------------------------------------------

  const compatRow = (iconName, label, value) =>
    el("div", { class: "hera-set-row hera-set-row--static" }, [
      el("span", { class: "hera-set-row__icon" }, icon(iconName)),
      el("span", { class: "hera-set-row__text" }, el("span", { class: "hera-set-row__label", text: label })),
      el("span", { class: "hera-set-row__value", text: value }),
    ]);

  const when = (iso) => new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

  /** What a module's report means, in plain words. */
  const describeModule = (m) => {
    if (m.status === "disabled") return `Switched off after repeated errors${m.lastError ? `: ${m.lastError}` : ""}`;
    const gone = m.missing.length ? `Jellyfin has no ${m.missing.join(", ")}` : "a piece of Jellyfin it needs is missing";
    return `Standing aside on ${PAGE_NAMES[m.page] || (m.page ? `the ${m.page} page` : "this page")}: ${gone}`;
  };

  /** Everything that has gone wrong: modules that stood aside or were switched off, and times the whole client did. */
  const problemsOf = (data) => [
    ...data.boot
      .filter((b) => b.boot === "safe")
      .map((b) => ({ name: "Hera TV (whole page)", what: `Switched off in the browser${b.reason ? `: ${b.reason}` : ""}`, user: b.user, count: b.count, lastSeen: b.lastSeen })),
    ...data.modules
      .filter((m) => m.status === "degraded" || m.status === "disabled")
      .map((m) => ({ name: m.name, what: describeModule(m), user: m.user, count: m.count, lastSeen: m.lastSeen })),
  ];

  const problemTable = (problems) =>
    el("div", { class: "hera-set-list" }, el("div", { class: "hera-cfg-table-wrap" }, el("table", { class: "hera-cfg-table" }, [
      el("thead", {}, el("tr", {}, ["Module", "What happened", "Reported by", "Last seen"].map((text) => el("th", { scope: "col", text })))),
      el("tbody", {}, problems.map((p) =>
        el("tr", {}, [
          el("th", { scope: "row", text: p.name }),
          el("td", { text: p.what }),
          el("td", { text: p.count > 1 ? `${p.user} (${p.count} reports)` : p.user }),
          el("td", { text: when(p.lastSeen) }),
        ]))),
    ])));

  const compatSection = () => {
    const refresh = button("Refresh", {
      iconName: "refresh",
      onclick: async () => {
        refresh.disabled = true;
        await loadCompat();
      },
    });
    const note = foot("To see a page without Hera TV, add ?hera=off to its address (before or after the #); ?hera=on turns it back on. It applies to that browser tab until the tab is closed.");

    let body;
    if (!compat) {
      body = el("p", { class: "hera-set-status", text: "Checking…" });
    } else if (compat.error) {
      body = el("div", { class: "hera-cfg-compat" }, [
        el("p", { class: "hera-set-status hera-cfg-verdict is-error", role: "status" }, [icon("error_outline"), el("span", { text: compat.error })]),
        el("div", { class: "hera-cfg-test" }, refresh),
      ]);
    } else {
      const problems = problemsOf(compat);
      body = el("div", { class: "hera-cfg-compat" }, [
        el("div", { class: "hera-set-list" }, [
          compatRow("dns", "Jellyfin", compat.jellyfin),
          compatRow("verified", "Tested with", compat.tested.join(", ")),
          compatRow("tv", "Hera TV", compat.plugin),
        ]),
        compat.supported
          ? null
          : el("p", { class: "hera-set-status hera-cfg-verdict is-error", role: "status" }, [
              icon("warning"),
              el("span", { text: `Hera TV hasn't been tested with Jellyfin ${compat.jellyfin}. It keeps running, and any part that no longer fits Jellyfin's web client switches itself off and is listed below, but pages may look or behave differently until a release for this version is out.` }),
            ]),
        problems.length
          ? problemTable(problems)
          : el("p", { class: "hera-set-status hera-cfg-verdict", role: "status" }, [icon("check_circle"), el("span", { text: "Everything is working. Nothing has been reported since the server started." })]),
        el("div", { class: "hera-cfg-test" }, refresh),
      ]);
    }
    return group("Compatibility", body, note);
  };

  const renderCompat = () => {
    const next = compatSection();
    sections.compat.replaceWith(next);
    sections.compat = next;
  };

  /** Fetches what browsers have reported; failing to is shown in the section, not on the whole page. */
  const loadCompat = async () => {
    try {
      compat = await window.ApiClient.ajax({ type: "GET", url: window.ApiClient.getUrl("HeraTV/health"), dataType: "json" });
    } catch (error) {
      compat = { error: await reason(error) };
    }
    renderCompat();
  };

  // ---------- save bar ------------------------------------------------------------------------

  const bar = el("div", { class: "hera-cfg-bar", role: "region", "aria-label": "Save changes" });
  const barText = el("span", { class: "hera-cfg-bar__text", role: "status" });
  const saveButton = button("Save changes", { primary: true, onclick: () => save() });
  const discardButton = button("Discard", { onclick: () => load() });
  bar.append(barText, discardButton, saveButton);

  // The bar is fixed to the screen; centre it under the form column, wherever the drawer leaves it.
  function centre() {
    const rect = root.getBoundingClientRect();
    bar.style.setProperty("--hera-cfg-center", `${Math.round(rect.left + rect.width / 2)}px`);
  }
  const say = (text, { actions = false, error = false, iconName } = {}) => {
    centre();
    clearTimeout(barTimer);
    barText.replaceChildren(...[iconName ? icon(iconName) : null, el("span", { text })].filter(Boolean));
    barText.classList.toggle("is-error", error);
    discardButton.hidden = !actions;
    saveButton.hidden = !actions;
    bar.classList.add("is-on");
  };

  function markDirty() {
    // One announcement per run of edits, not one per keystroke.
    if (dirty && !barText.classList.contains("is-error")) return;
    dirty = true;
    say("You have unsaved changes.", { actions: true });
  }

  const settle = (text) => {
    dirty = false;
    say(text, { iconName: "check" });
    barTimer = setTimeout(() => bar.classList.remove("is-on"), 2000);
  };

  // ---------- data ----------------------------------------------------------------------------

  const loadDirectory = async (body = {}) => {
    try {
      directory = await send("POST", "/seerr/users", body);
    } catch (error) {
      directory = { ok: false, message: await reason(error), users: [] };
    }
  };

  const sections = {};

  const render = () => {
    refs = {};
    links = new Map(server.seerr.users.links.map((l) => [lower(l.username), l.seerrId]));
    const anyLocked = [server.seerr.url, server.seerr.publicUrl, server.seerr.apiKey, server.seerr.users, server.maintainerr.url]
      .concat(ARR.flatMap(([id]) => [server[id].url, server[id].publicUrl, server[id].apiKey]))
      .some((f) => f.source === "env");
    refs.arr = {};
    sections.arr = Object.fromEntries(ARR.map((entry) => [entry[0], arrSection(entry)]));

    sections.seerr = group("Seerr", seerrSection());
    sections.mapping = mappingSection();
    sections.compat = compatSection();
    root.replaceChildren(
      ...[
        el("h1", { class: "hera-set-title", text: "Hera TV" }),
        el("p", { class: "hera-cfg-lede", text: "Connect Seerr, Maintainerr and the download stack (Sonarr, Radarr, SABnzbd) and choose what the home page and Discover show. Everything here applies to everyone on the server." }),
        anyLocked
          ? el("p", { class: "hera-cfg-lede hera-cfg-envnote" }, [icon("lock"), el("span", { text: "Fields marked Server environment are set by HERATV_* variables on the server. Those win over anything saved here, so they're shown for reference and can't be changed on this page." })])
          : null,
        sections.seerr,
        sections.mapping,
        group("Maintainerr", maintainerrSection()),
        ...ARR.map(([id]) => sections.arr[id]),
        homeSection(),
        rowsSection(),
        notifySection(),
        collectionsSection(),
        titleSection(),
        sections.compat,
        bar,
      ].filter(Boolean),
    );
  };

  async function load() {
    clearKey = false;
    clearArrKeys.clear();
    dirty = false;
    bar.classList.remove("is-on");
    root.setAttribute("aria-busy", "true");
    try {
      [server, jellyfinUsers] = await Promise.all([send("GET", ""), window.ApiClient.getUsers()]);
      jellyfinUsers = (jellyfinUsers || []).slice().sort((a, b) => String(a.Name).localeCompare(String(b.Name), undefined, { sensitivity: "base" }));
      directory = null;
      render();
      loadCompat();
      root.removeAttribute("aria-busy");
      if (server.seerr.url.value && server.seerr.apiKey.set) {
        await loadDirectory({});
        // The page may have moved on (or been edited) while Seerr answered.
        if (refs && !dirty) renderMapping();
      } else {
        directory = { ok: false, message: "", users: [] };
        renderMapping();
      }
    } catch (error) {
      root.removeAttribute("aria-busy");
      root.replaceChildren(
        el("h1", { class: "hera-set-title", text: "Hera TV" }),
        el("p", { class: "hera-set-status is-error" }, [icon("error_outline"), el("span", { text: await reason(error) })]),
      );
    }
  }

  async function save() {
    saveButton.disabled = true;
    const body = {
      heroItemCount: Number(refs.heroCount.value) || undefined,
      heroIntervalSeconds: Number(refs.heroInterval.value) || undefined,
    };
    for (const [key, bodyKey] of SWITCHES) {
      body[bodyKey] = refs.switches[key].getAttribute("aria-checked") === "true";
    }
    for (const [key, bodyKey] of TITLE_SWITCHES) {
      body[bodyKey] = refs.switches[key].getAttribute("aria-checked") === "true";
    }
    body.notificationsEnabled = refs.notifySwitch.getAttribute("aria-checked") === "true";
    body.collectionsEnabled = refs.collectionsSwitch.getAttribute("aria-checked") === "true";
    body.homeRowsEnabled = refs.homeRowsSwitch.getAttribute("aria-checked") === "true";
    body.collectionGroups = Object.fromEntries(Object.entries(refs.collectionGroups).map(([id, node]) => [id, node.getAttribute("aria-checked") === "true"]));
    body.arrivalsHour = refs.arrivalsHour.value === "" ? undefined : Number(refs.arrivalsHour.value);
    body.watchRegion = refs.region.value.trim();
    const open = (input) => !input.readOnly;
    if (open(refs.seerrUrl)) body.seerrUrl = refs.seerrUrl.value.trim();
    if (open(refs.seerrPublicUrl)) body.seerrPublicUrl = refs.seerrPublicUrl.value.trim();
    if (open(refs.maintainerrUrl)) body.maintainerrUrl = refs.maintainerrUrl.value.trim();
    body.services = {};
    for (const [id] of ARR) {
      const ref = refs.arr[id];
      const entry = {};
      if (open(ref.url)) entry.url = ref.url.value.trim();
      if (open(ref.publicUrl)) entry.publicUrl = ref.publicUrl.value.trim();
      if (open(ref.key)) {
        if (ref.key.value.trim()) entry.apiKey = ref.key.value.trim();
        else if (clearArrKeys.has(id)) entry.clearApiKey = true;
      }
      body.services[id] = entry;
    }
    if (open(refs.seerrApiKey)) {
      if (refs.seerrApiKey.value.trim()) body.seerrApiKey = refs.seerrApiKey.value.trim();
      else if (clearKey) body.clearSeerrApiKey = true;
    }
    if (server.seerr.users.source !== "env") {
      body.seerrUsers = [...links]
        .map(([name, id]) => {
          const user = jellyfinUsers.find((u) => lower(u.Name) === name);
          return `${user ? user.Name : name}=${id}`;
        })
        .join(",");
    }

    try {
      server = await send("POST", "", body);
      clearKey = false;
      clearArrKeys.clear();
      render();
      settle("Saved");
      if (server.seerr.url.value && server.seerr.apiKey.set) {
        await loadDirectory({});
        if (refs && !dirty) renderMapping();
      }
    } catch (error) {
      say(await reason(error), { actions: true, error: true, iconName: "error_outline" });
    } finally {
      saveButton.disabled = false;
    }
  }

  view.addEventListener("viewshow", () => {
    window.addEventListener("resize", centre);
    load();
  });
  view.addEventListener("viewhide", () => {
    buildWatch += 1;
    window.removeEventListener("resize", centre);
  });
}
