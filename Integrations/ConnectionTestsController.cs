using System.Text.Json.Nodes;
using Jellyfin.Plugin.HeraTv.Letterboxd;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// The dashboard's "Test connection" buttons and the lookups its pickers need from Seerr. Admin only.
/// Each takes the form's values (or, for a field the environment owns or the form left alone, the
/// saved ones) so a change can be tried before it is saved. Keys are only ever sent to the address being tested.
/// </summary>
[ApiController]
[Authorize(Policy = HeraUser.Elevated)]
[Route("HeraTV/settings")]
public class ConnectionTestsController(UpstreamClient upstream) : ControllerBase
{
    /// <summary>Tries Seerr with the form's values (or the saved ones): reachable, is Seerr, accepts the key.</summary>
    [HttpPost("test/seerr")]
    public async Task<IActionResult> TestSeerr([FromBody] ConnectionBody? body)
        => Ok(await CheckSeerr(body).ConfigureAwait(false));

    [HttpPost("test/maintainerr")]
    public async Task<IActionResult> TestMaintainerr([FromBody] ConnectionBody? body)
    {
        var field = IntegrationSettings.Inspect(IntegrationSettings.MaintainerrUrlVariable, Plugin.Instance?.Configuration.MaintainerrUrl);
        var raw = field.Locked ? field.Value : body?.Url ?? field.Value;
        var url = IntegrationSettings.ParseUri(raw);
        if (url is null)
        {
            return Ok(new { ok = false, message = "Enter the Maintainerr URL first." });
        }

        var host = url.GetLeftPart(UriPartial.Authority);
        var status = await upstream.ProbeAsync(url, "api/app/status", null).ConfigureAwait(false);
        if (status.Failure is not null)
        {
            return Ok(new { ok = false, message = $"Could not reach {host}: {status.Failure}" });
        }

        if (status.Status == 200 && status.Body.At("version") is { } version)
        {
            return Ok(new { ok = true, version = version.ToString(), message = $"Connected to Maintainerr {version}." });
        }

        // Older builds have no status route; their collections list says the same thing.
        var collections = await upstream.ProbeAsync(url, "api/collections", null).ConfigureAwait(false);
        if (collections.Status == 200 && collections.Body is JsonArray list)
        {
            return Ok(new { ok = true, message = $"Connected to Maintainerr ({list.Count} collections)." });
        }

        return Ok(new { ok = false, message = $"{host} answered HTTP {status.Status} but does not look like Maintainerr. Check the URL." });
    }

    [HttpPost("test/sonarr")]
    public async Task<IActionResult> TestSonarr([FromBody] ConnectionBody? body)
        => Ok(await CheckArr(ArrService.Sonarr, body).ConfigureAwait(false));

    [HttpPost("test/radarr")]
    public async Task<IActionResult> TestRadarr([FromBody] ConnectionBody? body)
        => Ok(await CheckArr(ArrService.Radarr, body).ConfigureAwait(false));

    [HttpPost("test/sabnzbd")]
    public async Task<IActionResult> TestSabnzbd([FromBody] ConnectionBody? body)
        => Ok(await CheckArr(ArrService.Sabnzbd, body).ConfigureAwait(false));

    /// <summary>Tries Letterboxd with the form's key and secret (or the saved ones): signs a film lookup and reads the answer.</summary>
    [HttpPost("test/letterboxd")]
    public async Task<IActionResult> TestLetterboxd([FromBody] LetterboxdTestBody? body, CancellationToken ct)
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var keyField = IntegrationSettings.Inspect(IntegrationSettings.LetterboxdApiKeyVariable, config.LetterboxdApiKey);
        var secretField = IntegrationSettings.Inspect(IntegrationSettings.LetterboxdApiSecretVariable, config.LetterboxdApiSecret);
        var key = keyField.Locked || string.IsNullOrWhiteSpace(body?.ApiKey) ? keyField.Value : body.ApiKey.Trim();
        var secret = secretField.Locked || string.IsNullOrWhiteSpace(body?.ApiSecret) ? secretField.Value : body.ApiSecret.Trim();
        if (string.IsNullOrEmpty(key) || string.IsNullOrEmpty(secret))
        {
            return Ok(new { ok = false, message = "Enter the Letterboxd API key and secret first." });
        }

