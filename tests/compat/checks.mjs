// The server's side of the run: the plugin loaded, every Hera endpoint answers as the administrator
// and as an ordinary viewer, Hera's two scheduled tasks run to the end, and Hera's own account of
// itself (GET /HeraTV/health) has nothing wrong in it. Each check pushes messages into `failures`;
// none of them throws for a bad answer, since a bad answer is the finding.
import { eventually, sleep } from "./server.mjs";

/** Hera TV's plugin id (meta.json's guid), as /Plugins writes it. */
const PLUGIN_ID = "9718b214-55d6-4828-84c8-677f2a4a131b";

// ---------- the plugin ------------------------------------------------------------------------------

/** Jellyfin reports a plugin it refused to load as NotSupported or Malfunctioned, and the web client then has no Hera at all. */
export const checkPlugin = async (admin) => {
  const failures = [];
  const { status, body } = await admin("/Plugins");
  if (status !== 200 || !Array.isArray(body)) return [`/Plugins answered ${status}`];
  const hera = body.find((plugin) => String(plugin.Id).toLowerCase() === PLUGIN_ID || plugin.Name === "Hera TV");
  if (!hera) failures.push("Jellyfin does not list the Hera TV plugin at all (/Plugins)");
  else if (hera.Status !== "Active") failures.push(`Jellyfin lists the Hera TV plugin as ${hera.Status}, not Active`);
  return failures;
};

// ---------- the API ---------------------------------------------------------------------------------

const OK = [200];
const ADMIN_ONLY = { admin: OK, user: [403] };
const EVERYONE = { admin: OK, user: OK };

/**
 * Every endpoint a page of Hera's calls without changing anything, with the status each kind of
 * caller must get. A wrong status in either direction matters: a 403 for an administrator is a
 * policy Jellyfin renamed, a 200 for a viewer is a policy that has stopped being checked. A 5xx is a
 * fault whatever was expected.
 */
export const endpoints = ({ film, series }) => [
  { path: "/HeraTV/integrations", ...EVERYONE },
  { path: "/HeraTV/discover/lists/trending", ...EVERYONE },
  { path: "/HeraTV/discover/lists/movies", ...EVERYONE },
  { path: "/HeraTV/discover/lists/tv", ...EVERYONE },
  { path: "/HeraTV/discover/lists/upcoming-movies", ...EVERYONE },
  { path: "/HeraTV/discover/lists/upcoming-tv", ...EVERYONE },
  { path: "/HeraTV/discover/search?query=stub", ...EVERYONE },
  { path: "/HeraTV/leaving", ...EVERYONE },
  { path: `/HeraTV/extras/${film}`, ...EVERYONE },
  { path: `/HeraTV/extras/${series}`, ...EVERYONE },
  { path: `/HeraTV/extras/badges?ids=${film},${series}`, ...EVERYONE },
  { path: "/HeraTV/hidden", ...EVERYONE },
  { path: `/HeraTV/trailers/${film}`, ...EVERYONE },
  { path: "/HeraTV/collections/groups", ...EVERYONE },
  { path: "/HeraTV/collections/rows", ...EVERYONE },
  { path: `/HeraTV/collections/next/${film}`, admin: [200, 204], user: [200, 204] },
  { path: "/HeraTV/activity/requests", ...EVERYONE },
  { path: "/HeraTV/activity/title/movie/9001", admin: [200, 404], user: [200, 404] },
  { path: "/HeraTV/activity/downloads", ...ADMIN_ONLY },
  { path: "/HeraTV/notifications", ...EVERYONE },
  { path: "/HeraTV/notifications/prefs", ...EVERYONE },
  { path: "/HeraTV/stats/now", ...ADMIN_ONLY },
  { path: "/HeraTV/stats/history?days=30", ...ADMIN_ONLY },
  { path: "/HeraTV/stats/me?days=30", ...EVERYONE },
  { path: "/HeraTV/letterboxd", ...EVERYONE },
  { path: "/HeraTV/settings", ...ADMIN_ONLY },
  { path: "/HeraTV/settings/collections/status", ...ADMIN_ONLY },
  { path: "/HeraTV/settings/letterboxd/links", ...ADMIN_ONLY },
  { path: "/HeraTV/health", ...ADMIN_ONLY },
];

/** Reachable without signing in: the page loads these before there is anyone. */
const ANONYMOUS_OK = ["/HeraTV/config", "/HeraTV/compat", "/HeraTV/hera-bundle.js", "/HeraTV/hera-bundle.css", "/HeraTV/InterVariable.woff2"];

/** Needs someone: asking with no token must be refused, not answered. */
const ANONYMOUS_REFUSED = ["/HeraTV/integrations", "/HeraTV/stats/me?days=30", "/HeraTV/notifications", "/HeraTV/collections/rows"];

