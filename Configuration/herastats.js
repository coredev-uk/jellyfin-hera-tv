/*
 * Hera TV's Statistics page in Jellyfin's Dashboard (Plugins > Statistics): what is playing now, and
 * how the server has been used. Jellyfin loads this as the page's controller
 * (`data-controller="__plugin/herastats.js"`); the markup is drawn here and styled by the
 * Statistics block at the foot of hera-dashboard.css.
 *
 * Three groups, each answering one question:
 *  - Now playing: /HeraTV/stats/now, a card per live stream, refreshed every 10 s while the tab is
 *    visible and the page is showing.
 *  - History: /HeraTV/stats/history from Playback Reporting's database. Without that plugin the
 *    group says so and points to the catalogue.
 *  - Recorded by Hera: what only Hera keeps (streams at once, resolution, bitrate, transcoding),
 *    from the same history response.
 *
 * Charts are hand-made SVG in scheme tokens only (no colour carries meaning on its own: stacked
 * series differ by fill pattern, every value is in the readout, and each chart ships a visually
 * hidden table). They are drawn at the width they have and redrawn when it changes, so text never
 * scales.
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

const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, children = []) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "text") node.textContent = value;
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) {
    if (child) node.append(child);
  }
  return node;
};

const icon = (name) => el("span", { class: "material-icons", "aria-hidden": "true", text: name });

// A call that never answers must not leave the page on "Checking…" for ever.
const REQUEST_TIMEOUT_MS = 20000;
const withTimeout = (promise) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The server took too long to answer.")), REQUEST_TIMEOUT_MS);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });

const get = (path, params) =>
  withTimeout(
    window.ApiClient.ajax({
      type: "GET",
      url: window.ApiClient.getUrl(`HeraTV/stats/${path}`, params),
      dataType: "json",
    }),
  );

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

const REFRESH_MS = 10000;
const RANGES = [
  [7, "7 days"],
  [30, "30 days"],
  [90, "90 days"],
  [365, "1 year"],
];
const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const CATALOGUE = "#/dashboard/plugins?status=Available&query=Playback%20Reporting";

const METHODS = {
  DirectPlay: { label: "Direct Play", icon: "play_circle", note: "The file is sent as it is." },
  DirectStream: { label: "Direct Stream", icon: "sync_alt", note: "The video is sent as it is; the container or audio is repackaged." },
  Transcode: { label: "Transcoding", icon: "autorenew", note: "" },
};

const CODECS = {
  h264: "H.264",
  avc: "H.264",
  hevc: "HEVC",
  h265: "HEVC",
  av1: "AV1",
  vp8: "VP8",
  vp9: "VP9",
  mpeg2video: "MPEG-2",
  mpeg4: "MPEG-4",
  vc1: "VC-1",
  aac: "AAC",
  ac3: "Dolby Digital",
  eac3: "Dolby Digital Plus",
  truehd: "TrueHD",
  dts: "DTS",
  flac: "FLAC",
  opus: "Opus",
  mp3: "MP3",
};

// ---------- formatting ------------------------------------------------------------------------

const count = new Intl.NumberFormat();
const plural = (n, one, many = `${one}s`) => `${count.format(n)} ${n === 1 ? one : many}`;

const duration = (seconds) => {
  const total = Math.round(seconds || 0);
  if (total <= 0) return "0 min";
  if (total < 60) return "Under 1 min";
  let hours = Math.floor(total / 3600);
  let minutes = Math.round((total % 3600) / 60);
  if (minutes === 60) {
    hours += 1;
    minutes = 0;
  }
  if (!hours) return `${minutes} min`;
  return minutes ? `${hours} hr ${minutes} min` : `${hours} hr`;
};

const clock = (ticks) => {
  const total = Math.max(0, Math.floor((ticks || 0) / 1e7));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

/** Bits per second, as the server reports bitrates. */
const mbps = (bits) => {
  if (!bits) return "";
  if (bits < 1e6) return `${Math.round(bits / 1e3)} kbps`;
  const n = bits / 1e6;
  return `${n >= 10 ? Math.round(n) : +n.toFixed(1)} Mbps`;
};

const codec = (name) => (name ? CODECS[String(name).toLowerCase()] || String(name).toUpperCase() : "");

const resolution = (width, height) => {
  // A letterboxed 4K film is 3840x1600, so the wider edge decides as much as the height.
  const lines = Math.max(height || 0, Math.round(((width || 0) * 9) / 16));
  if (!lines) return "";
  if (lines >= 2000) return "4K";
  if (lines >= 1400) return "1440p";
  if (lines >= 1000) return "1080p";
  if (lines >= 700) return "720p";
  return "SD";
};

const hdrLabel = (hdr) => (typeof hdr === "string" ? hdr : "");

/** "4K HDR10 HEVC 42 Mbps" from whichever parts a stream has. */
const streamText = (s) => [resolution(s.width, s.height), hdrLabel(s.hdr), codec(s.videoCodec), mbps(s.bitrate)].filter(Boolean).join(" ");

const DAY = 86400000;
const parseDay = (value) => Date.parse(`${String(value).slice(0, 10)}T00:00:00Z`);
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
const utcFormat = (options) => new Intl.DateTimeFormat(undefined, { timeZone: "UTC", ...options });
const longDay = utcFormat({ weekday: "short", day: "numeric", month: "short" });
const longDate = utcFormat({ day: "numeric", month: "long", year: "numeric" });
const shortDate = utcFormat({ day: "numeric", month: "short" });
const shortWeekday = utcFormat({ weekday: "short", day: "numeric" });
const monthOnly = utcFormat({ month: "short" });