        try
        {
            // A film lookup needs no member, so this proves the key and the signature without anyone's account.
            var film = await new LetterboxdClient(key, secret).FindFilmAsync("155", null, "The Dark Knight", 2008, ct).ConfigureAwait(false);
            return Ok(film is null
                ? new { ok = false, message = "Letterboxd answered, but didn't find a film it should know. Try again in a moment." }
                : new { ok = true, message = "Connected to Letterboxd. The key and secret work." });
        }
        catch (LetterboxdException ex)
        {
            return Ok(new
            {
                ok = false,
                message = ex.Failure switch
                {
                    LetterboxdFailure.Unauthorised or LetterboxdFailure.KeyRejected or LetterboxdFailure.BadCredentials => "Letterboxd refused the API key or secret.",
                    LetterboxdFailure.Unreachable or LetterboxdFailure.RateLimited => "Couldn't reach Letterboxd. Try again in a moment.",
                    _ => $"Letterboxd answered unexpectedly ({ex.Status?.ToString(System.Globalization.CultureInfo.InvariantCulture) ?? "no status"}).",
                },
            });
        }
    }

    /// <summary>The Seerr accounts a Jellyfin user can be linked to.</summary>
    [HttpPost("seerr/users")]
    public async Task<IActionResult> SeerrUsers([FromBody] ConnectionBody? body)
    {
        var (url, key, problem) = ResolveSeerr(body);
        if (url is null || problem is not null)
        {
            return Ok(new { ok = false, message = problem, users = Array.Empty<object>() });
        }

        var reply = await upstream.ProbeAsync(url, "api/v1/user?take=100&sort=displayname", key).ConfigureAwait(false);
        if (reply.Status != 200 || reply.Body.At("results") is not JsonArray results)
        {
            return Ok(new
            {
                ok = false,
                message = reply.Failure ?? (reply.Status is 401 or 403 ? "Seerr rejected the API key." : $"Seerr answered HTTP {reply.Status}."),
                users = Array.Empty<object>(),
            });
        }

        var users = upstream.MapEach(
                "Seerr",
                results.Items().Where(r => r.At("id") is not null),
                r => new
                {
                    id = r.At("id").Int() ?? 0,
                    displayName = r.At("displayName").Str() ?? r.At("username").Str() ?? $"User {r.At("id")}",
                    email = r.At("email").Str(),
                    username = r.At("jellyfinUsername").Str() ?? r.At("plexUsername").Str() ?? r.At("username").Str(),
                })
            .OrderBy(u => u.displayName, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return Ok(new { ok = true, message = (string?)null, users });
    }

    /// <summary>Seerr's Radarr and Sonarr servers and their profiles, for the Requests settings' pickers.</summary>
    [HttpGet("seerr/profiles")]
    public async Task<IActionResult> GetSeerrProfiles()
    {
        if (!IntegrationSettings.Current.SeerrEnabled)
        {
            return Ok(new { movie = Array.Empty<object>(), tv = Array.Empty<object>() });
        }

        async Task<object[]> Servers(string service)
        {
            var servers = await upstream.SeerrGetAsync($"api/v1/settings/{service}", TimeSpan.FromMinutes(1)).ConfigureAwait(false);
            var list = new List<object>();
            foreach (var server in servers.Items())
            {
                if (server.At("id").Int() is not int id)
                {
                    continue;
                }

                var detail = await upstream.SeerrGetAsync($"api/v1/service/{service}/{id}", TimeSpan.FromMinutes(1)).ConfigureAwait(false);
                list.Add(new
                {
                    id,
                    name = server.At("name").Str(),
                    is4k = server.At("is4k").Bool() == true,
                    isDefault = server.At("isDefault").Bool() == true,
                    activeProfileId = server.At("activeProfileId").Int(),
                    profiles = detail.At("profiles").Items()
                        .Where(p => p.At("id").Int() is not null)
                        .Select(p => new { id = p.At("id").Int() ?? 0, name = p.At("name").Str(), guess = DiscoverController.Resolution(p.At("name").Str()) })
                        .ToArray(),
                });
            }

            return [.. list];
        }

        return Ok(new { movie = await Servers("radarr").ConfigureAwait(false), tv = await Servers("sonarr").ConfigureAwait(false) });
    }

    /// <summary>
    /// Tries one service of the download stack with the form's values (or the saved ones). The key
    /// is only ever sent to the address being tested and never echoed back.
    /// </summary>
    private async Task<object> CheckArr(ArrService service, ConnectionBody? body)
    {
        var def = IntegrationSettings.Arr.First(d => d.Service == service);
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var urlField = IntegrationSettings.Inspect(def.UrlVariable, def.SavedUrl(config));
        var keyField = IntegrationSettings.Inspect(def.KeyVariable, def.SavedKey(config));
        var url = IntegrationSettings.ParseUri(urlField.Locked ? urlField.Value : body?.Url ?? urlField.Value);
        var key = keyField.Locked || string.IsNullOrWhiteSpace(body?.ApiKey) ? keyField.Value : body.ApiKey.Trim();
        if (url is null)
        {
            return new { ok = false, message = $"Enter the {def.Name} URL first." };
        }

        if (string.IsNullOrEmpty(key))
        {
            return new { ok = false, message = $"Enter the {def.Name} API key first." };
        }

        var host = url.GetLeftPart(UriPartial.Authority);
        if (service == ArrService.Sabnzbd)
        {
            // Its version call is public; a queue read is what needs the key.
            var version = await upstream.ProbeAsync(url, "api?mode=version&output=json", null).ConfigureAwait(false);
            if (version.Failure is not null)
            {
                return new { ok = false, message = $"Could not reach {host}: {version.Failure}" };
            }

            if (version.Status != 200 || version.Body.At("version") is not { } sabVersion)
            {
                return new { ok = false, message = $"{host} answered HTTP {version.Status} but does not look like SABnzbd. Check the URL." };
            }

            var queue = await upstream.ProbeAsync(url, $"api?mode=queue&limit=1&output=json&apikey={Uri.EscapeDataString(key)}", null).ConfigureAwait(false);
            return queue.Status == 200 && queue.Body.At("queue") is not null
                ? new { ok = true, version = sabVersion.ToString(), message = $"Connected to SABnzbd {sabVersion}. The API key works." }
                : new { ok = false, version = sabVersion.ToString(), message = $"Reached SABnzbd {sabVersion}, but it rejected the API key." };
        }

        var status = await upstream.ProbeAsync(url, "api/v3/system/status", key).ConfigureAwait(false);
        if (status.Failure is not null)
        {
            return new { ok = false, message = $"Could not reach {host}: {status.Failure}" };
        }

        if (status.Status is 401 or 403)
        {
            return new { ok = false, message = $"Reached {host}, but {def.Name} rejected the API key." };
        }

        if (status.Status == 200 && status.Body.At("version") is { } arrVersion)
        {
            var app = status.Body.At("appName").Str();
            return app is not null && !app.Equals(def.Name, StringComparison.OrdinalIgnoreCase)
                ? new { ok = false, version = arrVersion.ToString(), message = $"{host} is {app}, not {def.Name}. Check the URL." }
                : new { ok = true, version = arrVersion.ToString(), message = $"Connected to {def.Name} {arrVersion}. The API key works." };
        }

        return new { ok = false, message = $"{host} answered HTTP {status.Status} but does not look like {def.Name}. Check the URL." };
    }

    private static (Uri? Url, string? Key, string? Problem) ResolveSeerr(ConnectionBody? body)
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var urlField = IntegrationSettings.Inspect(IntegrationSettings.SeerrUrlVariable, config.SeerrUrl);
        var keyField = IntegrationSettings.Inspect(IntegrationSettings.SeerrApiKeyVariable, config.SeerrApiKey);
        var url = IntegrationSettings.ParseUri(urlField.Locked ? urlField.Value : body?.Url ?? urlField.Value);
        var key = keyField.Locked || string.IsNullOrWhiteSpace(body?.ApiKey) ? keyField.Value : body.ApiKey.Trim();
        if (url is null)
        {
            return (null, key, "Enter the Seerr URL first.");
        }

        return string.IsNullOrEmpty(key) ? (url, null, "Enter the Seerr API key first.") : (url, key, null);
    }

    private async Task<object> CheckSeerr(ConnectionBody? body)
    {
        var (url, key, problem) = ResolveSeerr(body);
        if (url is null)
        {
            return new { ok = false, message = problem };
        }

        var host = url.GetLeftPart(UriPartial.Authority);
        var status = await upstream.ProbeAsync(url, "api/v1/status", null).ConfigureAwait(false);
        if (status.Failure is not null)
        {
            return new { ok = false, message = $"Could not reach {host}: {status.Failure}" };
        }

        if (status.Status != 200 || status.Body.At("version") is not { } version)
        {
            return new { ok = false, message = $"{host} answered HTTP {status.Status} but does not look like Seerr. Check the URL." };
        }

        if (problem is not null)
        {
            return new { ok = false, version = version.ToString(), message = $"Reached Seerr {version}. {problem}" };
        }

        // /status is public; the settings route needs a valid key, which is the thing worth testing.
        var auth = await upstream.ProbeAsync(url, "api/v1/settings/main", key).ConfigureAwait(false);
        return auth.Status switch
        {
            200 => new { ok = true, version = version.ToString(), message = $"Connected to Seerr {version}. The API key works." },
            401 or 403 => new { ok = false, version = version.ToString(), message = $"Reached Seerr {version}, but it rejected the API key." },
            _ => new { ok = false, version = version.ToString(), message = $"Reached Seerr {version}, but the key check answered {(auth.Failure ?? $"HTTP {auth.Status}")}." },
        };
    }

    public sealed class ConnectionBody
    {
        public string? Url { get; set; }

        public string? ApiKey { get; set; }
    }

    public sealed class LetterboxdTestBody
    {
        public string? ApiKey { get; set; }

        public string? ApiSecret { get; set; }
    }
}