/**
 * Calls each endpoint once as the administrator and once as the viewer, and the open and closed
 * ones with no token.
 * @returns {{ failures: string[], table: { path: string, as: string, status: number }[] }}
 */
export const checkApi = async ({ admin, viewer, anonymous, ids }) => {
  const failures = [];
  const table = [];
  const expect = (path, who, status, allowed) => {
    table.push({ path, as: who, status, ok: status < 500 && allowed.includes(status) });
    if (status >= 500) failures.push(`${who === "anonymous" ? "an unsigned request" : `the ${who}`} got ${status} from ${path}`);
    else if (!allowed.includes(status)) failures.push(`${path} answered ${status} to the ${who}; expected ${allowed.join(" or ")}`);
  };

  for (const endpoint of endpoints(ids)) {
    for (const [who, call] of [["administrator", admin], ["viewer", viewer]]) {
      const { status } = await call(endpoint.path);
      expect(endpoint.path, who, status, endpoint[who === "administrator" ? "admin" : "user"]);
    }
  }
  for (const path of ANONYMOUS_OK) expect(path, "anonymous", (await anonymous(path)).status, OK);
  for (const path of ANONYMOUS_REFUSED) expect(path, "anonymous", (await anonymous(path)).status, [401]);
  return { failures, table };
};

// ---------- scheduled tasks ---------------------------------------------------------------------------

/** Hera's two scheduled tasks, by the Key their classes give them. */
export const TASKS = ["HeraTvBuildCollections", "HeraTvLetterboxd"];

/**
 * Runs each of Hera's tasks through Jellyfin's own task API and waits for it to finish. A task whose
 * constructor Jellyfin could not build is absent from the list; one that throws ends Failed.
 */
export const runTasks = async (admin) => {
  const failures = [];
  const results = [];
  const listed = await admin("/ScheduledTasks");
  if (listed.status !== 200 || !Array.isArray(listed.body)) return { failures: [`/ScheduledTasks answered ${listed.status}`], results };

  for (const key of TASKS) {
    const task = listed.body.find((entry) => entry.Key === key);
    if (!task) {
      failures.push(`Jellyfin has no scheduled task ${key}`);
      continue;
    }
    // The server's clock, not ours: a task's own start time is compared with it.
    const startedAt = Date.now() - 5_000;
    const started = await admin(`/ScheduledTasks/Running/${task.Id}`, { method: "POST" });
    if (started.status >= 300) {
      failures.push(`starting ${key} answered ${started.status}`);
      continue;
    }

    const finished = await eventually(
      `${key} did not finish`,
      async () => {
        const { body } = await admin(`/ScheduledTasks/${task.Id}`);
        const last = body?.LastExecutionResult;
        if (body?.State !== "Idle" || !last || Date.parse(last.StartTimeUtc) < startedAt) throw new Error(`state ${body?.State}`);
        return last;
      },
      { timeout: 300_000, every: 2000 },
    ).catch((error) => ({ Status: "DidNotFinish", ErrorMessage: error.message }));

    results.push({ key, status: finished.Status });
    if (finished.Status !== "Completed") {
      failures.push(`scheduled task ${key} ended ${finished.Status}${finished.ErrorMessage ? `: ${finished.ErrorMessage}` : ""}`);
    }
  }
  return { failures, results };
};

// ---------- Hera's account of itself -------------------------------------------------------------------

/** What Hera says about itself once the run is over: no server feature faulted, the page was rewritten. */
export const checkHealth = async (admin) => {
  const failures = [];
  const { status, body } = await admin("/HeraTV/health");
  if (status !== 200 || !body) return [`/HeraTV/health answered ${status}`];

  for (const fault of body.server ?? []) {
    failures.push(`the server reports "${fault.feature}" ${fault.status} (${fault.count}x): ${fault.message}`);
  }
  if (!body.injection?.lastInjected) {
    failures.push(`the server never rewrote the web client's page${body.injection?.lastDecline ? `; last declined because ${body.injection.lastDecline.reason}` : ""}`);
  }
  return failures;
};

// ---------- the film that is playing ---------------------------------------------------------------------

/** The stream the browser started must be one the server can see: the statistics read the same sessions. */
export const checkStreams = async (admin) => {
  const { status, body } = await admin("/HeraTV/stats/now");
  if (status !== 200) return [`/HeraTV/stats/now answered ${status} while a film was playing`];
  const count = body?.totals?.streams ?? (Array.isArray(body?.sessions) ? body.sessions.length : 0);
  return count > 0 ? [] : ["/HeraTV/stats/now listed no stream while a film was playing"];
};

/** Is Jellyfin still answering: a background service that takes the host down does it a while after the start. */
export const stillUp = async (anonymous) => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const { status, body } = await anonymous("/System/Info/Public");
      if (status === 200 && body?.Version) return true;
    } catch {
      /* try again */
    }
    await sleep(2000);
  }
  return false;
};
