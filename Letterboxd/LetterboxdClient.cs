using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.HeraTv.Letterboxd;

/// <summary>Why a Letterboxd call failed, as far as the caller needs to tell.</summary>
public enum LetterboxdFailure
{
    /// <summary>Sign-in refused: the username or password is wrong.</summary>
    BadCredentials,

    /// <summary>The API key or secret was refused, so no one can sign in until an administrator fixes it.</summary>
    KeyRejected,

    /// <summary>The member's token was refused: the link needs signing in again.</summary>
    Unauthorised,

    /// <summary>Letterboxd could not be reached, or answered with a server error.</summary>
    Unreachable,

    /// <summary>Still rate limited after the one retry.</summary>
    RateLimited,

    /// <summary>Any other refusal.</summary>
    Api,
}

/// <summary>A failed Letterboxd call. The message is safe to log and to show: it never carries a sign-in's reply.</summary>
public sealed class LetterboxdException(LetterboxdFailure failure, string message, int? status = null, Exception? inner = null)
    : Exception(message, inner)
{
    public LetterboxdFailure Failure { get; } = failure;

    public int? Status { get; } = status;

    /// <summary>Gets a value indicating whether the member must sign in again, as opposed to a fault worth retrying.</summary>
    public bool NeedsSignIn => Failure is LetterboxdFailure.BadCredentials or LetterboxdFailure.Unauthorised;
}

/// <summary>A film as Letterboxd knows it.</summary>
public sealed record LetterboxdFilm(string Id, string Name, int? Year);

/// <summary>
/// The slice of Letterboxd's API needed to write diary entries: every request signed with the API
/// secret, sign-in once with a password and afterwards with a refresh token.
/// </summary>
/// <remarks>
/// Letterboxd's Cloudflare front rejects default user agents, so this sends its own. A single
/// instance is one member's session; it holds no state beyond the access token.
/// </remarks>
public sealed class LetterboxdClient(string apiKey, string apiSecret)
{
    public const string Api = "https://api.letterboxd.com/api/v0";

    private const string UserAgent = "HeraTV-Letterboxd/1.0 (Jellyfin plugin)";

    // Longest Retry-After honoured on a 429 before giving up.
    private const int MaxRetryAfterSeconds = 60;

    private const int MaxDiaryPages = 50;

