// What counts as broken, kept apart from the browser and the server so it can be tested on its own
// (judge.test.mjs). Everything here takes plain data and returns messages: `failures` fail the run,
// `warnings` are only worth knowing.

/** Boot states that mean Hera is running. A signed-out page never gets past `starting`: it has no user to boot for. */
const BOOT_OK = new Set(["ok", "untested"]);

/** Hera's own scripts: the bundle and its single files under /HeraTV/, and the two Dashboard page controllers. */
export const isHeraScript = (url) => /\/HeraTV\/[^/?#]+\.js(?:[?#]|$)/i.test(url || "") || /(?:heratv-settings|herastats)\.js/i.test(url || "");

/** Anything under /HeraTV/, scripts, styles and API calls alike. */
export const isHeraUrl = (text) => /\/HeraTV\//i.test(text || "");

/**
 * The verdict on one health snapshot (`window.HeraTV.health()`), page by page.
 *
 * A module's status stays until it next runs, so a break would be repeated on every page after the
 * first. Each is reported once, where it was first seen, with the modules it hit together: one
 * missing piece of Jellyfin usually degrades several at once.
 *
 * `spec.modules` names the modules that must have run, and be fine, once the page has shown.
 *
 * @returns {(snapshot: object|null, spec: object, jf: object|null) => { failures: string[], warnings: string[] }}
 */
export const createJudge = () => {
  const reported = new Set();

  return (snapshot, spec, jf, shown = null) => {
    const failures = [];
    const warnings = [];
    if (!snapshot) {
      failures.push(`${spec.name}: window.HeraTV is missing; the plugin's scripts are not running on this page`);
      return { failures, warnings };
    }

    const bootOk = BOOT_OK.has(snapshot.boot) || (spec.signedOut && snapshot.boot === "starting");
    if (!bootOk) {
      failures.push(
        snapshot.boot === "safe"
          ? `${spec.name}: Hera went into safe mode: ${snapshot.reason}`
          : `${spec.name}: Hera never finished starting (boot is "${snapshot.boot}")${snapshot.reason ? `: ${snapshot.reason}` : ""}`,
      );
    }
    if (snapshot.boot === "untested") {
      warnings.push(`Jellyfin ${snapshot.jellyfin} is not one Hera was tested on (${(snapshot.tested || []).join(", ")})`);
    }

    const modules = snapshot.modules ?? [];
    const named = (m) => (m.missing ?? []).map((key) => `${key} (${jf?.[key] ?? "?"})`).join(", ");
    const groups = new Map();
    const note = (m, detail) => {
      if (reported.has(`${m.name}|${detail}`)) return;
      reported.add(`${m.name}|${detail}`);
      if (!groups.has(detail)) groups.set(detail, []);
      groups.get(detail).push(m.name);
    };

    for (const m of modules) {
      if (m.status === "degraded") note(m, `degraded on ${m.page}, Jellyfin has no ${named(m)}`);
      else if (m.status === "partial") note(m, `only partly working${m.page ? ` on ${m.page}` : ""}, Jellyfin has no ${named(m)}`);
      else if (m.status === "disabled") note(m, `disabled after repeated errors, last: ${m.lastError}`);
      // One throw is already a bug in Hera, or in what it leans on, even when the module recovers.
      else if (m.errors > 0) note(m, `threw ${m.errors} time(s), last: ${m.lastError}`);
    }
    for (const [detail, names] of groups) {
      failures.push(`${names.length > 1 ? "modules" : "module"} ${names.map((name) => `"${name}"`).join(", ")}: ${detail} (first seen on ${spec.name})`);
    }

    // A module that never ran did not fail, it was just not there: the page would look as if Hera
    // had nothing to do. The modules a page needs are named per page, and each must have run on the
    // page that showed (a status stays from the page before, so `ok` alone proves nothing). A module
    // that only reports through kit.report (the sign-in page's) has no runs and is taken at its word.
    const byName = new Map(modules.map((m) => [m.name, m]));
    for (const name of spec.modules ?? []) {
      const m = byName.get(name);
      let detail = null;
      if (!m) detail = "never ran (not in the health report)";
      else if (m.status === "idle") detail = "never ran (status idle)";
      else if (m.status === "ok" && shown && m.runs > 0 && Array.isArray(m.ranOn) && !m.ranOn.includes(shown)) {
        detail = `never ran on ${shown} (it ran on ${m.ranOn.join(", ") || "no page"})`;
      }
      if (!detail || reported.has(`${name}|${detail}`)) continue;
      reported.add(`${name}|${detail}`);
      failures.push(`module "${name}": ${detail} (first seen on ${spec.name})`);
    }
    return { failures, warnings };
  };
};

/**
 * Console messages Hera's own scripts wrote at warning or error level. A Jellyfin newer than the
 * tested release is announced once with a warning; that is `boot: untested`, already a warning of
 * its own, not a second failure.
 *
 * @param {{ type: string, text: string, url: string }[]} entries
 */
export const judgeConsole = (entries, spec, snapshot) => {
  const failures = [];
  for (const { type, text, url } of entries) {
    if (type !== "error" && type !== "warning") continue;
    if (!isHeraScript(url)) continue;
    if (type === "warning" && snapshot?.boot === "untested" && /^\[Hera TV\] Jellyfin \S+ /.test(text)) continue;
    failures.push(`Hera logged a console ${type === "warning" ? "warning" : "error"} on ${spec.name}: ${text.split("\n")[0].slice(0, 300)}`);
  }
  return failures;
};

/** A 5xx under /HeraTV/ is a server fault, whoever asked; a 4xx on an asset is a file that is not there. */
export const judgeResponse = (url, status) => {
  if (status >= 500 && isHeraUrl(url)) return `${url} answered ${status}`;
  if (status >= 400 && /\/HeraTV\/[^/?]+\.(js|css|woff2)(\?|$)/.test(url)) return `${url} answered ${status}`;
  return null;
};

// ---------- Jellyfin's own log ------------------------------------------------------------------

const HEADER = /^\[[^\]]*\]\s*\[([A-Z]{3})\]/;

