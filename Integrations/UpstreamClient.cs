using System.Collections.Concurrent;
using System.Globalization;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>Calls Seerr and Maintainerr from the server, with a short shared cache for reads.</summary>
/// <remarks>
/// Each service is heard about once when it goes wrong: the first failure is a warning that names the
/// service, the address's path, the status and what the service said, repeats are debug, and the
/// next good answer ends it (<see cref="ServerHealth"/>), so a service that breaks again later is a warning again.
/// </remarks>
public sealed class UpstreamClient(ILogger<UpstreamClient> logger, ServerHealth health)
{
    private const string Seerr = "Seerr";
    private const string Maintainerr = "Maintainerr";

    private static readonly HttpClient Http = new(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) })
    {
        Timeout = TimeSpan.FromSeconds(15),
    };

    // The most reads kept: searches make keys without bound, and a small household never needs more than this.
    private const int MaxCached = 500;

    // Every Seerr read is keyed "seerr|{user}|{path}"; a write finds its reads by that prefix.
    private const string SeerrKeyPrefix = "seerr|";

    // How long a read that came back empty (an error, a timeout, a 404) is remembered: long enough that a
    // page of cards asking for the same thing doesn't ask again for each, short enough that a blip heals.
    private static readonly TimeSpan EmptyFor = TimeSpan.FromSeconds(10);

    private readonly AsyncTtlCache<string, JsonNode?> cache = new(MaxCached, EmptyFor);

    // Services that have answered 404 since they last answered well, so each is warned about once.
    private readonly ConcurrentDictionary<string, bool> notFound = new(StringComparer.Ordinal);

    /// <summary>Reads JSON from Seerr. <paramref name="asUser"/> sets <c>X-Api-User</c> for per-user reads.</summary>
    public Task<JsonNode?> SeerrGetAsync(string pathAndQuery, TimeSpan cacheFor, int? asUser = null)
    {
        var settings = IntegrationSettings.Current;
        if (!settings.SeerrEnabled)
        {
            return Task.FromResult<JsonNode?>(null);
        }

        var key = $"{SeerrKeyPrefix}{asUser}|{pathAndQuery}";
        return cache.GetAsync(key, cacheFor, () => SendAsync(Seerr, new Uri(settings.SeerrUrl!, pathAndQuery), settings, asUser));
    }

    /// <summary>
    /// Sends a write to Seerr as <paramref name="asUser"/>; never cached. It then drops the cached reads the
    /// write can have changed, and keeps the rest (settings, profiles, other titles' records). A Seerr that
    /// doesn't answer, or answers with something that isn't JSON, gives a 502 and a message, never an exception.
    /// </summary>
    public async Task<(int Status, JsonNode? Body)> SeerrPostAsync(string path, JsonNode body, int asUser)
    {
        var settings = IntegrationSettings.Current;
        if (!settings.SeerrEnabled)
        {
            return (StatusCodes.Status502BadGateway, Message("Seerr isn't set up."));
        }

        try
        {
            using var request = new HttpRequestMessage(HttpMethod.Post, new Uri(settings.SeerrUrl!, path))
            {
                Content = JsonContent.Create(body),
            };
            request.Headers.Add("X-Api-Key", settings.SeerrApiKey);
            request.Headers.Add("X-Api-User", asUser.ToString(CultureInfo.InvariantCulture));
            using var response = await Http.SendAsync(request).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            ForgetAfterWrite(path, body);
            var status = (int)response.StatusCode;
            if (string.IsNullOrWhiteSpace(text))
            {
                return (status, null);
            }

            try
            {
                return (status, JsonNode.Parse(text));
            }
            catch (JsonException ex)
            {
                // An HTML error page from a proxy in front of Seerr, say. A refusal still carries its status;
                // a success that can't be read is not one Hera can vouch for.
                health.Fault(Seerr, $"read Seerr's answer to a request (HTTP {status}, not JSON)", ex);
                return status is >= 200 and < 300
                    ? (StatusCodes.Status502BadGateway, Message("Seerr answered in a form Hera TV couldn't read. Check in Seerr whether the request went through."))
                    : (status, null);
            }
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            health.Fault(Seerr, "send a request to Seerr", ex);
            return (StatusCodes.Status502BadGateway, Message("Seerr didn't answer. Try again in a moment."));
        }
    }

    private static JsonObject Message(string text) => new() { ["message"] = text };

    /// <summary>
    /// A request changes the asker's request list and the status Seerr shows for that title, and the title
    /// turns up inside every list of cards (discover, search, similar, collections, credits), each carrying
    /// its own status. What cannot change is kept: the settings and server profiles, a person's biography,
    /// an account's details, another title's own record, and everything that came from Maintainerr, Sonarr,
    /// Radarr or SABnzbd (their reads live seconds, and Seerr hands a request on to them later anyway).
    /// A write that isn't a request for a known title drops every Seerr read, as before.
    /// </summary>
    private void ForgetAfterWrite(string path, JsonNode body)
    {
        var type = body.At("mediaType").Str();
        var id = body.At("mediaId").Int() ?? 0;
        var known = path == "api/v1/request" && type is not null && body.At("mediaId").Int() is not null;
        cache.Remove(key =>
        {
            if (!key.StartsWith(SeerrKeyPrefix, StringComparison.Ordinal))
            {
                return false;
            }

            // The key is "seerr|{user}|{path}": the path starts after the second bar.
            var start = key.IndexOf('|', SeerrKeyPrefix.Length) + 1;
            return !known || !SurvivesRequest(key.AsSpan(start), type, id);
        });
    }

    private static bool SurvivesRequest(ReadOnlySpan<char> path, string? type, int id)
    {
        if (path.StartsWith("api/v1/settings/", StringComparison.Ordinal)
            || path.StartsWith("api/v1/service/", StringComparison.Ordinal)
            || path.StartsWith("api/v1/watchproviders", StringComparison.Ordinal)
            || path.StartsWith("api/v1/network/", StringComparison.Ordinal))
        {
            return true;
        }

        if (path.StartsWith("api/v1/person/", StringComparison.Ordinal))
        {
            // The biography stays; the credits carry a status for every title.
            return !path.Contains("/combined_credits", StringComparison.Ordinal);
        }

        const string account = "api/v1/user/";
        if (path.StartsWith(account, StringComparison.Ordinal))
        {
            // An account's own record stays; its request list ("/requests") does not.
            return path[account.Length..].IndexOfAny('/', '?') < 0;
        }

        foreach (var kind in new[] { "movie", "tv" })
        {
            var prefix = $"api/v1/{kind}/";
            if (!path.StartsWith(prefix, StringComparison.Ordinal))
            {
                continue;
            }

            // A title's own record (not its similar or recommended lists, which hold other titles' cards)
            // only changes when that title is the one requested.
            var rest = path[prefix.Length..];
            var query = rest.IndexOf('?');
            var title = query < 0 ? rest : rest[..query];
            return title.Length > 0
                && !title.ContainsAnyExceptInRange('0', '9')
                && (kind != type || !int.TryParse(title, NumberStyles.None, CultureInfo.InvariantCulture, out var tmdb) || tmdb != id);
        }

        return false;
    }

    /// <summary>Reads JSON from Maintainerr, which this cluster serves without auth inside the cluster.</summary>
    public Task<JsonNode?> MaintainerrGetAsync(string path, TimeSpan cacheFor)
    {
        var settings = IntegrationSettings.Current;
        if (!settings.MaintainerrEnabled)
        {
            return Task.FromResult<JsonNode?>(null);
        }

        return cache.GetAsync($"maintainerr|{path}", cacheFor, () => SendAsync(Maintainerr, new Uri(settings.MaintainerrUrl!, path), settings, null));
    }

    private static readonly TimeSpan ArrTimeout = TimeSpan.FromSeconds(6);
    private static readonly TimeSpan ArrBackoff = TimeSpan.FromSeconds(15);
    private readonly ConcurrentDictionary<ArrService, DateTime> arrDownUntil = new();

    /// <summary>
    /// Reads JSON from Sonarr, Radarr (<c>api/v3/...</c>) or SABnzbd (<c>api?mode=...</c>). Fails
    /// soft: a missing setting, an error or a service that stopped answering gives null, and a
    /// service that failed is left alone for a few seconds instead of stalling every page on it.
    /// </summary>
    public Task<JsonNode?> ArrGetAsync(ArrService service, string pathAndQuery, TimeSpan cacheFor)
    {
        var (url, key) = IntegrationSettings.Current.Endpoint(service);
        if (url is null || string.IsNullOrEmpty(key) || (arrDownUntil.TryGetValue(service, out var until) && until > DateTime.UtcNow))
        {
            return Task.FromResult<JsonNode?>(null);
        }

        return cache.GetAsync($"{service}|{pathAndQuery}", cacheFor, () => SendArrAsync(service, url, key, pathAndQuery));
    }

    private static string NameOf(ArrService service) => IntegrationSettings.Arr.First(d => d.Service == service).Name;

    private async Task<JsonNode?> SendArrAsync(ArrService service, Uri baseUri, string key, string pathAndQuery)
    {
        var name = NameOf(service);
        var path = pathAndQuery.Split('?')[0];

        // SABnzbd takes its key and the JSON switch in the query; Sonarr and Radarr in a header.
        var target = service == ArrService.Sabnzbd
            ? $"{pathAndQuery}&output=json&apikey={Uri.EscapeDataString(key)}"
            : pathAndQuery;
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(baseUri, target));
        if (service != ArrService.Sabnzbd)
        {
            request.Headers.Add("X-Api-Key", key);
        }

        using var timeout = new CancellationTokenSource(ArrTimeout);
        try
        {
            using var response = await Http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            arrDownUntil.TryRemove(service, out _);
            if (!response.IsSuccessStatusCode)
            {
                await RefusedAsync(name, path, response, timeout.Token).ConfigureAwait(false);
                return null;
            }

            var text = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
            var body = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);

            // SABnzbd answers a wrong key or a bad mode with HTTP 200 and an error object.
            if (service == ArrService.Sabnzbd && body.At("error") is { } error)
            {
                health.Fault(name, $"use {name}'s API (it answered \"{Clip(error.Str() ?? error.ToJsonString())}\"; is the API key right?)");
                return null;
            }

            notFound.TryRemove(name, out _);
            health.Recovered(name);
            return body;
        }
        catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException or JsonException)
        {
            arrDownUntil[service] = DateTime.UtcNow + ArrBackoff;
            health.Fault(name, $"read {path} from {name}", ex);
            return null;
        }
    }

    private async Task<JsonNode?> SendAsync(string service, Uri uri, IntegrationSettings settings, int? asUser)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, uri);
        if (settings.SeerrUrl is not null && uri.Host == settings.SeerrUrl.Host)
        {
            request.Headers.Add("X-Api-Key", settings.SeerrApiKey);
            if (asUser is int user)
            {
                request.Headers.Add("X-Api-User", user.ToString(CultureInfo.InvariantCulture));
            }
        }

        try
        {
            using var response = await Http.SendAsync(request).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                await RefusedAsync(service, uri.AbsolutePath, response, CancellationToken.None).ConfigureAwait(false);
                return null;
            }

            var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
            var body = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
            notFound.TryRemove(service, out _);
            health.Recovered(service);
            return body;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException)
        {
            health.Fault(service, $"read {uri.AbsolutePath} from {service}", ex);
            return null;
        }
    }

    /// <summary>
    /// Notes a refusal with the status and what the service said. A 404 is how a missing title answers, so it
    /// is warned about once per service (a retired or wrong API looks the same, and nothing else would say so)
    /// and doesn't count as the service failing; any other status does.
    /// </summary>
    private async Task RefusedAsync(string service, string path, HttpResponseMessage response, CancellationToken ct)
    {
        var status = (int)response.StatusCode;
        var said = await SaidAsync(response, ct).ConfigureAwait(false);
        var detail = said is null ? string.Empty : $": {said}";
        if (status != 404)
        {
            health.Fault(service, $"read {path} from {service} (HTTP {status.ToString(CultureInfo.InvariantCulture)}{detail})");
            return;
        }

        if (notFound.TryAdd(service, true))
        {
            logger.LogWarning(
                "Hera TV: {Service} answered 404 for {Path}{Detail}. A title it doesn't know does this; if it is every call, check the address and that the service is a version Hera TV supports (Sonarr and Radarr need v3 or later). Further 404s are logged at debug level",
                service,
                path,
                detail);
        }
        else
        {
            logger.LogDebug("Hera TV: {Service} answered 404 for {Path}", service, path);
        }
    }

    /// <summary>What a failing service said in its own words (<c>message</c> or <c>error</c> of a JSON body), or null.</summary>
    private static async Task<string?> SaidAsync(HttpResponseMessage response, CancellationToken ct)
    {
        try
        {
            var text = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(text) || text.Length > 8192)
            {
                return null;
            }

            var body = JsonNode.Parse(text);
            return (body.At("message").Str() ?? body.At("error").Str()) is { } said ? Clip(said) : null;
        }
        catch (Exception ex) when (ex is JsonException or HttpRequestException or OperationCanceledException or IOException)
        {
            return null;
        }
    }

    private static string Clip(string text)
    {
        var line = text.Trim().ReplaceLineEndings(" ");
        return line.Length > 160 ? line[..160] + "..." : line;
    }

    /// <summary>What a connection test saw: the HTTP status and JSON body, or why nothing answered.</summary>
    public sealed record Probe(int? Status, JsonNode? Body, string? Failure);

    /// <summary>
    /// Maps each record of a list a service sent, leaving out any that can't be mapped, so one record of an
    /// unexpected shape costs itself and not the whole row or page. The first such record is a warning that
    /// names the service and says what was wrong; later ones are debug until a list maps cleanly again.
    /// </summary>
    public List<T> MapEach<T>(string service, IEnumerable<JsonNode> records, Func<JsonNode, T> map)
    {
        var mapped = new List<T>();
        var failed = 0;
        Exception? first = null;
        foreach (var record in records)
        {
            try
            {
                mapped.Add(map(record));
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                failed++;
                first ??= ex;
            }
        }

        var feature = $"{service} records";
        if (first is null)
        {
            health.Recovered(feature);
        }
        else
        {
            health.Fault(feature, string.Create(CultureInfo.InvariantCulture, $"read {failed} of {failed + mapped.Count} records from {service}: they aren't in the shape Hera TV expects, so they are left out"), first);
        }

        return mapped;
    }

    /// <summary>Drops cached reads, so a changed URL or key never serves the old server's answers.</summary>
    public void ClearCache()
    {
        cache.Clear();
        arrDownUntil.Clear();
    }

    /// <summary>One uncached GET against a base URL that may not be saved yet: the settings page's Test connection.</summary>
    public async Task<Probe> ProbeAsync(Uri baseUri, string path, string? apiKey)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, new Uri(baseUri, path));
        if (!string.IsNullOrEmpty(apiKey))
        {
            request.Headers.Add("X-Api-Key", apiKey);
        }

        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
        try
        {
            using var response = await Http.SendAsync(request, timeout.Token).ConfigureAwait(false);
            var text = await response.Content.ReadAsStringAsync(timeout.Token).ConfigureAwait(false);
            JsonNode? body = null;
            try
            {
                body = string.IsNullOrWhiteSpace(text) ? null : JsonNode.Parse(text);
            }
            catch (JsonException)
            {
                // An HTML page or plain text: the status alone says what it was.
            }

            return new Probe((int)response.StatusCode, body, null);
        }
        catch (OperationCanceledException)
        {
            return new Probe(null, null, "No answer within 8 seconds.");
        }
        catch (HttpRequestException ex)
        {
            return new Probe(null, null, ex.InnerException?.Message ?? ex.Message);
        }
    }
}