    private static readonly HttpClient Http = new(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) })
    {
        Timeout = TimeSpan.FromSeconds(30),
    };

    private string? accessToken;

    /// <summary>Gets or sets the member's id, which the diary read is filtered by. Set by <see cref="SignInAsync"/> and <see cref="MeAsync"/>.</summary>
    public string? MemberId { get; set; }

    /// <summary>Signs in with a password, once, when someone links their account. The password is never kept.</summary>
    /// <returns>The refresh token to store, and the member.</returns>
    public async Task<(string RefreshToken, string MemberId, string Username)> SignInAsync(string username, string password, CancellationToken ct)
    {
        var reply = await SendAsync(
            HttpMethod.Post,
            "/auth/token",
            null,
            Form(("grant_type", "password"), ("username", username), ("password", password)),
            ct).ConfigureAwait(false);
        var refresh = TakeToken(reply) ?? throw new LetterboxdException(LetterboxdFailure.Api, "Sign-in reply had no refresh token");
        var (id, name) = await MeAsync(ct).ConfigureAwait(false);
        return (refresh, id, name ?? username);
    }

    /// <summary>Signs in with the stored refresh token. Returns the token to store from now on: Letterboxd may rotate it.</summary>
    public async Task<string> RefreshAsync(string refreshToken, CancellationToken ct)
    {
        var reply = await SendAsync(
            HttpMethod.Post,
            "/auth/token",
            null,
            Form(("grant_type", "refresh_token"), ("refresh_token", refreshToken)),
            ct).ConfigureAwait(false);
        return TakeToken(reply) ?? refreshToken;
    }

    /// <summary>Reads the signed-in member.</summary>
    public async Task<(string Id, string? Username)> MeAsync(CancellationToken ct)
    {
        var reply = await SendAsync(HttpMethod.Get, "/me", null, null, ct).ConfigureAwait(false);
        var member = reply?["member"];
        var id = (string?)member?["id"];
        if (string.IsNullOrEmpty(id))
        {
            throw new LetterboxdException(LetterboxdFailure.Api, "Letterboxd's reply had no member id");
        }

        MemberId = id;
        return (id, (string?)member?["username"]);
    }

    /// <summary>
    /// The Letterboxd film for a title: by TMDb id, then IMDb id, then an exact title and year match.
    /// Null when nothing matches unambiguously.
    /// </summary>
    public async Task<LetterboxdFilm?> FindFilmAsync(string? tmdbId, string? imdbId, string title, int? year, CancellationToken ct)
    {
        foreach (var (prefix, ident) in new[] { ("tmdb", tmdbId), ("imdb", imdbId) })
        {
            if (string.IsNullOrWhiteSpace(ident))
            {
                continue;
            }

            var data = await SendAsync(HttpMethod.Get, "/films", [("filmId", $"{prefix}:{ident.Trim()}"), ("perPage", "1")], null, ct).ConfigureAwait(false);
            if (data?["items"] is JsonArray { Count: > 0 } items && Film(items[0]) is { } film)
            {
                return film;
            }
        }

        if (year is null || string.IsNullOrWhiteSpace(title))
        {
            return null;
        }

        var found = await SendAsync(HttpMethod.Get, "/search", [("input", title), ("include", "FilmSearchItem"), ("perPage", "20")], null, ct).ConfigureAwait(false);
        var matches = (found?["items"] as JsonArray ?? [])
            .Select(item => Film(item?["film"]))
            .Where(film => film is not null && string.Equals(film.Name, title, StringComparison.OrdinalIgnoreCase) && film.Year == year)
            .ToList();
        return matches.Count == 1 ? matches[0] : null;
    }

    /// <summary>Every date (<c>yyyy-MM-dd</c>) the member has the film in their diary, all pages.</summary>
    public async Task<HashSet<string>> DiaryDatesAsync(string filmId, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(MemberId))
        {
            throw new InvalidOperationException("The member isn't known yet.");
        }

        var dates = new HashSet<string>(StringComparer.Ordinal);
        string? cursor = null;
        for (var page = 0; page < MaxDiaryPages; page++)
        {
            var query = new List<(string, string)> { ("member", MemberId), ("film", filmId), ("perPage", "100") };
            if (cursor is not null)
            {
                query.Add(("cursor", cursor));
            }

            var data = await SendAsync(HttpMethod.Get, "/log-entries", query, null, ct).ConfigureAwait(false)
                ?? throw new LetterboxdException(LetterboxdFailure.Api, "The diary read returned no data");
            foreach (var item in data["items"] as JsonArray ?? [])
            {
                if ((string?)item?["diaryDetails"]?["diaryDate"] is { Length: >= 10 } date)
                {
                    dates.Add(date[..10]);
                }
            }

            cursor = (string?)data["next"];
            if (string.IsNullOrEmpty(cursor))
            {
                break;
            }
        }

        return dates;
    }

    /// <summary>Adds one diary entry.</summary>
    public async Task LogAsync(string filmId, string date, bool rewatch, CancellationToken ct)
    {
        var body = new JsonObject
        {
            ["filmId"] = filmId,
            ["diaryDetails"] = new JsonObject { ["diaryDate"] = date, ["rewatch"] = rewatch },
            ["like"] = false,
            ["tags"] = new JsonArray(),
        };
        await SendAsync(HttpMethod.Post, "/log-entries", null, body.ToJsonString(), ct, "application/json").ConfigureAwait(false);
    }

    /// <summary>The body of a sign-in reply is a token: keep the access token for later calls, hand back the refresh token.</summary>
    private string? TakeToken(JsonObject? reply)
    {
        var access = (string?)reply?["access_token"];
        if (string.IsNullOrEmpty(access))
        {
            throw new LetterboxdException(LetterboxdFailure.Api, "Sign-in reply had no access token");
        }

        accessToken = access;
        return (string?)reply?["refresh_token"];
    }

    private static LetterboxdFilm? Film(JsonNode? node)
        => node is JsonObject && (string?)node["id"] is { Length: > 0 } id
            ? new LetterboxdFilm(id, (string?)node["name"] ?? string.Empty, node["releaseYear"] is { } year && int.TryParse(year.ToString(), CultureInfo.InvariantCulture, out var y) ? y : null)
            : null;

    private static string Form(params (string Key, string Value)[] fields)
        => string.Join('&', fields.Select(f => $"{Escape(f.Key)}={Escape(f.Value)}"));

    /// <summary>Percent-encodes as Python's <c>urlencode</c> does: only letters, digits and <c>-._~</c> stay, a space becomes <c>+</c>.</summary>
    internal static string Escape(string value)
    {
        var sb = new StringBuilder(value.Length + 8);
        foreach (var b in Encoding.UTF8.GetBytes(value))
        {
            var c = (char)b;
            if (c is (>= 'a' and <= 'z') or (>= 'A' and <= 'Z') or (>= '0' and <= '9') or '-' or '.' or '_' or '~')
            {
                sb.Append(c);
            }
            else if (c == ' ')
            {
                sb.Append('+');
            }
            else
            {
                sb.Append('%').Append(b.ToString("X2", CultureInfo.InvariantCulture));
            }
        }

        return sb.ToString();
    }

    /// <summary>
    /// A signed request. The query gains <c>apikey</c>, <c>nonce</c> and <c>timestamp</c>; the signature
    /// is the lower-case hex HMAC-SHA256, keyed with the secret, of <c>METHOD NUL URL NUL BODY</c>
    /// and goes on last. A retry after a 429 is signed afresh.
    /// </summary>
    internal async Task<JsonObject?> SendAsync(
        HttpMethod method,
        string path,
        IEnumerable<(string Key, string Value)>? query,
        string? body,
        CancellationToken ct,
        string contentType = "application/x-www-form-urlencoded")
    {
        var isSignIn = path == "/auth/token";
        for (var attempt = 0; ; attempt++)
        {
            var parts = (query ?? []).Select(q => (q.Key, q.Value)).ToList();
            parts.Add(("apikey", apiKey));
            parts.Add(("nonce", Guid.NewGuid().ToString()));
            parts.Add(("timestamp", DateTimeOffset.UtcNow.ToUnixTimeSeconds().ToString(CultureInfo.InvariantCulture)));
            var url = $"{Api}{path}?{string.Join('&', parts.Select(p => $"{Escape(p.Key)}={Escape(p.Value)}"))}";
            var signature = Convert.ToHexStringLower(HMACSHA256.HashData(
                Encoding.UTF8.GetBytes(apiSecret),
                Encoding.UTF8.GetBytes($"{method.Method}\0{url}\0{body ?? string.Empty}")));

            using var request = new HttpRequestMessage(method, $"{url}&signature={signature}");
            request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            request.Headers.UserAgent.ParseAdd(UserAgent);
            if (accessToken is not null)
            {
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
            }

            if (body is not null)
            {
                // Exactly the signed bytes, with the type bare as Letterboxd's own clients send it.
                request.Content = new StringContent(body, new UTF8Encoding(false));
                request.Content.Headers.ContentType = new MediaTypeHeaderValue(contentType);
            }

            HttpStatusCode status;
            string text;
            TimeSpan? retryAfter;
            try
            {
                using var response = await Http.SendAsync(request, ct).ConfigureAwait(false);
                status = response.StatusCode;
                retryAfter = response.Headers.RetryAfter?.Delta
                    ?? (response.Headers.RetryAfter?.Date is { } at ? at - DateTimeOffset.UtcNow : null);
                text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
            {
                throw new LetterboxdException(LetterboxdFailure.Unreachable, "Couldn't reach Letterboxd", null, ex);
            }

            if (status == HttpStatusCode.TooManyRequests && attempt == 0)
            {
                var wait = retryAfter is { } delta && delta > TimeSpan.Zero ? delta : TimeSpan.FromSeconds(5);
                if (wait <= TimeSpan.FromSeconds(MaxRetryAfterSeconds))
                {
                    await Task.Delay(wait, ct).ConfigureAwait(false);
                    continue;
                }
            }

            if ((int)status is >= 200 and < 300)
            {
                return string.IsNullOrWhiteSpace(text) ? null : ParseOrNull(text) as JsonObject;
            }

            throw Refused(method, path, (int)status, text, isSignIn);
        }
    }

    private static JsonNode? ParseOrNull(string text)
    {
        try
        {
            return JsonNode.Parse(text);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>
    /// Turns a refusal into a failure. A sign-in's reply is read for its error code and then dropped:
    /// it can echo the request, so it never reaches a message, a log or a database.
    /// </summary>
    private LetterboxdException Refused(HttpMethod method, string path, int status, string text, bool isSignIn)
    {
        var what = $"{method.Method} {path} returned HTTP {status}";
        if (status == 429)
        {
            return new LetterboxdException(LetterboxdFailure.RateLimited, what, status);
        }

        if (status >= 500)
        {
            return new LetterboxdException(LetterboxdFailure.Unreachable, what, status);
        }

        if (isSignIn)
        {
            var code = (ParseOrNull(text) is JsonObject error ? error["error"] as JsonValue : null)?.ToString();
            // Observed: a wrong password is 400 invalid_grant, a dead refresh token 401 invalid_grant,
            // and a refused key or signature 401 with no OAuth error code at all.
            var failure = code switch
            {
                "invalid_grant" => LetterboxdFailure.BadCredentials,
                "invalid_client" or "unauthorized_client" => LetterboxdFailure.KeyRejected,
                null when status is 401 or 403 => LetterboxdFailure.KeyRejected,
                _ => LetterboxdFailure.Api,
            };
            return new LetterboxdException(failure, code is null ? what : $"{what} ({code})", status);
        }

        if (status is 401 or 403)
        {
            return new LetterboxdException(LetterboxdFailure.Unauthorised, what, status);
        }

        var snippet = text.Length > 200 ? text[..200] : text;
        return new LetterboxdException(LetterboxdFailure.Api, string.IsNullOrWhiteSpace(snippet) ? what : $"{what}: {snippet}", status);
    }
}