/**
 * Splits Jellyfin's console log into [ERR] and [FTL] entries, and picks out those whose text names
 * the plugin: its logger (`Jellyfin.Plugin.HeraTv.…:`) or a stack frame in its assembly. A stack
 * runs on the lines that do not start with a bracketed timestamp.
 */
export const scanLog = (text) => {
  const entries = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const header = HEADER.exec(line);
    if (header) {
      current = header[1] === "ERR" || header[1] === "FTL" ? { level: header[1], lines: [line] } : null;
      if (current) entries.push(current);
    } else if (current) current.lines.push(line);
  }
  const hera = entries.filter((entry) => entry.lines.some((line) => /Jellyfin\.Plugin\.HeraTv/.test(line)));
  return { errors: entries, hera, fatal: entries.filter((entry) => entry.level === "FTL") };
};

/** An entry as it is quoted in the summary: the message, then the stack down to the first frame in the plugin. */
export const quoteEntry = (entry, maxLines = 12) => {
  const lines = entry.lines.map((line) => line.trimEnd());
  const first = lines.findIndex((line, index) => index > 0 && /Jellyfin\.Plugin\.HeraTv/.test(line));
  const shown = lines.slice(0, Math.min(Math.max(maxLines, first >= 0 ? first + 1 : 0), 40));
  return shown.length < lines.length ? [...shown, `… (${lines.length - shown.length} more lines)`].join("\n") : shown.join("\n");
};

/** What the plugin said at warning level: worth reading in a clean run, not a failure. */
export const heraWarnings = (text, limit = 5) => {
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!/^\[[^\]]*\]\s*\[WRN\]/.test(line) || !/Jellyfin\.Plugin\.HeraTv|Hera TV/.test(line)) continue;
    seen.add(line.replace(/^\[[^\]]*\]\s*\[WRN\]\s*(\[\d+\]\s*)?/, "").slice(0, 300));
    if (seen.size >= limit) break;
  }
  return [...seen];
};
