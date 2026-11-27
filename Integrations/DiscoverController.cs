using System.Globalization;
using System.Text.Json.Nodes;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// The web client's window onto Seerr (discover, search, requests) and Maintainerr (what is
/// leaving). Every call runs as the signed-in Jellyfin user: library matches respect their access,
/// and requests are made as their linked Seerr user, never as the API key's owner.
/// </summary>
[ApiController]
[Authorize]
[Route("HeraTV")]
public class DiscoverController(UpstreamClient upstream, LibraryLookup library, IUserManager userManager) : ControllerBase
{
    private static readonly Dictionary<string, string> Lists = new(StringComparer.OrdinalIgnoreCase)
    {
        ["trending"] = "api/v1/discover/trending",
        ["movies"] = "api/v1/discover/movies",
        ["tv"] = "api/v1/discover/tv",
        ["upcoming-movies"] = "api/v1/discover/movies/upcoming",
        ["upcoming-tv"] = "api/v1/discover/tv/upcoming",
    };

    [HttpGet("integrations")]
    public IActionResult GetIntegrations()
    {
        var settings = IntegrationSettings.Current;
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var user = CurrentUser();
        return Ok(new
        {
            seerr = settings.SeerrEnabled,
            seerrLinked = settings.SeerrEnabled && user is not null && settings.SeerrUserFor(user.Username) is not null,
            seerrUrl = settings.SeerrPublicUrl,
            maintainerr = settings.MaintainerrEnabled,
            sonarr = settings.Enabled(ArrService.Sonarr),
            radarr = settings.Enabled(ArrService.Radarr),
            sabnzbd = settings.Enabled(ArrService.Sabnzbd),
            activity = settings.ActivityEnabled,
            admin = User.IsInRole("Administrator"),
            features = IntegrationSettings.Features(config),
        });
    }

    [HttpGet("discover/lists/{list}")]
    public async Task<IActionResult> GetList([FromRoute] string list, [FromQuery] int page = 1)
    {
        if (!Lists.TryGetValue(list, out var path))
        {
            return NotFound();
        }

        return await Page($"{path}?page={Math.Clamp(page, 1, 20)}&language=en").ConfigureAwait(false);
    }

    [HttpGet("discover/search")]
    public async Task<IActionResult> Search([FromQuery] string query, [FromQuery] int page = 1)
    {
        if (string.IsNullOrWhiteSpace(query))
        {
            return Ok(new { page = 1, totalPages = 0, results = Array.Empty<object>() });
        }

        // Seerr's search wants RFC 3986 escaping, including the characters EscapeDataString leaves.
        var escaped = Uri.EscapeDataString(query.Trim()).Replace("!", "%21", StringComparison.Ordinal)
            .Replace("'", "%27", StringComparison.Ordinal).Replace("(", "%28", StringComparison.Ordinal)
            .Replace(")", "%29", StringComparison.Ordinal).Replace("*", "%2A", StringComparison.Ordinal);
        return await Page($"api/v1/search?query={escaped}&page={Math.Clamp(page, 1, 20)}&language=en").ConfigureAwait(false);
    }

    [HttpGet("discover/titles/{mediaType}/{tmdbId:int}")]
    public async Task<IActionResult> GetTitle([FromRoute] string mediaType, [FromRoute] int tmdbId)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        var type = mediaType == "tv" ? "tv" : "movie";
        var node = await upstream.SeerrGetAsync($"api/v1/{type}/{tmdbId}?language=en", TimeSpan.FromMinutes(5)).ConfigureAwait(false);
        if (node is null)
        {
            return NotFound();
        }

        // The record is the cache's own, shared with every other reader: its media type is passed, not written into it.
        var item = SeerrMapper.Item(node, type, user, library);
        var seasons = node["seasons"]?.AsArray()
            .Where(s => (s?["seasonNumber"]?.GetValue<int>() ?? 0) > 0)
            .Select(s => new
            {
                seasonNumber = s!["seasonNumber"]!.GetValue<int>(),
                name = (string?)s["name"],
                episodeCount = s["episodeCount"]?.GetValue<int>() ?? 0,
                status = SeerrMapper.SeasonStatus(node, s["seasonNumber"]!.GetValue<int>()),
            })
            .ToArray();
        var trailer = node["relatedVideos"]?.AsArray()
            .FirstOrDefault(v => (string?)v?["type"] == "Trailer" && (string?)v?["site"] == "YouTube");
        var cast = node["credits"]?["cast"]?.AsArray().Take(10).Select(c => new
        {
            name = (string?)c?["name"],
            character = (string?)c?["character"],
            id = c?["id"]?.GetValue<int?>(),
            photo = SeerrMapper.Image((string?)c?["profilePath"], "w185"),
        }).ToArray();

