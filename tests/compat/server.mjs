// Drives a fresh Jellyfin server through its API: the startup wizard, two libraries, and one
// collection of both films. Nothing here touches the web client, so a Jellyfin update that
// changes its markup cannot break the setup, only the pages under test.

export const USER = { name: "hera", password: "hera-compat" };
export const DEVICE = { id: "hera-compat-ci", name: "Hera compat", client: "Hera compat", version: "1" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const header = (token) =>
  `MediaBrowser Client="${DEVICE.client}", Device="${DEVICE.name}", DeviceId="${DEVICE.id}", Version="${DEVICE.version}"${token ? `, Token="${token}"` : ""}`;

/** A fetch against `base` that throws on a non-2xx answer and returns the parsed JSON, if any. */
export const api = (base, token) => async (path, { method = "GET", body } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: header(token), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

/** Retries `step` until it stops throwing; the server answers 5xx while it is still starting. */
const eventually = async (what, step, { timeout = 60_000, every = 1000 } = {}) => {
  const until = Date.now() + timeout;
  for (;;) {
    try {
      return await step();
    } catch (error) {
      if (Date.now() > until) throw new Error(`${what}: ${error.message}`);
      await sleep(every);
    }
  }
};

// The server answers /System/Info/Public from a stripped-down host while it is still starting;
// the real one names its version.
export const waitForServer = (base, timeout = 180_000) =>
  eventually(
    "Jellyfin did not come up",
    async () => {
      const info = await api(base)("/System/Info/Public");
      if (!info?.Version) throw new Error("still starting");
      return info;
    },
    { timeout, every: 1500 },
  );

/** Completes the startup wizard with one administrator, and signs in as them. */
export const setUp = async (base) => {
  const anonymous = api(base);
  await eventually("startup wizard", async () => {
    await anonymous("/Startup/Configuration", {
      method: "POST",
      body: { UICulture: "en-GB", MetadataCountryCode: "GB", PreferredMetadataLanguage: "en" },
    });
    // The wizard's first user is created by renaming the default one, which the GET makes exist.
    await anonymous("/Startup/User");
    await anonymous("/Startup/User", { method: "POST", body: { Name: USER.name, Password: USER.password } });
    await anonymous("/Startup/Complete", { method: "POST" });
  });

  const session = await anonymous("/Users/AuthenticateByName", { method: "POST", body: { Username: USER.name, Pw: USER.password } });
  const token = session.AccessToken;
  const jf = api(base, token);
  return { jf, token, userId: session.User.Id, serverId: session.ServerId };
};

const library = (name, collectionType, path) =>
  // Local .nfo files and artwork only: the run must not depend on the internet.
  ({
    name,
    collectionType,
    refreshLibrary: "false",
    body: {
      LibraryOptions: {
        PathInfos: [{ Path: path }],
        EnableInternetProviders: false,
        EnableRealtimeMonitor: false,
        SaveLocalMetadata: false,
        // An empty fetcher list per type switches TMDb and the other remote providers off.
        TypeOptions: ["Movie", "Series", "Season", "Episode"].map((Type) => ({ Type, MetadataFetchers: [], ImageFetchers: [] })),
      },
    },
  });

/** Creates the Films and TV Shows libraries, waits for the scan, then gathers the collection. */
export const populate = async ({ jf, userId }) => {
  for (const { name, collectionType, refreshLibrary, body } of [
    library("Films", "movies", "/media/Films"),
    library("TV Shows", "tvshows", "/media/TV Shows"),
  ]) {
    const query = new URLSearchParams({ name, collectionType, refreshLibrary });
    await jf(`/Library/VirtualFolders?${query}`, { method: "POST", body });
  }

  // A scan that starts while the libraries are still being added can finish having found nothing,
  // so the scan is asked for again until the items turn up.
  const items = (types) => jf(`/Items?${new URLSearchParams({ userId, recursive: "true", includeItemTypes: types, fields: "Path" })}`).then((r) => r.Items);
  const want = { Movie: 2, Series: 1, Episode: 2 };
  let scanned = 0;
  const found = await eventually(
    "library scan",
    async () => {
      if (Date.now() - scanned > 20_000) {
        scanned = Date.now();
        await jf("/Library/Refresh", { method: "POST" });
      }
      const all = await items("Movie,Series,Episode");
      const have = Object.fromEntries(Object.keys(want).map((type) => [type, all.filter((item) => item.Type === type).length]));
      if (Object.keys(want).some((type) => have[type] !== want[type])) throw new Error(`found ${JSON.stringify(have)}, want ${JSON.stringify(want)}`);
      // Artwork is read after the items are created; wait for it so the pages have images to lay out.
      const bare = all.filter((item) => item.Type !== "Episode" && !item.ImageTags?.Primary);
      if (bare.length) throw new Error(`no poster yet for ${bare.map((item) => item.Name).join(", ")}`);
      return all;
    },
    { timeout: 180_000, every: 2000 },
  );

  const films = found.filter((item) => item.Type === "Movie").sort((a, b) => a.Name.localeCompare(b.Name));
  const collection = await jf(`/Collections?${new URLSearchParams({ name: "Hera Pair", ids: films.map((film) => film.Id).join(",") })}`, { method: "POST" });
  const folders = await jf("/Library/VirtualFolders");
  const folder = (name) => folders.find((entry) => entry.Name === name)?.ItemId;

  return {
    films,
    filmsLibrary: folder("Films"),
    showsLibrary: folder("TV Shows"),
    series: found.find((item) => item.Type === "Series"),
    episode: found.filter((item) => item.Type === "Episode").sort((a, b) => a.Path.localeCompare(b.Path))[0],
    collection: collection.Id,
  };
};