const ago = (iso) => {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "";
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${plural(days, "day")} ago`;
  return shortDate.format(then);
};

const percent = (part, whole) => {
  if (!whole) return "0%";
  const p = (part / whole) * 100;
  return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
};

const sum = (list, pick) => list.reduce((total, item) => total + (pick(item) || 0), 0);

const imageUrl = (id, kind, width) => window.ApiClient.getUrl(`Items/${id}/Images/${kind}`, { maxWidth: width, quality: 85 });

// ---------- SVG charts ------------------------------------------------------------------------

let uid = 0;

/** Round axis steps: 1, 2, 2.5, 5 times a power of ten, whole numbers when the data is a count. */
const axisTicks = (max, integer) => {
  const top = Math.max(max, integer ? 1 : 0.0001);
  const raw = top / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  let step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
  if (integer) step = Math.max(1, Math.ceil(step));
  const ticks = [0];
  while (ticks[ticks.length - 1] < top - step * 1e-6) ticks.push(+(ticks[ticks.length - 1] + step).toFixed(6));
  return ticks;
};

/** A pattern fill, so a series reads as different from the solid one without relying on colour. */
const hatch = (id) =>
  svgEl("pattern", { id, width: 5, height: 5, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" }, [
    svgEl("rect", { width: 5, height: 5, class: "hera-stats-hatch__bg" }),
    svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 5, "stroke-width": 2, class: "hera-stats-hatch__line" }),
  ]);

const swatch = (tone) => {
  const id = `hera-stats-sw-${++uid}`;
  const rect = svgEl("rect", { width: 14, height: 14, rx: 3, class: `hera-stats-tone--${tone}`, fill: tone === "hatch" ? `url(#${id})` : undefined });
  return svgEl("svg", { class: "hera-stats-swatch", width: 14, height: 14, viewBox: "0 0 14 14", "aria-hidden": "true", focusable: "false" }, [
    tone === "hatch" ? svgEl("defs", {}, hatch(id)) : null,
    rect,
  ]);
};

const legend = (series) =>
  el("ul", { class: "hera-stats-key", role: "list" }, series.map((s) => el("li", {}, [swatch(s.tone), el("span", { text: s.name })])));

/** Hidden from sight, read by screen readers: the numbers a chart draws. */
const dataTable = (caption, head, rows) =>
  el("table", { class: "hera-stats-sr" }, [
    el("caption", { text: caption }),
    el("thead", {}, el("tr", {}, head.map((text) => el("th", { scope: "col", text })))),
    el("tbody", {}, rows.map((cells) => el("tr", {}, cells.map((text, i) => el(i === 0 ? "th" : "td", i === 0 ? { scope: "row", text } : { text }))))),
  ]);

/** Calls `draw(width)` now and whenever the host's width changes. */
const fit = (host, draw) => {
  let last = 0;
  const run = (width) => {
    if (width < 120 || width === last) return;
    last = width;
    draw(width);
  };
  run(host.clientWidth || 640);
  if (typeof ResizeObserver === "function") new ResizeObserver(() => run(Math.round(host.clientWidth))).observe(host);
};

/**
 * One column per day, stacked by series. `days` is [{ ms, values, text, cells }]: the readout and
 * table row for that day are precomputed by the caller, who knows the units.
 */
const barChart = ({ titleId, summary, days, series, axis, integer, tableHead, caption }) => {
  const id = `hera-stats-chart-${++uid}`;
  const host = el("div", { class: "hera-stats-chart__plot" });
  const readout = el("p", { id: `${id}-readout`, class: "hera-stats-readout", role: "status", text: summary });
  let geometry = null;
  let selected = null;
  let mark = null;

  const select = (index) => {
    selected = index;
    readout.textContent = index === null ? summary : days[index].text;
    if (mark && geometry) {
      mark.setAttribute("visibility", index === null ? "hidden" : "visible");
      if (index !== null) mark.setAttribute("x", String(geometry.left + index * geometry.band));
    }
  };

  const draw = (width) => {
    const height = 220;
    const m = { top: 8, right: 8, bottom: 26, left: 44 };
    const plotW = width - m.left - m.right;
    const plotH = height - m.top - m.bottom;
    const totals = days.map((d) => sum(d.values, (v) => v));
    const ticks = axisTicks(Math.max(0, ...totals), integer);
    const top = ticks[ticks.length - 1];
    const band = plotW / days.length;
    const gap = band > 6 ? 2 : band > 3 ? 1 : 0.5;
    const barW = Math.min(36, Math.max(1, band - gap));
    const y = (v) => m.top + plotH - (v / top) * plotH;
    const patternId = `${id}-hatch`;
    geometry = { left: m.left, band };

    mark = svgEl("rect", { class: "hera-stats-hit", y: m.top, width: band, height: plotH, visibility: "hidden" });
    const parts = [svgEl("defs", {}, hatch(patternId)), mark];

    for (const tick of ticks) {
      parts.push(
        svgEl("line", { class: "hera-stats-grid", x1: m.left, x2: width - m.right, y1: y(tick), y2: y(tick) }),
        svgEl("text", { class: "hera-stats-axis", x: m.left - 8, y: y(tick) + 4, "text-anchor": "end", text: axis(tick) }),
      );
    }

    days.forEach((day, i) => {
      let floor = 0;
      day.values.forEach((value, s) => {
        if (value <= 0) return;
        const h = Math.max(1.5, (value / top) * plotH);
        const tone = series[s].tone;
        parts.push(
          svgEl("rect", {
            class: `hera-stats-bar hera-stats-tone--${tone}`,
            fill: tone === "hatch" ? `url(#${patternId})` : undefined,
            x: m.left + i * band + (band - barW) / 2,
            y: m.top + plotH - floor - h,
            width: barW,
            height: h,
          }),
        );
        floor += h;
      });
    });

    // Date labels: month starts for a long range, every few days for a short one.
    const slots = Math.max(2, Math.floor(plotW / 64));
    let at = [];
    let format = shortDate;
    if (days.length > 120) {
      at = days.map((d, i) => i).filter((i) => new Date(days[i].ms).getUTCDate() === 1);
      format = monthOnly;
    } else {
      format = days.length <= 14 ? shortWeekday : shortDate;
      const step = Math.ceil(days.length / slots);
      for (let i = 0; i < days.length; i += step) at.push(i);
    }
    if (at.length > slots) {
      const thin = Math.ceil(at.length / slots);
      at = at.filter((_, n) => n % thin === 0);
    }
    for (const i of at) {
      const x = m.left + i * band + band / 2;
      const edge = x < m.left + 24 ? "start" : x > width - 28 ? "end" : "middle";
      parts.push(svgEl("text", { class: "hera-stats-axis", x, y: height - 7, "text-anchor": edge, text: format.format(days[i].ms) }));
    }

    host.replaceChildren(svgEl("svg", { class: "hera-stats-svg", width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true", focusable: "false" }, parts));
    if (selected !== null) select(selected);
  };

  host.addEventListener("pointermove", (e) => {
    if (!geometry) return;
    const x = e.clientX - host.getBoundingClientRect().left - geometry.left;
    const index = Math.floor(x / geometry.band);
    select(index >= 0 && index < days.length ? index : null);
  });
  host.addEventListener("pointerleave", () => select(null));

  const node = el(
    "div",
    {
      class: "hera-stats-chart",
      role: "group",
      tabindex: "0",
      "aria-labelledby": titleId,
      "aria-describedby": `${id}-readout`,
    },
    [series.length > 1 ? legend(series) : null, readout, host, dataTable(caption, tableHead, days.map((d) => [longDay.format(d.ms), ...d.cells]))],
  );
  node.addEventListener("keydown", (e) => {
    const last = days.length - 1;
    let next;
    if (e.key === "ArrowRight") next = selected === null ? last : Math.min(last, selected + 1);
    else if (e.key === "ArrowLeft") next = selected === null ? last : Math.max(0, selected - 1);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    else if (e.key === "Escape") next = null;
    else return;
    e.preventDefault();
    select(next);
  });
  node.addEventListener("blur", () => select(null));

  fit(host, draw);
  return node;
};

/** A week by 24 hours; the darker the cell, the more was watched. Monday first, 24-hour labels. */
const heatmap = ({ titleId, summary, hours }) => {
  const id = `hera-stats-heat-${++uid}`;
  const grid = WEEKDAYS.map(() => new Array(24).fill(0));
  for (const h of hours) {
    if (grid[h.day]) grid[h.day][h.hour] = h.seconds;
  }
  const max = Math.max(0, ...grid.flat());
  const level = (seconds) => {
    if (!seconds || !max) return 0;
    const r = seconds / max;
    return r < 0.2 ? 1 : r < 0.45 ? 2 : r < 0.75 ? 3 : 4;
  };
  const host = el("div", { class: "hera-stats-chart__plot" });

  const draw = (width) => {
    const left = 40;
    const topPad = 20;
    const gap = 3;
    const cell = (width - left - gap * 23) / 24;
    const ch = Math.min(28, Math.max(14, cell));
    const height = topPad + 7 * (ch + gap);
    const every = width < 560 ? 6 : 3;
    const parts = [];
    for (let hour = 0; hour < 24; hour += every) {
      parts.push(svgEl("text", { class: "hera-stats-axis", x: left + hour * (cell + gap) + cell / 2, y: 12, "text-anchor": "middle", text: String(hour).padStart(2, "0") }));
    }
    WEEKDAYS.forEach((name, day) => {
      const y = topPad + day * (ch + gap);
      parts.push(svgEl("text", { class: "hera-stats-axis", x: 0, y: y + ch / 2 + 4, text: name.slice(0, 3) }));
      for (let hour = 0; hour < 24; hour += 1) {
        const seconds = grid[day][hour];
        parts.push(
          svgEl("rect", { class: `hera-stats-cell hera-stats-lvl-${level(seconds)}`, x: left + hour * (cell + gap), y, width: cell, height: ch, rx: Math.min(5, cell / 3) }, [
            svgEl("title", { text: `${name} ${String(hour).padStart(2, "0")}:00: ${seconds ? duration(seconds) : "nothing watched"}` }),
          ]),
        );
      }
    });
    host.replaceChildren(svgEl("svg", { class: "hera-stats-svg", width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true", focusable: "false" }, parts));
  };

  const key = el("div", { class: "hera-stats-scale", "aria-hidden": "true" }, [
    el("span", { text: "Less" }),
    ...[0, 1, 2, 3, 4].map((n) => el("span", { class: `hera-stats-scale__step hera-stats-lvl-${n}` })),
    el("span", { text: "More" }),
  ]);
  const hourHead = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
  const node = el("div", { class: "hera-stats-chart", role: "group", "aria-labelledby": titleId, "aria-describedby": `${id}-summary` }, [
    el("p", { id: `${id}-summary`, class: "hera-stats-readout", text: summary }),
    host,
    key,
    dataTable("Time watched in each hour of the week, server time", ["Day", ...hourHead], WEEKDAYS.map((name, day) => [name, ...grid[day].map((s) => duration(s))])),
  ]);
  fit(host, draw);
  return node;
};

// ---------- the page --------------------------------------------------------------------------

export default function (view) {
  const root = view.querySelector("#heraStats");
  const state = { days: 30, metric: "plays" };
  const cards = new Map(); // session id -> { node, update }
  let shown = false;
  let nowTimer = 0;
  let nowBusy = false;
  let historyToken = 0;
  let nowSummary;
  let nowEmpty;
  let nowList;
  let historyBody;
  let recordedBody;
  let recordedFoot;

  // ---------- pieces --------------------------------------------------------------------------

  const setText = (node, text) => {
    if (node.textContent !== text) node.textContent = text;
  };

  const group = (title, body, extra) =>
    el("section", { class: "hera-set-group", "aria-label": title }, [
      el("div", { class: "hera-stats-head" }, [el("h2", { class: "hera-set-group__title", text: title }), extra]),
      body,
    ]);

  /** A titled panel; `extra` (a control) sits level with the title. */
  const card = (title, body, extra) => {
    const id = `hera-stats-t-${++uid}`;
    return el("section", { class: "hera-stats-card", "aria-labelledby": id }, [
      el("div", { class: "hera-stats-card__head" }, [el("h3", { id, class: "hera-stats-card__title", text: title }), extra]),
      body,
    ]);
  };
  const titleIdOf = (cardNode) => cardNode.querySelector("h3").id;

  const notice = (iconName, text, children) =>
    el("div", { class: "hera-stats-notice" }, [icon(iconName), el("p", {}, [el("span", { text }), children])]);

  /** Exclusive choices as a capsule: click to choose, arrow keys to move, as the season tabs do. */
  const segment = (label, options, value, onChange) => {
    let current = value;
    const wrap = el("div", { class: "hera-set-seg", role: "radiogroup", "aria-label": label });
    const buttons = options.map(([key, text]) => el("button", { class: "hera-set-seg__option", type: "button", role: "radio", "aria-checked": String(key === current), text }));
    buttons.forEach((node, i) => {
      node.addEventListener("click", () => {
        const key = options[i][0];
        if (key === current) return;
        current = key;
        buttons.forEach((b, j) => b.setAttribute("aria-checked", String(j === i)));
        onChange(key);
      });
    });
    wrap.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const to = buttons[buttons.indexOf(document.activeElement) + (e.key === "ArrowRight" ? 1 : -1)];
      if (!to) return;
      e.preventDefault();
      to.focus();
    });
    wrap.append(...buttons);
    return wrap;
  };

  /** Art that quietly disappears when the server has none, trying each kind in turn. */
  const loadArt = (img, urls, onNone) => {
    let at = 0;
    const next = () => {
      if (at >= urls.length) {
        img.removeAttribute("src");
        img.hidden = true;
        if (onNone) onNone();
        return;
      }
      img.hidden = false;
      img.src = urls[at++];
    };
    img.onerror = next;
    next();
  };

  // ---------- now playing ---------------------------------------------------------------------

  const detailRow = (label, value) =>
    el("div", { class: "hera-stats-now__row" }, [el("dt", { text: label }), el("dd", {}, value)]);

  const nowCard = () => {
    const img = el("img", { class: "hera-stats-art__img", alt: "", decoding: "async" });
    const fill = el("div", { class: "hera-stats-progress__fill" });
    const bar = el("div", { class: "hera-stats-progress", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100" }, fill);
    const art = el("div", { class: "hera-stats-art hera-dark" }, [
      icon("movie"),
      img,
      el("span", { class: "hera-stats-art__pause" }, [icon("pause"), el("span", { text: "Paused" })]),
      bar,
    ]);
    const title = el("h3", { class: "hera-stats-now__title" });
    const sub = el("p", { class: "hera-stats-now__sub" });
    const who = el("p", { class: "hera-stats-now__who" });
    const time = el("p", { class: "hera-stats-now__time" });
    const method = el("p", { class: "hera-stats-now__method" });
    const detail = el("dl", { class: "hera-stats-now__detail" });
    const node = el("li", { class: "hera-stats-now__card" }, [art, el("div", { class: "hera-stats-now__body" }, [title, sub, who, time, method, detail])]);
    let artKey = "";

    const update = (s) => {
      const item = s.item || {};
      const name = item.seriesName || item.name || "Unknown title";
      setText(title, name);
      const subText = item.seriesName ? [item.episode, item.name].filter(Boolean).join(" · ") : item.year ? String(item.year) : "";
      setText(sub, subText);
      sub.hidden = !subText;

      const where = [s.device, s.client].filter(Boolean).join(" · ");
      who.replaceChildren(...[el("span", { class: "hera-stats-now__user", text: s.user ? s.user.name : "Unknown user" }), where ? el("span", { text: ` on ${where}` }) : null].filter(Boolean));

      const runtime = item.runtimeTicks || 0;
      const pct = runtime ? Math.min(100, Math.max(0, ((s.positionTicks || 0) / runtime) * 100)) : 0;
      bar.hidden = !runtime;
      fill.style.width = `${pct}%`;
      bar.setAttribute("aria-valuenow", String(Math.round(pct)));
      bar.setAttribute("aria-label", `Progress through ${name}`);
      setText(time, runtime ? `${s.paused ? "Paused at " : ""}${clock(s.positionTicks)} of ${clock(runtime)}` : s.paused ? "Paused" : "Playing");
      node.classList.toggle("is-paused", !!s.paused);

      const key = `${item.imageId || ""}`;
      if (key !== artKey) {
        artKey = key;
        art.classList.remove("is-empty");
        if (key) loadArt(img, ["Backdrop", "Thumb", "Primary"].map((kind) => imageUrl(key, kind, 640)), () => art.classList.add("is-empty"));
        else {
          img.hidden = true;
          art.classList.add("is-empty");
        }
      }

      const info = METHODS[s.playMethod] || METHODS.DirectPlay;
      // The server fills `transcode` for a Direct Stream remux too, so the wording follows playMethod alone.
      const isTranscode = s.playMethod === "Transcode";
      const transcode = s.transcode || null;
      method.replaceChildren(
        ...[
          icon(info.icon),
          el("span", { class: "hera-stats-now__method-label", text: info.label }),
          isTranscode && transcode ? el("span", { class: "hera-cfg-pill", text: transcode.hardware ? (typeof transcode.hardware === "string" ? `Hardware · ${transcode.hardware}` : "Hardware") : "Software" }) : null,
        ].filter(Boolean),
      );

      const rows = [];
      const source = s.source || {};
      if (isTranscode && transcode) {
        const from = streamText(source);
        const to = streamText({ ...transcode, hdr: undefined });
        const videoSame = (!transcode.videoCodec || transcode.videoCodec === source.videoCodec) && (!transcode.height || transcode.height === source.height);
        rows.push(detailRow("Video", videoSame ? `${from || "Unknown"}, not re-encoded` : `${from || "Unknown"} → ${to || "re-encoded"}`));
      } else {
        const text = [streamText(source), codec(source.audioCodec), source.container ? String(source.container).toUpperCase() : ""].filter(Boolean).join(" · ");
        if (text) rows.push(detailRow("Source", text));
        if (info.note) rows.push(detailRow("About", info.note));
      }
      if (transcode) {
        const audioFrom = codec(source.audioCodec);
        const audioTo = codec(transcode.audioCodec);
        if (audioTo && audioTo !== audioFrom) rows.push(detailRow("Audio", `${audioFrom || "Unknown"} → ${audioTo}`));
        // The server sends reasons as readable text already.
        const reasons = transcode.reasons || [];
        if (reasons.length) rows.push(detailRow("Why", el("ul", { class: "hera-stats-reasons", role: "list" }, reasons.map((text) => el("li", { text })))));
      }
      detail.replaceChildren(...rows);
    };
    return { node, update };
  };

  const applyNow = (data) => {
    const sessions = data.sessions || [];
    const seen = new Set();
    sessions.forEach((s, index) => {
      seen.add(s.id);
      let entry = cards.get(s.id);
      if (!entry) {
        entry = nowCard();
        cards.set(s.id, entry);
      }
      entry.update(s);
      if (nowList.children[index] !== entry.node) nowList.insertBefore(entry.node, nowList.children[index] || null);
    });
    for (const [id, entry] of cards) {
      if (seen.has(id)) continue;
      entry.node.remove();
      cards.delete(id);
    }
    nowList.hidden = !sessions.length;

    const t = data.totals || { streams: sessions.length, transcodes: 0, bandwidth: 0 };
    const text = sessions.length
      ? [plural(t.streams, "stream"), `${t.transcodes ? count.format(t.transcodes) : "none"} transcoding`, mbps(t.bandwidth)].filter(Boolean).join(", ")
      : "Nothing is playing.";
    setText(nowSummary, text);
    nowEmpty.classList.remove("is-error");
    nowEmpty.firstChild.textContent = sessions.length ? "play_circle" : "tv";
  };

  async function loadNow() {
    if (nowBusy) return;
    nowBusy = true;
    try {
      applyNow(await get("now"));
    } catch (error) {
      for (const entry of cards.values()) entry.node.remove();
      cards.clear();
      nowList.hidden = true;
      setText(nowSummary, `${await reason(error)} It tries again every ${REFRESH_MS / 1000} seconds.`);
      nowEmpty.classList.add("is-error");
      nowEmpty.firstChild.textContent = "error_outline";
    } finally {
      nowBusy = false;
    }
  }

  const stopNow = () => {
    window.clearInterval(nowTimer);
    nowTimer = 0;
  };

  /** Refreshes while the page is showing and the tab is in front; stops otherwise. */
  const startNow = () => {
    stopNow();
    if (!shown || document.hidden) return;
    loadNow();
    nowTimer = window.setInterval(loadNow, REFRESH_MS);
  };

  const nowGroup = () => {
    nowSummary = el("span", { role: "status", text: "Checking what is playing…" });
    nowEmpty = el("p", { class: "hera-stats-lede hera-stats-lede--icon" }, [icon("tv"), nowSummary]);
    nowList = el("ul", { class: "hera-stats-now", role: "list", hidden: true });
    return group("Now playing", el("div", {}, [nowEmpty, nowList]));
  };

  // ---------- history -------------------------------------------------------------------------

  /** Every date from the range's start to its end, so a quiet day is a gap and not a missing bar. */
  const spanOf = (data, from) => {
    const to = data.range && data.range.to ? parseDay(data.range.to) : Date.now();
    const start = Math.max(data.range && data.range.from ? parseDay(data.range.from) : to - (state.days - 1) * DAY, from || 0);
    const out = [];
    for (let ms = start; ms <= to && out.length < 400; ms += DAY) out.push(ms);
    return out.length ? out : [to];
  };

  const historySentences = (h) => {
    const t = h.totals;
    const days = (h.range && h.range.days) || state.days;
    const span = days === 365 ? "year" : `${days} days`;
    if (!t.plays) return `Nothing has been played in the last ${span}.`;
    const parts = [`In the last ${span}, ${plural(t.users, "person", "people")} played ${plural(t.titles, "title")} ${plural(t.plays, "time")}, ${duration(t.seconds)} of watching.`];
    const top = h.users.slice().sort((a, b) => b.seconds - a.seconds)[0];
    if (top && t.users > 1) parts.push(`${top.name} watched the most, ${duration(top.seconds)}.`);
    const lead = h.methods.slice().sort((a, b) => b.seconds - a.seconds)[0];
    const methodTotal = sum(h.methods, (m) => m.seconds);
    if (lead && methodTotal) parts.push(`${percent(lead.seconds, methodTotal)} of it was ${lead.label}.`);
    return parts.join(" ");
  };

  /** A bar per row, as a share of the whole: the number in words, so no pie to decode. */
  const shares = (rows, empty) => {
    if (!rows.length) return el("p", { class: "hera-set-status", text: empty });
    const total = sum(rows, (r) => r.seconds) || sum(rows, (r) => r.plays);
    const by = sum(rows, (r) => r.seconds) ? "seconds" : "plays";
    return el(
      "ul",
      { class: "hera-stats-shares", role: "list" },
      rows.slice(0, 8).map((r) => {
        const share = r[by] / total;
        const stats = [percent(r[by], total), r.plays !== undefined ? plural(r.plays, "play") : "", r.seconds ? duration(r.seconds) : ""].filter(Boolean).join(" · ");
        return el("li", {}, [
          el("div", { class: "hera-stats-shares__line" }, [el("span", { class: "hera-stats-shares__label", text: r.label }), el("span", { class: "hera-stats-shares__stats", text: stats })]),
          el("div", { class: "hera-stats-meter", "aria-hidden": "true" }, el("div", { class: "hera-stats-meter__fill", style: `width:${Math.max(1, share * 100).toFixed(1)}%` })),
        ]);
      }),
    );
  };

  const dailyCard = (data) => {
    const dailyByDate = new Map(data.daily.map((d) => [String(d.date).slice(0, 10), d]));
    const span = spanOf(data);
    const rows = span.map((ms) => ({ ms, d: dailyByDate.get(dayKey(ms)) || { plays: 0, seconds: 0, films: 0, episodes: 0 } }));
    const best = rows.reduce((a, b) => (b.d.seconds > a.d.seconds ? b : a), rows[0]);

    const plot = el("div");
    const wrap = card("Plays per day", plot, null);
    const titleId = titleIdOf(wrap);
    const makeChart = () => {
      if (state.metric === "hours") {
        return barChart({
          titleId,
          caption: "Hours watched per day",
          summary: best.d.seconds ? `Busiest day: ${longDay.format(best.ms)}, ${duration(best.d.seconds)} watched.` : "Nothing was watched in this range.",
          days: rows.map(({ ms, d }) => ({ ms, values: [d.seconds / 3600], text: `${longDay.format(ms)}: ${d.seconds ? duration(d.seconds) : "nothing"} watched`, cells: [duration(d.seconds)] })),
          series: [{ name: "Watch time", tone: "solid" }],
          axis: (v) => `${+v.toFixed(2)} hr`,
          tableHead: ["Date", "Watch time"],
        });
      }
      const other = rows.some(({ d }) => d.plays > d.films + d.episodes);
      const series = [{ name: "Films", tone: "solid" }, { name: "TV episodes", tone: "hatch" }, ...(other ? [{ name: "Other", tone: "soft" }] : [])];
      const peak = rows.reduce((a, b) => (b.d.plays > a.d.plays ? b : a), rows[0]);
      return barChart({
        titleId,
        caption: "Plays per day",
        summary: peak.d.plays ? `Busiest day: ${longDay.format(peak.ms)}, ${plural(peak.d.plays, "play")}.` : "Nothing was played in this range.",
        days: rows.map(({ ms, d }) => ({
          ms,
          values: [d.films, d.episodes, ...(other ? [Math.max(0, d.plays - d.films - d.episodes)] : [])],
          text: `${longDay.format(ms)}: ${plural(d.plays, "play")} (${plural(d.films, "film")}, ${plural(d.episodes, "episode")})`,
          cells: [plural(d.films, "film"), plural(d.episodes, "episode"), ...(other ? [String(Math.max(0, d.plays - d.films - d.episodes))] : [])],
        })),
        series,
        axis: (v) => String(v),
        integer: true,
        tableHead: ["Date", ...series.map((s) => s.name)],
      });
    };
    const toggle = segment("Show", [["plays", "Plays"], ["hours", "Hours"]], state.metric, (key) => {
      state.metric = key;
      plot.replaceChildren(makeChart());
    });
    wrap.querySelector(".hera-stats-card__head").append(toggle);
    plot.replaceChildren(makeChart());
    return wrap;
  };

  const whenCard = (data) => {
    const grid = new Array(7).fill(0);
    const byHour = new Array(24).fill(0);
    for (const h of data.hours) {
      if (grid[h.day] === undefined) continue;
      grid[h.day] += h.seconds;
      byHour[h.hour] += h.seconds;
    }
    const total = sum(grid, (v) => v);
    let summary = "Nothing was watched in this range.";
    if (total) {
      const day = grid.indexOf(Math.max(...grid));
      const hour = byHour.indexOf(Math.max(...byHour));
      summary = `Most watching happens on ${WEEKDAYS[day]}s, and the busiest hour is ${String(hour).padStart(2, "0")}:00 to ${String((hour + 1) % 24).padStart(2, "0")}:00. Times are the server's.`;
    }
    const wrap = card("When people watch");
    wrap.append(heatmap({ titleId: titleIdOf(wrap), summary, hours: data.hours }));
    return wrap;
  };

  const avatar = (user) => {
    const initial = el("span", { class: "hera-stats-avatar__initial", "aria-hidden": "true", text: (user.name || "?").slice(0, 1).toUpperCase() });
    const img = el("img", { class: "hera-stats-avatar__img", alt: "", loading: "lazy", src: window.ApiClient.getUrl(`Users/${user.id}/Images/Primary`, { maxWidth: 72, quality: 90 }) });
    img.addEventListener("error", () => img.remove());
    return el("span", { class: "hera-set-avatar hera-stats-avatar" }, [initial, img]);
  };

  const usersCard = (data) => {
    const wrap = card("Who is watching");
    wrap.classList.add("hera-stats-card--flush");
    if (!data.users.length) {
      wrap.append(el("p", { class: "hera-set-status hera-stats-pad", text: "Nobody has watched anything in this range." }));
      return wrap;
    }
    const head = ["User", "Plays", "Watch time", "Last seen", "Last watched"];
    wrap.append(
      el("div", { class: "hera-cfg-table-wrap" }, el("table", { class: "hera-cfg-table hera-stats-table" }, [
        el("thead", {}, el("tr", {}, head.map((text, i) => el("th", { scope: "col", class: i === 1 || i === 2 ? "is-num" : undefined, text })))),
        el("tbody", {}, data.users.map((u) =>
          el("tr", {}, [
            el("th", { scope: "row" }, el("span", { class: "hera-stats-user" }, [avatar(u), el("span", { text: u.name })])),
            el("td", { class: "is-num", text: count.format(u.plays) }),
            el("td", { class: "is-num", text: duration(u.seconds) }),
            el("td", {}, u.lastSeen ? el("time", { datetime: u.lastSeen, title: new Date(u.lastSeen).toLocaleString(), text: ago(u.lastSeen) }) : "Never"),
            el("td", { class: "hera-stats-table__title", text: u.lastTitle || "" }),
          ]))),
      ])),
    );
    return wrap;
  };

  const topList = (rows, empty) => {
    if (!rows.length) return el("p", { class: "hera-set-status", text: empty });
    const max = Math.max(1, ...rows.map((r) => r.seconds));
    return el(
      "ol",
      { class: "hera-stats-top", role: "list" },
      rows.map((r, i) => {
        // Without an id (a title since removed, or one Playback Reporting never knew) the tile stays empty, so names line up.
        const img = el("img", { class: "hera-stats-top__img", alt: "", loading: "lazy" });
        const art = el("span", { class: "hera-stats-top__art" }, img);
        if (r.id) loadArt(img, [imageUrl(r.id, "Primary", 160)]);
        else img.hidden = true;
        return el("li", {}, [
          el("span", { class: "hera-stats-top__rank", "aria-hidden": "true", text: String(i + 1) }),
          art,
          el("div", { class: "hera-stats-top__text" }, [
            el("span", { class: "hera-stats-top__name", text: r.name }),
            el("span", { class: "hera-stats-top__meta", text: `${plural(r.plays, "play")} · ${duration(r.seconds)}` }),
            el("div", { class: "hera-stats-meter", "aria-hidden": "true" }, el("div", { class: "hera-stats-meter__fill", style: `width:${Math.max(2, (r.seconds / max) * 100).toFixed(1)}%` })),
          ]),
        ]);
      }),
    );
  };

  /** Why there is no history, in the words for each cause: the plugin missing, its tables changed, or its file unreadable. */
  const unavailable = (why) => {
    if (why === "schemaChanged") {
      return notice("report_problem", "Playback Reporting is installed, but its database is no longer laid out the way Hera TV reads it, probably after an update to that plugin. Hera TV needs a new release to read it; recording of live streams below is not affected.");
    }
    if (why === "unreadable") {
      return notice("error_outline", "Playback Reporting's database couldn't be read. Check the server log for the error; history returns once the file can be opened.");
    }
    return notice("extension", "Install the Playback Reporting plugin to see history.", el("a", { class: "hera-stats-link", href: CATALOGUE, text: "Find it in the plugin catalogue" }));
  };

  const renderHistory = (data) => {
    if (!data.available) {
      historyBody.replaceChildren(unavailable(data.reason));
    } else {
      const lede = el("p", { class: "hera-stats-lede", text: historySentences(data) });
      const daily = dailyCard(data);
      const films = card("Top films", topList(data.films, "No films were played in this range."));
      const shows = card("Top TV shows", topList(data.shows, "No episodes were played in this range."));
      const how = el("div", { class: "hera-stats-cols hera-stats-cols--3" }, [
        card("Playback method", shares(data.methods, "Nothing was played in this range.")),
        card("Clients", shares(data.clients, "No clients in this range.")),
        card("Devices", shares(data.devices, "No devices in this range.")),
      ]);
      historyBody.replaceChildren(lede, daily, whenCard(data), usersCard(data), el("div", { class: "hera-stats-cols" }, [films, shows]), how);
    }
    renderRecorded(data);
    historyBody.removeAttribute("aria-busy");
  };

  const recordedPlaceholder = (text) => notice("schedule", text);

  const renderRecorded = (data) => {
    const rec = data.recorded;
    const since = rec && rec.since ? longDate.format(Date.parse(rec.since)) : null;
    recordedFoot.hidden = true;
    if (!rec || (!rec.peaks.length && !rec.transcode.length && !rec.resolution.length)) {
      recordedBody.replaceChildren(
        recordedPlaceholder(since ? `Hera started recording streams on ${since}; this fills in as people watch.` : "Hera begins recording streams now; this fills in as people watch."),
      );
      return;
    }

    const start = rec.since ? parseDay(rec.since) : 0;
    const dayRows = (list, fill) => {
      const byDate = new Map(list.map((e) => [String(e.date).slice(0, 10), e]));
      return spanOf(data, start).map((ms) => ({ ms, e: byDate.get(dayKey(ms)) || fill }));
    };

    // Peaks: the most streams at once each day.
    const peakRows = dayRows(rec.peaks, { streams: 0 });
    const peak = peakRows.reduce((a, b) => (b.e.streams > a.e.streams ? b : a), peakRows[0]);
    const peakCard = card("Streams at once");
    peakCard.append(
      barChart({
        titleId: titleIdOf(peakCard),
        caption: "Most streams at once each day",
        summary: peak.e.streams ? `Most at once: ${plural(peak.e.streams, "stream")} on ${longDay.format(peak.ms)}.` : "No streams were recorded in this range.",
        days: peakRows.map(({ ms, e }) => ({ ms, values: [e.streams], text: `${longDay.format(ms)}: ${e.streams ? `up to ${plural(e.streams, "stream")} at once` : "no streams"}`, cells: [String(e.streams)] })),
        series: [{ name: "Peak streams", tone: "solid" }],
        axis: (v) => String(v),
        integer: true,
        tableHead: ["Date", "Most streams at once"],
      }),
    );

    // Direct against transcoded time, per day; the server reports seconds.
    const modeRows = dayRows(rec.transcode, { direct: 0, transcode: 0 });
    const direct = sum(modeRows, (r) => r.e.direct);
    const transcoded = sum(modeRows, (r) => r.e.transcode);
    const modeCard = card("Direct vs transcoded");
    modeCard.append(
      barChart({
        titleId: titleIdOf(modeCard),
        caption: "Hours direct vs transcoded per day",
        summary: direct + transcoded ? `${percent(transcoded, direct + transcoded)} of recorded streaming time was transcoded.` : "No streams were recorded in this range.",
        days: modeRows.map(({ ms, e }) => ({
          ms,
          values: [e.direct / 3600, e.transcode / 3600],
          text: `${longDay.format(ms)}: ${duration(e.direct)} direct, ${duration(e.transcode)} transcoded`,
          cells: [duration(e.direct), duration(e.transcode)],
        })),
        series: [{ name: "Direct", tone: "solid" }, { name: "Transcoded", tone: "hatch" }],
        axis: (v) => `${+v.toFixed(2)} hr`,
        tableHead: ["Date", "Direct", "Transcoded"],
      }),
    );

    const resTotal = sum(rec.resolution, (r) => r.seconds);
    const lead = rec.resolution.slice().sort((a, b) => b.seconds - a.seconds)[0];
    const sentences = [
      peak.e.streams ? `At most ${plural(peak.e.streams, "stream")} played at once, on ${longDay.format(peak.ms)}.` : "",
      direct + transcoded ? `${percent(transcoded, direct + transcoded)} of recorded streaming time was transcoded.` : "",
      lead && resTotal ? `Most watching was in ${lead.label} (${percent(lead.seconds, resTotal)}).` : "",
    ].filter(Boolean);

    recordedBody.replaceChildren(
      ...[
        sentences.length ? el("p", { class: "hera-stats-lede", text: sentences.join(" ") }) : null,
        el("div", { class: "hera-stats-cols" }, [peakCard, modeCard]),
        el("div", { class: "hera-stats-cols" }, [
          card("Resolution", shares(rec.resolution.map((r) => ({ label: r.label, seconds: r.seconds })), "Nothing recorded yet.")),
          card("Bitrate", shares(rec.bitrate.map((r) => ({ label: r.label, seconds: r.seconds })), "Nothing recorded yet.")),
        ]),
      ].filter(Boolean),
    );
    if (since && data.range && data.range.from && start > parseDay(data.range.from)) {
      recordedFoot.textContent = `Hera has recorded streams since ${since}, so earlier days are blank.`;
      recordedFoot.hidden = false;
    }
  };

  const showHistoryError = (message) => {
    const retry = el("button", { class: "hera-set-btn hera-set-btn--small", type: "button" }, [icon("refresh"), el("span", { text: "Try again" })]);
    retry.addEventListener("click", loadHistory);
    historyBody.replaceChildren(el("p", { class: "hera-set-status is-error hera-stats-error", role: "status" }, [icon("error_outline"), el("span", { text: message }), retry]));
    recordedBody.replaceChildren();
    recordedFoot.hidden = true;
    historyBody.removeAttribute("aria-busy");
  };

  async function loadHistory() {
    const token = ++historyToken;
    historyBody.setAttribute("aria-busy", "true");
    let data;
    try {
      data = await get("history", { days: state.days });
    } catch (error) {
      const message = await reason(error);
      if (token === historyToken) showHistoryError(message);
      return;
    }
    if (token !== historyToken) return;
    try {
      renderHistory(data);
    } catch (error) {
      console.error("[Hera TV:stats]", error);
      showHistoryError("Couldn't draw the statistics: the server's answer wasn't what this page expects.");
    }
  }

  const historyGroup = () => {
    historyBody = el("div", { class: "hera-stats-stack", "aria-live": "polite" }, el("p", { class: "hera-set-status", text: "Loading history…" }));
    const range = segment("Time range", RANGES.map(([days, text]) => [String(days), text]), String(state.days), (key) => {
      state.days = Number(key);
      loadHistory();
    });
    return group("History", historyBody, range);
  };

  const recordedGroup = () => {
    recordedBody = el("div", { class: "hera-stats-stack" });
    recordedFoot = el("p", { class: "hera-set-group__foot", hidden: true });
    const section = group("Recorded by Hera", recordedBody);
    section.append(recordedFoot);
    return section;
  };

  // ---------- lifecycle -----------------------------------------------------------------------

  const build = () => {
    root.replaceChildren(
      el("h1", { class: "hera-set-title", text: "Statistics" }),
      nowGroup(),
      historyGroup(),
      recordedGroup(),
    );
  };

  const onVisibility = () => startNow();

  const show = () => {
    if (shown) return;
    shown = true;
    if (!nowList) build();
    document.addEventListener("visibilitychange", onVisibility);
    startNow();
    loadHistory();
  };
  view.addEventListener("viewshow", show);
  view.addEventListener("viewhide", () => {
    shown = false;
    stopNow();
    document.removeEventListener("visibilitychange", onVisibility);
  });
  // The controller can finish loading after Jellyfin has already fired viewshow, and the page would
  // then stay empty for ever; so it also starts itself if it finds the view showing.
  if (view.isConnected && !view.classList.contains("hide")) show();
}
