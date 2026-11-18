/*
 * Hera TV: "Your Watching". Registers with window.HeraTV (hera-tv.js).
 * A personal page, not a dashboard: the person's own history from the server's
 * GET /HeraTV/stats/me, told as sentences over the artwork of what they watched most.
 *  - A full-bleed banner of the most-watched title's key art and logo, with the headline sentence.
 *  - Top TV Shows (wide cards) and Top Films (posters), on the same shelves as Home.
 *  - When you watch (a 7 x 24 heatmap), what you watch (genres), every day (a calendar) and a few
 *    sentences about streaks and the busiest day.
 * The page lives at #/home?hera=stats and takes the place of the home tab, as Discover and the
 * Requests view do. HeraTV.stats.render(container, data) draws it from any response, so the same
 * code paints the live page and a sample.
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

  const STATS_HASH = "#/home?hera=stats";
  const RANGES = [
    { days: 365, label: "This Year" },
    { days: 30, label: "This Month" },
    { days: 0, label: "All Time" },
  ];
  // A month reads better as bars than as a calendar five columns wide.
  const BARS_UP_TO_DAYS = 62;
  const CALENDAR_YEARS = 5;
  const DAY_MS = 86400000;
  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
  const DAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  // Hours 5-11, 12-16, 17-21 and 22-4: the last one is the night that follows its calendar day.
  const PARTS = ["mornings", "afternoons", "evenings", "nights"];
  const partOf = (hour) => (hour >= 5 && hour < 12 ? 0 : hour >= 12 && hour < 17 ? 1 : hour >= 17 && hour < 22 ? 2 : 3);

  // ---------- wording -----------------------------------------------------------------------

  const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

  // "6 hours 20 minutes", as it reads in a sentence.
  const spoken = (seconds) => {
    const minutes = Math.round(seconds / 60);
    if (minutes < 1) return "less than a minute";
    if (minutes < 60) return plural(minutes, "minute");
    const hours = Math.floor(minutes / 60);
    if (hours >= 10) return plural(Math.round(seconds / 3600), "hour");
    return minutes % 60 ? `${plural(hours, "hour")} ${plural(minutes % 60, "minute")}` : plural(hours, "hour");
  };

  // "9 hr", "1 hr 20 min": the short form Hera writes runtimes in.
  const compact = (seconds) => {
    const minutes = Math.round(seconds / 60);
    if (minutes < 1) return "under 1 min";
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours >= 10) return `${Math.round(seconds / 3600)} hr`;
    return minutes % 60 ? `${hours} hr ${minutes % 60} min` : `${hours} hr`;
  };

  const hourLabel = (hour) => `${hour % 12 || 12} ${hour < 12 ? "am" : "pm"}`;

  // Dates are the server's yyyy-MM-dd; they are handled as UTC days so no time zone moves one.
  const parseDay = (iso) => {
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
  const mondayIndex = (ms) => (new Date(ms).getUTCDay() + 6) % 7;
  const dateText = (ms, options) => new Date(ms).toLocaleDateString(undefined, { timeZone: "UTC", ...options });
  const longDate = (ms) => dateText(ms, { weekday: "long", day: "numeric", month: "long" });
  const shortDate = (ms) => dateText(ms, { day: "numeric", month: "short" });

  const strong = (text) => el("strong", { text });

  // Four steps of intensity among the values that are not zero, so one very long day doesn't
  // leave every other day looking the same.
  const levelsFor = (values) => {
    const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
    if (!sorted.length) return () => 0;
    const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    const [a, b, c] = [at(0.25), at(0.5), at(0.75)];
    return (v) => (v > 0 ? 1 + (v > a) + (v > b) + (v > c) : 0);
  };

  // The numbers behind a chart, as a table for screen readers; the drawing itself is hidden from them.
  // The clip is on a div: a table ignores overflow, and a day-by-day one would lengthen the page.
  const textTable = (caption, head, rows) =>
    el(
      "div",
      { class: "hera-stats__sr" },
      el("table", {}, [
        el("caption", { text: caption }),
        el("thead", {}, el("tr", {}, head.map((text) => el("th", { scope: "col", text })))),
        el(
          "tbody",
          {},
          rows.map((cells) => el("tr", {}, cells.map((text, i) => el(i === 0 ? "th" : "td", i === 0 ? { scope: "row", text } : { text })))),
        ),
      ]),
    );

  // ---------- artwork -----------------------------------------------------------------------

  // Tries each image type in turn; if none loads, the card keeps its title on the plain ground.
  const fillArt = (card, id, types, width, title) => {
    const art = card.querySelector(".hera-card__art");
    const img = art?.querySelector("img");
    if (!img) return;
    let next = 1;
    img.addEventListener("error", () => {
      if (next < types.length) {
        img.src = kit.imageUrl(id, types[next++], { maxWidth: width });
      } else {
        img.remove();
        art.prepend(el("span", { class: "hera-card__fallback", text: title }));
      }
    });
  };

  // ---------- the banner and its states --------------------------------------------------------

  const topOf = (data) => {
    const all = [...(data.shows ?? []), ...(data.films ?? [])].sort((a, b) => b.seconds - a.seconds);
    // Something the library no longer holds has no artwork: the banner takes the next one down.
    return { top: all[0] ?? null, art: all.find((entry) => entry.id) ?? null };
  };

  const rangeSwitch = (days, onRange) => {
    const buttons = RANGES.map((range) =>
      el("button", {
        type: "button",
        class: "hera-stats__range-btn",
        "aria-pressed": String(range.days === days),
        text: range.label,
        onclick: () => onRange?.(range.days),
      }),
    );
    return el("div", { class: "hera-stats__range", role: "group", "aria-label": "Period" }, buttons);
  };

  const homeLink = () => el("a", { class: "hera-btn hera-btn--primary hera-btn--text hera-stats__home", href: "#/home" }, [icon("chevron_left"), "Home"]);

  // A page with no banner: a sentence, what to do about it, and the way back.
  const plainPage = (container, { lead, sub, actions }) => {
    container.replaceChildren(
      el("header", { class: "hera-stats__banner is-plain" }, [
        el("div", { class: "hera-stats__intro" }, [
          el("h1", { class: "hera-stats__lead", text: lead }),
          sub ? el("p", { class: "hera-stats__sub", text: sub }) : null,
          el("div", { class: "hera-stats__actions" }, actions),
        ]),
      ]),
    );
  };

  const emptyLead = (days) =>
    days === 365
      ? "You haven't watched anything this year yet."
      : days === 30
        ? "You haven't watched anything this month yet."
        : "You haven't watched anything here yet.";

  const headline = (data, days, top) => {
    const total = spoken(data.totals.seconds);
    const lead = days === 365 ? "This year you watched " : days === 30 ? "This month you watched " : "Altogether you've watched ";
    const parts = [lead, strong(total)];
    if (top) {
      const name = top.id ? el("a", { class: "hera-stats__title-link", href: `#/details?id=${top.id}`, text: top.name }) : strong(top.name);
      parts.push(top.seconds >= data.totals.seconds / 2 ? ", most of it " : ", and ", name, top.seconds >= data.totals.seconds / 2 ? "." : " more than anything else.");
    } else {
      parts.push(".");
    }
    return parts;
  };

  const countsLine = (totals) => {
    const parts = [];
    if (totals.episodes > 0) parts.push(`${plural(totals.episodes, "episode")} of ${plural(totals.shows, "show")}`);
    if (totals.films > 0) parts.push(plural(totals.films, "film"));
    return parts.length ? `That's ${parts.join(" and ")}.` : null;
  };

  const buildBanner = (data, days, opts) => {
    const { top, art } = topOf(data);
    const banner = el("header", { class: "hera-stats__banner" });
    // The logo names a title, so it only appears over the title the sentence is about.
    const logo =
      art && art === top
        ? el("img", { class: "hera-stats__logo", alt: "", decoding: "async", src: kit.imageUrl(art.id, "Logo", { maxWidth: 900 }) })
        : null;
    logo?.addEventListener("error", () => logo.remove(), { once: true });
    const sub = countsLine(data.totals);
    banner.append(
      el("div", { class: "hera-stats__intro" }, [
        logo,
        el("h1", { class: "hera-stats__lead" }, headline(data, days, top)),
        sub ? el("p", { class: "hera-stats__sub", text: sub }) : null,
        el("div", { class: "hera-stats__actions" }, rangeSwitch(days, opts.onRange)),
      ]),
    );

    if (art) {
      const width = Math.min(2560, Math.round(window.innerWidth * (window.devicePixelRatio || 1)));
      const img = el("img", { class: "hera-stats__art", alt: "", decoding: "async", src: kit.imageUrl(art.id, "Backdrop", { maxWidth: width }) });
      img.addEventListener("load", () => img.classList.add("is-loaded"), { once: true });
      // A title with no backdrop leaves a plain banner rather than a hole.
      img.addEventListener(
        "error",
        () => {
          img.remove();
          banner.classList.remove("has-art", "hera-dark");
          banner.classList.add("is-plain");
          opts.onArt?.(false);
        },
        { once: true },
      );
      banner.classList.add("has-art", "hera-dark");
      banner.prepend(img);
      opts.onArt?.(true);
    } else {
      banner.classList.add("is-plain");
      opts.onArt?.(false);
    }
    return banner;
  };

  // ---------- shelves -------------------------------------------------------------------------

  const showsShelf = (data) => {
    const shows = [...(data.shows ?? [])].sort((a, b) => b.seconds - a.seconds);
    if (!shows.length) return null;
    const cards = shows.map((show, i) => {
      const card = kit.card({
        href: show.id ? `#/details?id=${show.id}` : undefined,
        image: show.id ? kit.imageUrl(show.id, "Backdrop", { maxWidth: 640 }) : null,
        shape: "wide",
        title: show.name,
        subtitle: `${plural(show.episodes ?? 0, "episode")} · ${compact(show.seconds)}`,
      });
      card.querySelector(".hera-card__title")?.prepend(el("span", { class: "hera-stats__rank", text: String(i + 1) }));
      if (show.id) fillArt(card, show.id, ["Backdrop", "Primary", "Thumb"], 640, show.name);
      else card.disabled = true;
      return card;
    });
    return kit.shelf({ id: "stats-shows", title: "Top TV Shows", cards, shape: "wide" });
  };

  const filmsShelf = (data) => {
    const films = [...(data.films ?? [])].sort((a, b) => b.seconds - a.seconds);
    if (!films.length) return null;
    const cards = films.map((film) => {
      const card = kit.card({
        href: film.id ? `#/details?id=${film.id}` : undefined,
        image: film.id ? kit.imageUrl(film.id, "Primary", { maxWidth: 400 }) : null,
        shape: "poster",
        title: film.name,
        subtitle: film.plays > 1 ? `${film.plays} times · ${compact(film.seconds)}` : compact(film.seconds),
      });
      if (film.id) fillArt(card, film.id, ["Primary"], 400, film.name);
      else card.disabled = true;
      return card;
    });
    return kit.shelf({ id: "stats-films", title: "Top Films", cards, shape: "poster" });
  };

  // ---------- sections ------------------------------------------------------------------------

  const section = (id, title, lead, ...visual) =>
    el("section", { class: "hera-row hera-stats__section", "aria-labelledby": id }, [
      el("div", { class: "hera-row__head" }, el("h2", { id, class: "sectionTitle sectionTitle-cards hera-row__title", text: title })),
      lead ? el("p", { class: "hera-stats__line" }, lead) : null,
      ...visual,
    ]);

  // When you watch: seven rows of weekdays by 24 hours, darker where more was watched.
  const whenSection = (data) => {
    const cells = new Map();
    let total = 0;
    for (const h of data.hours ?? []) {
      if (!(h.seconds > 0) || h.day < 0 || h.day > 6 || h.hour < 0 || h.hour > 23) continue;
      const key = h.day * 24 + h.hour;
      cells.set(key, (cells.get(key) ?? 0) + h.seconds);
      total += h.seconds;
    }
    if (!total) return null;

    // Weekday and part of the day together, so the sentence names a moment and not two separate habits.
    const buckets = new Array(28).fill(0);
    for (const [key, seconds] of cells) buckets[Math.floor(key / 24) * 4 + partOf(key % 24)] += seconds;
    const best = buckets.indexOf(Math.max(...buckets));
    const share = Math.round((buckets[best] / total) * 100);
    const when = `${DAYS[Math.floor(best / 4)]} ${PARTS[best % 4]}`;
    const lead = [buckets[best] / total >= 0.3 ? "Mostly " : "Most often ", strong(when), `. ${share}% of what you watch happens then.`];

    const level = levelsFor([...cells.values()]);
    const grid = el("div", { class: "hera-stats__heat", "aria-hidden": "true" });
    for (let day = 0; day < 7; day++) {
      grid.append(el("span", { class: "hera-stats__heat-day", style: `grid-row:${day + 1}`, text: DAYS_SHORT[day] }));
      for (let hour = 0; hour < 24; hour++) {
        const seconds = cells.get(day * 24 + hour) ?? 0;
        grid.append(
          el("span", {
            class: `hera-stats__cell lvl-${level(seconds)}`,
            style: `grid-column:${hour + 2};grid-row:${day + 1}`,
            title: `${DAYS[day]}, ${hourLabel(hour)}: ${seconds ? compact(seconds) : "nothing"}`,
          }),
        );
      }
    }
    for (const hour of [0, 6, 12, 18]) {
      grid.append(el("span", { class: "hera-stats__heat-hour", style: `grid-column:${hour + 2} / span 6;grid-row:8`, text: hourLabel(hour) }));
    }

    const table = textTable(
      "Time watched by weekday and hour",
      ["Day", ...Array.from({ length: 24 }, (_, h) => hourLabel(h))],
      DAYS.map((name, day) => [name, ...Array.from({ length: 24 }, (_, h) => (cells.get(day * 24 + h) ? compact(cells.get(day * 24 + h)) : "none"))]),
    );
    return section("hera-stats-when", "When You Watch", lead, grid, table);
  };

  // What you watch: bars sized against the top genre. A show carries several genres, so they
  // add up to more than the total and are not shares of it.
  const genresSection = (data) => {
    const genres = [...(data.genres ?? [])].filter((g) => g.seconds > 0).sort((a, b) => b.seconds - a.seconds).slice(0, 6);
    if (!genres.length) return null;
    const max = genres[0].seconds;
    const names = genres.slice(0, 3).map((g) => g.name.toLowerCase());
    const lead =
      names.length === 1
        ? [strong(genres[0].name), " is what you watch most."]
        : [strong(genres[0].name), ` leads, then ${names.slice(1).join(" and ")}.`];
    const list = el(
      "ul",
      { class: "hera-stats__genres", role: "list" },
      genres.map((genre) =>
        el("li", { class: "hera-stats__genre" }, [
          el("span", { class: "hera-stats__genre-name", text: genre.name }),
          el("span", { class: "hera-stats__bar", "aria-hidden": "true" }, el("span", { style: `width:${Math.max(3, Math.round((genre.seconds / max) * 100))}%` })),
          el("span", { class: "hera-stats__genre-time", text: compact(genre.seconds) }),
        ]),
      ),
    );
    return section("hera-stats-genres", "Your Genres", lead, list);
  };

  const legend = () =>
    el("div", { class: "hera-stats__legend", "aria-hidden": "true" }, [
      "Less",
      ...[0, 1, 2, 3, 4].map((n) => el("span", { class: `hera-stats__cell lvl-${n}` })),
      "More",
    ]);

  // A calendar of the days from `fromMs` to `toMs`, a column a week, Monday at the top. The
  // columns cover `spanFrom` to `spanTo` (a whole year, when several are stacked) so every year
  // has the same cell size, and days outside the range are left blank.
  const calendar = (byDay, fromMs, toMs, level, spanFrom = fromMs, spanTo = toMs) => {
    const start = spanFrom - mondayIndex(spanFrom) * DAY_MS;
    const weeks = Math.floor((spanTo - start) / (7 * DAY_MS)) + 1;
    const grid = el("div", { class: "hera-stats__cal", style: `--weeks:${weeks}`, "aria-hidden": "true" });
    [0, 2, 4].forEach((row) => grid.append(el("span", { class: "hera-stats__cal-day", style: `grid-row:${row + 2}`, text: DAYS_SHORT[row] })));

    // A month's name sits over the week that holds its 1st, and the first month over the first
    // column when there is room before the next one.
    const labels = [];
    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const ms = start + (w * 7 + d) * DAY_MS;
        if (ms >= fromMs && ms <= toMs && new Date(ms).getUTCDate() === 1) labels.push({ w, ms });
      }
    }
    const firstWeek = Math.floor((fromMs - start) / (7 * DAY_MS));
    if (!labels.length || labels[0].w - firstWeek >= 4) labels.unshift({ w: firstWeek, ms: fromMs });
    for (const { w, ms } of labels) {
      grid.append(el("span", { class: "hera-stats__cal-month", style: `grid-column:${w + 2} / span 4;grid-row:1`, text: dateText(ms, { month: "short" }) }));
    }

    for (let w = 0; w < weeks; w++) {
      for (let d = 0; d < 7; d++) {
        const ms = start + (w * 7 + d) * DAY_MS;
        if (ms < fromMs || ms > toMs) continue;
        const seconds = byDay.get(dayKey(ms)) ?? 0;
        grid.append(
          el("span", {
            class: `hera-stats__cell lvl-${level(seconds)}`,
            style: `grid-column:${w + 2};grid-row:${d + 2}`,
            title: `${longDate(ms)}: ${seconds ? compact(seconds) : "nothing"}`,
          }),
        );
      }
    }
    return grid;
  };

  // A short range: one bar a day, with the first and last date beneath.
  const bars = (byDay, fromMs, toMs) => {
    const days = Math.round((toMs - fromMs) / DAY_MS) + 1;
    let max = 0;
    for (let i = 0; i < days; i++) max = Math.max(max, byDay.get(dayKey(fromMs + i * DAY_MS)) ?? 0);
    const strip = el("div", { class: "hera-stats__bars", style: `--days:${days}`, "aria-hidden": "true" });
    for (let i = 0; i < days; i++) {
      const ms = fromMs + i * DAY_MS;
      const seconds = byDay.get(dayKey(ms)) ?? 0;
      strip.append(
        el("span", { class: "hera-stats__day", title: `${longDate(ms)}: ${seconds ? compact(seconds) : "nothing"}` }, el("i", { class: seconds ? null : "is-zero", style: `height:${seconds ? Math.max(4, Math.round((seconds / max) * 100)) : 0}%` })),
      );
    }
    return el("div", { class: "hera-stats__bars-wrap", "aria-hidden": "true" }, [
      strip,
      el("div", { class: "hera-stats__bars-axis" }, [el("span", { text: shortDate(fromMs) }), el("span", { text: shortDate(toMs) })]),
    ]);
  };

  const daysSection = (data, days) => {
    const byDay = new Map();
    for (const d of data.daily ?? []) if (d.seconds > 0) byDay.set(String(d.date).slice(0, 10), (byDay.get(String(d.date).slice(0, 10)) ?? 0) + d.seconds);
    if (!byDay.size) return null;

    const keys = [...byDay.keys()].sort();
    const toMs = data.range?.to ? parseDay(data.range.to) : parseDay(keys[keys.length - 1]);
    const fromMs = days === 0 ? parseDay(data.first ?? keys[0]) : data.range?.from ? parseDay(data.range.from) : toMs - (days - 1) * DAY_MS;
    const span = Math.round((toMs - fromMs) / DAY_MS) + 1;

    const active = keys.length;
    const lead =
      days === 0
        ? [`You've watched on `, strong(plural(active, "day")), "."]
        : [`You watched on `, strong(`${active.toLocaleString()} of the last ${span.toLocaleString()} days`), "."];

    const level = levelsFor([...byDay.values()]);
    const visual = [];
    if (days > 0 && days <= BARS_UP_TO_DAYS) {
      visual.push(bars(byDay, fromMs, toMs));
    } else if (span <= 400) {
      visual.push(calendar(byDay, fromMs, toMs, level), legend());
    } else {
      // All time: a calendar for each year, the latest first.
      const lastYear = new Date(toMs).getUTCFullYear();
      const firstYear = Math.max(new Date(fromMs).getUTCFullYear(), lastYear - CALENDAR_YEARS + 1);
      for (let year = lastYear; year >= firstYear; year--) {
        const yearFrom = Math.max(fromMs, Date.UTC(year, 0, 1));
        const yearTo = Math.min(toMs, Date.UTC(year, 11, 31));
        const grid = calendar(byDay, yearFrom, yearTo, level, Date.UTC(year, 0, 1), Date.UTC(year, 11, 31));
        visual.push(el("div", { class: "hera-stats__year" }, [el("h3", { class: "hera-stats__year-name", text: String(year) }), grid]));
      }
      visual.push(legend());
      if (new Date(fromMs).getUTCFullYear() < firstYear) visual.push(el("p", { class: "hera-stats__note", text: `Showing the last ${CALENDAR_YEARS} years.` }));
    }

    const table = textTable(
      "Time watched on each day",
      ["Date", "Time watched"],
      [...keys].reverse().map((key) => [longDate(parseDay(key)), compact(byDay.get(key))]),
    );
    return section("hera-stats-days", "Every Day", lead, ...visual, table);
  };

  // Streaks and the busiest day, told as sentences.
  const factsSection = (data) => {
    const facts = [];
    const { streak, busiest, first } = data;
    if (streak?.longest >= 2) {
      const sentence =
        streak.current >= 2
          ? streak.current >= streak.longest
            ? ["You're on a ", strong(`${streak.current}-day streak`), ", your longest yet."]
            : ["You're on a ", strong(`${streak.current}-day streak`), `. Your longest was ${streak.longest} days.`]
          : ["Your longest streak is ", strong(`${streak.longest} days`), " in a row."];
      facts.push(["local_fire_department", sentence]);
    }
    if (busiest?.seconds > 0) {
      facts.push(["event", ["Your busiest day was ", strong(longDate(parseDay(busiest.date))), `, with ${spoken(busiest.seconds)} of watching.`]]);
    }
    if (first) {
      facts.push(["history", ["You've been watching here since ", strong(dateText(parseDay(first), { day: "numeric", month: "long", year: "numeric" })), "."]]);
    }
    if (!facts.length) return null;
    const list = el(
      "ul",
      { class: "hera-stats__facts", role: "list" },
      facts.map(([name, sentence]) => el("li", { class: "hera-stats__fact" }, [icon(name), el("p", {}, sentence)])),
    );
    return section("hera-stats-facts", "Highlights", null, list);
  };

  // ---------- the page ------------------------------------------------------------------------

  /**
   * Draws the whole page into `container` from one /stats/me response.
   * `opts`: `days` (the range to mark, when the response has none), `onRange(days)` for the
   * switch, `onArt(bool)` when the banner has artwork under the header or loses it.
   */
  const render = (container, data, opts = {}) => {
    container.classList.add("hera-stats");
    container.dataset.heraStats = "";
    container.removeAttribute("aria-busy");
    const days = data?.range?.days ?? opts.days ?? 365;

    if (!data || data.available === false) {
      opts.onArt?.(false);
      plainPage(container, { lead: "Your watching history isn't being recorded on this server yet.", actions: [homeLink()] });
      return;
    }
    if (!(data.totals?.plays > 0) || !(data.totals?.seconds > 0)) {
      opts.onArt?.(false);
      plainPage(container, {
        lead: emptyLead(days),
        sub: "Anything you watch for more than a minute turns up here.",
        actions: [rangeSwitch(days, opts.onRange), homeLink()],
      });
      return;
    }

    const body = [showsShelf(data), filmsShelf(data)];
    const pair = [whenSection(data), genresSection(data)].filter(Boolean);
    if (pair.length) body.push(el("div", { class: "hera-stats__pair" }, pair));
    body.push(daysSection(data, days), factsSection(data));
    container.replaceChildren(buildBanner(data, days, opts), el("div", { class: "hera-stats__body" }, body.filter(Boolean)));
  };

  const loading = (container) => {
    container.classList.add("hera-stats");
    container.dataset.heraStats = "";
    container.setAttribute("aria-busy", "true");
    const line = (width) => el("span", { class: "hera-stats__bone", style: `width:${width}` });
    container.replaceChildren(
      el("div", { class: "hera-stats__skeleton", role: "status" }, [
        el("span", { class: "hera-stats__sr", text: "Loading your watching" }),
        el("div", { class: "hera-stats__banner hera-stats__banner--bone", "aria-hidden": "true" }, el("div", { class: "hera-stats__intro" }, [line("min(520px, 80%)"), line("min(380px, 60%)"), line("min(260px, 40%)")])),
        el("div", { class: "hera-stats__body", "aria-hidden": "true" }, el("div", { class: "hera-stats__bones" }, [1, 2, 3, 4].map(() => el("span", { class: "hera-stats__bone hera-stats__bone--card" })))),
      ]),
    );
  };

  const failed = (container, onRetry) => {
    container.classList.add("hera-stats");
    container.dataset.heraStats = "";
    container.removeAttribute("aria-busy");
    plainPage(container, {
      lead: "Your watching isn't available right now.",
      sub: "Try again in a moment.",
      actions: [
        el("button", { type: "button", class: "hera-btn hera-btn--glass hera-btn--text", onclick: () => onRetry?.() }, [icon("refresh"), "Try again"]),
        homeLink(),
      ],
    });
  };

  // ---------- the view ------------------------------------------------------------------------

  const view = { root: null, token: 0, art: false, classWatch: null, days: 365 };

  // The page marks the root for its hero, and the banner's art sits under the header as a detail page's does.
  const keepRootClasses = () => {
    view.classWatch?.disconnect();
    const fix = () => {
      if (root.classList.contains("hera-home")) root.classList.remove("hera-home");
      if (view.art && !root.classList.contains("hera-art-top")) root.classList.add("hera-art-top");
    };
    fix();
    view.classWatch = new MutationObserver(fix);
    view.classWatch.observe(root, { attributes: true, attributeFilter: ["class"] });
  };

  const setArt = (on) => {
    view.art = on;
    if (!view.root) return;
    if (on) root.classList.add("hera-art-top");
    else root.classList.remove("hera-art-top");
  };

  const load = async (days, { refocus = false } = {}) => {
    const mine = view.root;
    if (!mine) return;
    const token = ++view.token;
    view.days = days;
    loading(mine);
    try {
      const data = await kit.hera("stats/me", { query: { days } });
      if (token !== view.token || !mine.isConnected) return;
      render(mine, data, { days, onRange: (d) => load(d, { refocus: true }), onArt: setArt });
      if (refocus || kit.isTv()) mine.querySelector('.hera-stats__range-btn[aria-pressed="true"], .hera-stats__home')?.focus({ preventScroll: true });
    } catch (error) {
      if (token !== view.token || !mine.isConnected) return;
      console.error("[Hera TV:stats]", error);
      setArt(false);
      failed(mine, () => load(days, { refocus: true }));
    }
  };

  const unmountView = () => {
    view.token++;
    view.root?.remove();
    view.root = null;
    view.classWatch?.disconnect();
    view.classWatch = null;
    if (view.art) root.classList.remove("hera-art-top");
    view.art = false;
    root.classList.remove("hera-stats-on");
  };

  const mountView = (page) => {
    const host = page.querySelector(HT.jf.homeTab);
    if (!host) return;
    unmountView();
    view.root = el("div", { class: "hera-stats", "data-hera-stats": "" });
    host.append(view.root);
    root.classList.add("hera-stats-on");
    keepRootClasses();
    window.scrollTo(0, 0);
    load(view.days);
  };

  const wantsView = () => {
    const [path, query = ""] = window.location.hash.split("?");
    return path.startsWith("#/home") && new URLSearchParams(query).get("hera") === "stats";
  };

  const syncView = (page) => {
    if (!wantsView() || page?.id !== "indexPage" || !kit.userId()) {
      if (view.root) unmountView();
      return;
    }
    if (view.root?.isConnected) {
      // Hera's own pass removed the art class on its way through the page; put it back.
      if (view.art) root.classList.add("hera-art-top");
      return;
    }
    mountView(page);
  };

  const onHash = () => requestAnimationFrame(() => syncView(document.querySelector(".page:not(.hide)")));

  HT.register({
    name: "stats",
    // The page mounts into the home tab; it has nowhere to appear without it.
    requires: { indexPage: ["homeTab"] },
    onView(page) {
      syncView(page);
    },
    teardown() {
      unmountView();
      cleanups.splice(0).forEach((fn) => fn());
      delete HT.stats;
    },
  });

  listen(window, "hashchange", onHash);

  HT.stats = { render, loading, failed, hash: STATS_HASH };
})();