        return Ok(new
        {
            item,
            tagline = (string?)node["tagline"],
            runtime = node["runtime"]?.GetValue<int?>() ?? node["episodeRunTime"]?.AsArray().FirstOrDefault()?.GetValue<int?>(),
            genres = node["genres"]?.AsArray().Select(g => (string?)g?["name"]).Where(g => g is not null).ToArray() ?? [],
            certification = Certification(node, type),
            seasons = seasons ?? [],
            trailer = (string?)trailer?["url"],
            cast = cast ?? [],
        });
    }

    /// <summary>Gets the qualities this person may pick for a request of this kind, default first; empty when there's no choice.</summary>
    [HttpGet("discover/qualities/{mediaType}")]
    public async Task<IActionResult> GetQualities([FromRoute] string mediaType)
    {
        var settings = IntegrationSettings.Current;
        var user = CurrentUser();
        var seerrUser = user is null ? null : settings.SeerrUserFor(user.Username);
        if (!settings.SeerrEnabled || seerrUser is null)
        {
            return Ok(new { qualities = Array.Empty<object>() });
        }

        var qualities = await QualitiesAsync(mediaType == "tv" ? "tv" : "movie", seerrUser.Value).ConfigureAwait(false);
        return Ok(new { qualities = qualities.Select(q => new { serverId = q.ServerId, profileId = q.ProfileId, label = q.Label, isDefault = q.IsDefault }) });
    }

    [HttpPost("discover/requests")]
    public async Task<IActionResult> CreateRequest([FromBody] RequestBody body)
    {
        var settings = IntegrationSettings.Current;
        var user = CurrentUser();
        var seerrUser = user is null ? null : settings.SeerrUserFor(user.Username);
        if (!settings.SeerrEnabled || seerrUser is null)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { message = "Your account is not linked to Seerr." });
        }

        var type = body.MediaType == "tv" ? "tv" : "movie";
        var payload = new JsonObject
        {
            ["mediaType"] = type,
            ["mediaId"] = body.TmdbId,
            ["is4k"] = false,
        };
        if (type == "tv")
        {
            payload["seasons"] = body.Seasons is { Length: > 0 } seasons
                ? new JsonArray(seasons.Select(s => (JsonNode)s).ToArray())
                : JsonValue.Create("all");
        }

        // A chosen quality is one of the profiles this person was offered; Seerr takes the server's
        // root folder and language profile as they are. One on a server Seerr marks 4K is a 4K request.
        if (body.ProfileId is int profileId)
        {
            var offered = await QualitiesAsync(type, seerrUser.Value).ConfigureAwait(false);
            var quality = offered.Find(q => q.ProfileId == profileId && (body.ServerId is not int serverId || q.ServerId == serverId));
            if (quality is null)
            {
                return BadRequest(new { message = "That quality isn't available for requests." });
            }

            payload["is4k"] = quality.Is4k;
            payload["serverId"] = quality.ServerId;
            payload["profileId"] = quality.ProfileId;
        }

        var (status, response) = await upstream.SeerrPostAsync("api/v1/request", payload, seerrUser.Value).ConfigureAwait(false);
        if (status is >= 200 and < 300)
        {
            return Ok(new { requestStatus = SeerrMapper.RequestStatus(response?["status"]?.GetValue<int>() ?? 1) });
        }

        return StatusCode(status >= 400 && status < 500 ? status : StatusCodes.Status502BadGateway, new
        {
            message = (string?)response?["message"] ?? "Seerr did not accept the request.",
        });
    }

    // Seerr's permission bits: naming a server and profile, and requesting from a 4K server.
    private const long AdminPermission = 2;
    private const long ManageRequestsPermission = 16;
    private const long Request4kPermission = 1024;
    private const long Request4kMoviePermission = 2048;
    private const long Request4kTvPermission = 4096;
    private const long AdvancedRequestPermission = 8192;

    /// <summary>
    /// The qualities a request may pick, in resolution order (720p, 1080p, 4K). By default they are
    /// read off the default Radarr or Sonarr server's profile names, one per resolution; the admin
    /// may name the 1080p and 4K profiles outright (Settings: Requests), a 4K one on a server of its
    /// own. Empty when there is only one, when the setting hides the capsule from this person, or
    /// when their Seerr account may not choose: Seerr ignores a profile from anyone without Advanced
    /// Requests, so offering it would be a lie.
    /// </summary>
    private async Task<List<Quality>> QualitiesAsync(string type, int seerrUser)
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        if (config.RequestQualityPicker == "off" || (config.RequestQualityPicker == "admins" && !User.IsInRole("Administrator")))
        {
            return [];
        }

        var account = await upstream.SeerrGetAsync($"api/v1/user/{seerrUser}", TimeSpan.FromMinutes(5)).ConfigureAwait(false);
        var permissions = account?["permissions"]?.GetValue<long>() ?? 0;
        if ((permissions & (AdminPermission | ManageRequestsPermission | AdvancedRequestPermission)) == 0)
        {
            return [];
        }

        var may4k = (permissions & (AdminPermission | Request4kPermission | (type == "tv" ? Request4kTvPermission : Request4kMoviePermission))) != 0;
        var service = type == "tv" ? "sonarr" : "radarr";
        var servers = (await upstream.SeerrGetAsync($"api/v1/settings/{service}", TimeSpan.FromMinutes(10)).ConfigureAwait(false))?.AsArray();
        var byLabel = new Dictionary<string, Quality>(StringComparer.Ordinal);
        var standard = servers?.FirstOrDefault(s => s?["isDefault"]?.GetValue<bool>() == true && s?["is4k"]?.GetValue<bool>() != true);
        if (standard?["id"]?.GetValue<int>() is int serverId)
        {
            var activeProfile = standard["activeProfileId"]?.GetValue<int>();
            foreach (var (id, name) in await ProfilesAsync(service, serverId).ConfigureAwait(false))
            {
                if (Resolution(name) is not { } label)
                {
                    continue;
                }

                var isDefault = id == activeProfile;
                if (!byLabel.TryGetValue(label, out var known) || (isDefault && !known.IsDefault))
                {
                    byLabel[label] = new Quality(serverId, id, label, isDefault, false);
                }
            }
        }

        // Profiles the admin named outright replace the guesses for their resolution.
        var (hd, uhd) = type == "tv" ? (config.RequestTvHdProfile, config.RequestTv4kProfile) : (config.RequestMovieHdProfile, config.RequestMovie4kProfile);
        foreach (var (setting, label) in new[] { (hd, "1080p"), (uhd, "4K") })
        {
            if (await NamedAsync(service, servers, setting, label).ConfigureAwait(false) is { } named)
            {
                byLabel[label] = named with { IsDefault = byLabel.TryGetValue(label, out var guessed) && guessed.IsDefault };
            }
        }

        var offered = byLabel.Values.Where(q => !q.Is4k || may4k).OrderBy(q => Array.IndexOf(Resolutions, q.Label)).ToList();
        if (offered.Count < 2)
        {
            return [];
        }

        // The capsule starts on the admin's choice, or else on the server's own default profile.
        if (config.RequestDefaultQuality is "1080p" or "4K" && offered.Exists(q => q.Label == config.RequestDefaultQuality))
        {
            offered = [.. offered.Select(q => q with { IsDefault = q.Label == config.RequestDefaultQuality })];
        }

        return offered;
    }

    /// <summary>The profile a setting names ("serverId:profileId"), if it is still on that server.</summary>
    private async Task<Quality?> NamedAsync(string service, JsonArray? servers, string? setting, string label)
    {
        var parts = setting?.Split(':');
        if (parts is not { Length: 2 }
            || !int.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out var serverId)
            || !int.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var profileId))
        {
            return null;
        }

        var server = servers?.FirstOrDefault(s => s?["id"]?.GetValue<int>() == serverId);
        if (server is null || !(await ProfilesAsync(service, serverId).ConfigureAwait(false)).Exists(p => p.Id == profileId))
        {
            return null;
        }

        return new Quality(serverId, profileId, label, false, server["is4k"]?.GetValue<bool>() == true);
    }

    private async Task<List<(int Id, string? Name)>> ProfilesAsync(string service, int serverId)
    {
        var detail = await upstream.SeerrGetAsync($"api/v1/service/{service}/{serverId}", TimeSpan.FromMinutes(10)).ConfigureAwait(false);
        return [.. (detail?["profiles"]?.AsArray() ?? [])
            .Where(p => p?["id"]?.GetValue<int>() is not null)
            .Select(p => (p!["id"]!.GetValue<int>(), (string?)p["name"]))];
    }

    private static readonly string[] Resolutions = ["720p", "1080p", "4K"];

    /// <summary>Reads a profile's resolution from its name ("[SQP] SQP-1 (2160p)" is 4K), or null for one that names none.</summary>
    internal static string? Resolution(string? name)
    {
        if (string.IsNullOrEmpty(name))
        {
            return null;
        }

        if (name.Contains("2160", StringComparison.Ordinal) || name.Contains("4K", StringComparison.OrdinalIgnoreCase) || name.Contains("UHD", StringComparison.OrdinalIgnoreCase))
        {
            return "4K";
        }

        return name.Contains("1080", StringComparison.Ordinal) ? "1080p" : name.Contains("720", StringComparison.Ordinal) ? "720p" : null;
    }

    private sealed record Quality(int ServerId, int ProfileId, string Label, bool IsDefault, bool Is4k);

    [HttpGet("leaving")]
    public async Task<IActionResult> GetLeaving()
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        if (Plugin.Instance?.Configuration.LeavingSoonEnabled == false)
        {
            return Ok(Array.Empty<object>());
        }

        var collections = await upstream.MaintainerrGetAsync("api/collections", TimeSpan.FromMinutes(10)).ConfigureAwait(false);
        // Settings: Leaving Soon looks this many days ahead; 0 lists everything Maintainerr has queued.
        var window = Math.Max(0, Plugin.Instance?.Configuration.LeavingSoonDays ?? 0);
        var horizon = DateTime.UtcNow.Date.AddDays(window);
        var leaving = new List<(string LeavesOn, object Entry)>();
        foreach (var collection in collections?.AsArray() ?? [])
        {
            if (collection?["isActive"]?.GetValue<bool>() != true)
            {
                continue;
            }

            var days = collection["deleteAfterDays"]?.GetValue<int?>() ?? 0;
            var type = (string?)collection["type"] == "show" ? "tv" : "movie";
            foreach (var media in collection["media"]?.AsArray() ?? [])
            {
                var tmdbId = media?["tmdbId"]?.ToString();
                var item = library.Find(user, type, tmdbId);
                if (item is null
                    || !DateTime.TryParse((string?)media!["addDate"], CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var added)
                    || (window > 0 && added.AddDays(days).Date > horizon))
                {
                    continue;
                }

                var leavesOn = added.AddDays(days).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
                leaving.Add((leavesOn, new
                {
                    jellyfinId = item.Id.ToString("N", CultureInfo.InvariantCulture),
                    name = item.Name,
                    type,
                    leavesOn,
                }));
            }
        }

        // Soonest first. Never capped: a title page finds its own "Leaving" date in this list.
        return Ok(leaving.OrderBy(l => l.LeavesOn, StringComparer.Ordinal).Select(l => l.Entry).ToArray());
    }

    private async Task<IActionResult> Page(string pathAndQuery)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        if (!IntegrationSettings.Current.SeerrEnabled)
        {
            return NotFound();
        }

        var node = await upstream.SeerrGetAsync(pathAndQuery, TimeSpan.FromMinutes(10)).ConfigureAwait(false);
        var results = node?["results"]?.AsArray()
            .Where(r => (string?)r?["mediaType"] is "movie" or "tv")
            .Select(r => SeerrMapper.Item(r!, user, library))
            .ToArray() ?? [];
        return Ok(new
        {
            page = node?["page"]?.GetValue<int>() ?? 1,
            totalPages = node?["totalPages"]?.GetValue<int>() ?? 0,
            results,
        });
    }

    /// <summary>The title's certificate in the server's streaming region (Settings: Streaming region; GB by default).</summary>
    private static string? Certification(JsonNode title, string type)
    {
        var region = Plugin.Instance?.Configuration.WatchRegion is { Length: 2 } set ? set.ToUpperInvariant() : "GB";
        if (type == "movie")
        {
            var release = title["releases"]?["results"]?.AsArray().FirstOrDefault(r => (string?)r?["iso_3166_1"] == region);
            return release?["release_dates"]?.AsArray().Select(d => (string?)d?["certification"]).FirstOrDefault(c => !string.IsNullOrEmpty(c));
        }

        var rating = title["contentRatings"]?["results"]?.AsArray().FirstOrDefault(r => (string?)r?["iso_3166_1"] == region);
        return (string?)rating?["rating"];
    }

    private User? CurrentUser()
    {
        var claim = User.FindFirst("Jellyfin-UserId")?.Value;
        return Guid.TryParse(claim, out var id) ? userManager.GetUserById(id) : null;
    }

    public sealed class RequestBody
    {
        public string MediaType { get; set; } = "movie";

        public int TmdbId { get; set; }

        public int[]? Seasons { get; set; }

        /// <summary>Gets or sets the Radarr or Sonarr quality profile picked, one of those <c>discover/qualities</c> offered; null for the server's default.</summary>
        public int? ProfileId { get; set; }

        /// <summary>Gets or sets the server the picked profile is on (a 4K profile may be on a server of its own); null for the default server.</summary>
        public int? ServerId { get; set; }
    }
}
