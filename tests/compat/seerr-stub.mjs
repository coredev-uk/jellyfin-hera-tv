// A stand-in for Seerr, so Hera's Discover and Requests views, and the endpoints behind them, run in
// the compatibility test: without a Seerr to talk to they switch themselves off, and nothing about
// them would be checked. It answers only what those views ask for, with two invented titles; the
// run never leaves the machine.
//
// Run on its own to look at it: `node seerr-stub.mjs` prints the port it listens on.
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

export const API_KEY = "hera-compat-seerr";

const MOVIE = { id: 9001, title: "Stub Film", releaseDate: "2020-01-01", overview: "A film that exists only in the compatibility test.", voteAverage: 7.4, posterPath: null, backdropPath: null };
const SHOW = { id: 9002, name: "Stub Show", firstAirDate: "2021-01-01", overview: "A series that exists only in the compatibility test.", voteAverage: 8.1, posterPath: null, backdropPath: null };

const page = () => ({
  page: 1,
  totalPages: 1,
  totalResults: 2,
  results: [{ ...MOVIE, mediaType: "movie" }, { ...SHOW, mediaType: "tv" }],
});

/** The Seerr user that owns the requests: Hera is told `hera=1`, and the second user has none. */
const requestsOf = (user) => ({
  pageInfo: { pages: 1, pageSize: 20, results: user === "1" ? 1 : 0, page: 1 },
  results:
    user === "1"
      ? [{ id: 1, status: 2, type: "movie", createdAt: "2026-01-01T12:00:00.000Z", media: { mediaType: "movie", tmdbId: MOVIE.id, status: 3 }, seasons: [] }]
      : [],
});

const answer = (path) => {
  if (/^\/api\/v1\/discover\/(trending|movies|tv)(\/upcoming)?$/.test(path) || path === "/api/v1/search") return page();
  const requests = /^\/api\/v1\/user\/(\d+)\/requests$/.exec(path);
  if (requests) return requestsOf(requests[1]);
  if (path === `/api/v1/movie/${MOVIE.id}`) return { ...MOVIE, mediaInfo: { status: 3 } };
  if (path === `/api/v1/tv/${SHOW.id}`) return { ...SHOW, mediaInfo: { status: 3 } };
  return null;
};

/** Starts the stub on a free port of every interface (the Jellyfin container reaches it from outside). */
export const startSeerrStub = () =>
  new Promise((resolve, reject) => {
    const hits = [];
    const server = createServer((request, response) => {
      const { pathname } = new URL(request.url ?? "/", "http://stub");
      const send = (status, body) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.headers["x-api-key"] !== API_KEY) return send(403, { message: "bad key" });
      const body = answer(pathname);
      hits.push(`${request.method} ${pathname}${body ? "" : " (404)"}`);
      return body ? send(200, body) : send(404, { message: "not in the stub" });
    });
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => resolve({ port: server.address().port, hits, close: () => new Promise((done) => server.close(done)) }));
  });

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const stub = await startSeerrStub();
  console.log(`Seerr stub on port ${stub.port}; X-Api-Key: ${API_KEY}`);
}
