using System.Text.Json;
using System.Text.Json.Serialization;
using Jellyfin.Plugin.HeraTv.Collections;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// What the dashboard's Hera TV page reads and writes. Admin only. HERATV_* environment variables
/// win over saved values, so each field reports where its effective value comes from and a save
/// leaves the fields the environment owns alone. The Seerr API key is write-only: it is accepted
/// here, never sent back. Connection tests are in <see cref="ConnectionTestsController"/> and the
/// one-off admin actions in <see cref="AdminToolsController"/>.
/// </summary>
[ApiController]
[Authorize(Policy = HeraUser.Elevated)]
[Route("HeraTV/settings")]
public class SettingsController(
    UpstreamClient upstream,
    ICollectionBuilder collectionBuilder,
    ICollectionsView collectionsView) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(Describe());

    [HttpPost]
    public IActionResult Save([FromBody] SettingsBody body)
    {
        var plugin = Plugin.Instance;
        if (plugin is null)
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { message = "The plugin is not loaded." });
        }

        var config = plugin.Configuration;
        var seerrUrl = Writable(IntegrationSettings.SeerrUrlVariable, body.SeerrUrl);
        var seerrPublicUrl = Writable(IntegrationSettings.SeerrPublicUrlVariable, body.SeerrPublicUrl);
        var maintainerrUrl = Writable(IntegrationSettings.MaintainerrUrlVariable, body.MaintainerrUrl);
        foreach (var (label, value) in new[] { ("Seerr URL", seerrUrl), ("Seerr public URL", seerrPublicUrl), ("Maintainerr URL", maintainerrUrl) })
        {
            if (!string.IsNullOrWhiteSpace(value) && !IsWebAddress(value))
            {
                return BadRequest(new { message = $"{label} must be a full web address, such as http://seerr:5055." });
            }
        }

        foreach (var def in IntegrationSettings.Arr)
        {
            var arrUrl = body.Services is not null && body.Services.TryGetValue(def.Id, out var sent) ? Writable(def.UrlVariable, sent.Url) : null;
            if (!string.IsNullOrWhiteSpace(arrUrl) && !IsWebAddress(arrUrl))
            {
                return BadRequest(new { message = $"{def.Name} URL must be a full web address, such as http://{def.Id}:8080." });
            }

            var publicUrl = body.Services is not null && body.Services.TryGetValue(def.Id, out var sentPublic) ? Writable(def.PublicUrlVariable, sentPublic.PublicUrl) : null;
            if (!string.IsNullOrWhiteSpace(publicUrl) && !IsWebAddress(publicUrl))
            {
                return BadRequest(new { message = $"{def.Name} public address must be a full web address, such as https://{def.Id}.example.com." });
            }
        }

        var region = body.WatchRegion?.Trim();
        if (!string.IsNullOrEmpty(region) && (region.Length != 2 || !region.All(char.IsAsciiLetter)))
        {
            return BadRequest(new { message = "The streaming region must be a two-letter country code, such as GB." });
        }

        if (seerrUrl is not null)
        {
            config.SeerrUrl = Clean(seerrUrl);
        }

        if (seerrPublicUrl is not null)
        {
            config.SeerrPublicUrl = Clean(seerrPublicUrl);
        }

        if (maintainerrUrl is not null)
        {
            config.MaintainerrUrl = Clean(maintainerrUrl);
        }

        foreach (var def in IntegrationSettings.Arr)
        {
            if (body.Services is null || !body.Services.TryGetValue(def.Id, out var sent))
            {
                continue;
            }

            var arrUrl = Writable(def.UrlVariable, sent.Url);
            if (arrUrl is not null)
            {
                def.SetUrl(config, Clean(arrUrl));
            }

            var arrPublic = Writable(def.PublicUrlVariable, sent.PublicUrl);
            if (arrPublic is not null)
            {
                def.SetPublic(config, Clean(arrPublic));
            }

            if (!Locked(def.KeyVariable))
            {
                if (sent.ClearApiKey == true)
                {
                    def.SetKey(config, null);
                }
                else if (!string.IsNullOrWhiteSpace(sent.ApiKey))
                {
                    def.SetKey(config, sent.ApiKey.Trim());
                }
            }
        }

        if (!Locked(IntegrationSettings.SeerrApiKeyVariable))
        {
            if (body.ClearSeerrApiKey == true)
            {
                config.SeerrApiKey = null;
            }
            else if (!string.IsNullOrWhiteSpace(body.SeerrApiKey))
            {
                config.SeerrApiKey = body.SeerrApiKey.Trim();
            }
        }

        if (!Locked(IntegrationSettings.LetterboxdApiKeyVariable))
        {
            if (body.ClearLetterboxdApiKey == true)
            {
                config.LetterboxdApiKey = null;
            }
            else if (!string.IsNullOrWhiteSpace(body.LetterboxdApiKey))
            {
                config.LetterboxdApiKey = body.LetterboxdApiKey.Trim();
            }
        }

        if (!Locked(IntegrationSettings.LetterboxdApiSecretVariable))
        {
            if (body.ClearLetterboxdApiSecret == true)
            {
                config.LetterboxdApiSecret = null;
            }
            else if (!string.IsNullOrWhiteSpace(body.LetterboxdApiSecret))
            {
                config.LetterboxdApiSecret = body.LetterboxdApiSecret.Trim();
            }
        }

        var users = Writable(IntegrationSettings.SeerrUsersVariable, body.SeerrUsers);
        if (users is not null)
        {
            var pairs = IntegrationSettings.ParseUsers(users).OrderBy(p => p.Key, StringComparer.OrdinalIgnoreCase);
            config.SeerrUsers = Clean(string.Join(",", pairs.Select(p => $"{p.Key}={p.Value}")));
        }

        FeatureSwitches.Apply(config, body.Switches);
        if (body.DisabledModules is not null)
        {
            FeatureSwitches.SetDisabledModules(config, body.DisabledModules);
        }

        config.HeroItemCount = Math.Clamp(body.HeroItemCount ?? config.HeroItemCount, 1, 20);
        config.HeroIntervalSeconds = Math.Clamp(body.HeroIntervalSeconds ?? config.HeroIntervalSeconds, 4, 60);
        config.LeavingSoonDays = Math.Clamp(body.LeavingSoonDays ?? config.LeavingSoonDays, 0, 365);
        config.RequestQualityPicker = body.RequestQualityPicker is "seerr" or "admins" or "off" ? body.RequestQualityPicker : config.RequestQualityPicker;
        config.RequestDefaultQuality = body.RequestDefaultQuality is "server" or "1080p" or "4K" ? body.RequestDefaultQuality : config.RequestDefaultQuality;
        if (body.RequestProfiles is not null)
        {
            // "serverId:profileId", or empty for "read it from the names".
            string? Profile(string key, string? saved)
                => body.RequestProfiles.TryGetValue(key, out var value) ? (System.Text.RegularExpressions.Regex.IsMatch(value ?? string.Empty, @"^\d+:\d+$") ? value : null) : saved;
            config.RequestMovieHdProfile = Profile("movieHd", config.RequestMovieHdProfile);
            config.RequestMovie4kProfile = Profile("movie4k", config.RequestMovie4kProfile);
            config.RequestTvHdProfile = Profile("tvHd", config.RequestTvHdProfile);
            config.RequestTv4kProfile = Profile("tv4k", config.RequestTv4kProfile);
        }

        config.ArrivalsHour = Math.Clamp(body.ArrivalsHour ?? config.ArrivalsHour, 0, 23);
        foreach (var group in CollectionGroups.InOrder.Where(g => g.Builds()))
        {
            if (body.CollectionGroups is not null && body.CollectionGroups.TryGetValue(group.Id(), out var on))
            {
                group.Set(config, on);
            }
        }

        if (body.Seasons is not null)
        {
            var known = Collections.Catalogue.SeasonNames.Select(s => s.Key).ToHashSet(StringComparer.Ordinal);
            var off = Collections.Catalogue.SeasonsOff(config);
            foreach (var (key, on) in body.Seasons.Where(s => known.Contains(s.Key)))
            {
                if (on)
                {
                    off.Remove(key);
                }
                else
                {
                    off.Add(key);
                }
            }

            config.SeasonalOff = off.Count == 0 ? null : string.Join(",", off.Order(StringComparer.Ordinal));
        }

        if (!string.IsNullOrEmpty(region))
        {
            config.WatchRegion = region.ToUpperInvariant();
        }

        plugin.SaveConfiguration();
        IntegrationSettings.Invalidate();
        upstream.ClearCache();
        collectionsView.Clear();
        return Ok(Describe());
    }

    private object Describe()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var key = IntegrationSettings.Inspect(IntegrationSettings.SeerrApiKeyVariable, config.SeerrApiKey);
        var users = IntegrationSettings.Inspect(IntegrationSettings.SeerrUsersVariable, config.SeerrUsers);
        return new
        {
            enabled = FeatureSwitches.On("enabled", config),
            disabledModules = FeatureSwitches.DisabledModules(config),
            seerr = new
            {
                url = Show(IntegrationSettings.Inspect(IntegrationSettings.SeerrUrlVariable, config.SeerrUrl)),
                publicUrl = Show(IntegrationSettings.Inspect(IntegrationSettings.SeerrPublicUrlVariable, config.SeerrPublicUrl)),
                apiKey = new { set = key.Value is not null, source = key.Source, variable = key.Variable },
                users = new
                {
                    value = users.Value,
                    source = users.Source,
                    variable = users.Variable,
                    links = IntegrationSettings.ParseUsers(users.Value).Select(p => new { username = p.Key, seerrId = p.Value }).ToArray(),
                },
            },
            maintainerr = new
            {
                url = Show(IntegrationSettings.Inspect(IntegrationSettings.MaintainerrUrlVariable, config.MaintainerrUrl)),
            },
            sonarr = DescribeArr(config, ArrService.Sonarr),
            radarr = DescribeArr(config, ArrService.Radarr),
            sabnzbd = DescribeArr(config, ArrService.Sabnzbd),
            hero = new
            {
                count = Math.Clamp(config.HeroItemCount, 1, 20),
                intervalSeconds = Math.Clamp(config.HeroIntervalSeconds, 4, 60),
            },
            features = FeatureSwitches.Describe(config),
            elsewhere = new { region = string.IsNullOrWhiteSpace(config.WatchRegion) ? "GB" : config.WatchRegion.ToUpperInvariant() },
            notifications = new { arrivalsHour = Math.Clamp(config.ArrivalsHour, 0, 23) },
            letterboxd = DescribeLetterboxd(config),
            leavingSoonDays = Math.Clamp(config.LeavingSoonDays, 0, 365),
            requests = new
            {
                picker = config.RequestQualityPicker,
                defaultQuality = config.RequestDefaultQuality,
                profiles = new
                {
                    movieHd = config.RequestMovieHdProfile,
                    movie4k = config.RequestMovie4kProfile,
                    tvHd = config.RequestTvHdProfile,
                    tv4k = config.RequestTv4kProfile,
                },
            },
            collections = new
            {
                enabled = FeatureSwitches.On("collections", config),
                homeRows = FeatureSwitches.On("homeRows", config),
                groups = CollectionGroups.InOrder.Where(g => g.Builds()).ToDictionary(g => g.Id(), g => g.Enabled(config)),
                seasons = Collections.Catalogue.SeasonNames.Select(s => new { key = s.Key, name = s.Name, on = !Collections.Catalogue.SeasonsOff(config).Contains(s.Key) }).ToArray(),
                build = AdminToolsController.DescribeBuild(collectionBuilder),
            },
        };
    }

    private static object Show(IntegrationSettings.Field field) => new { value = field.Value, source = field.Source, variable = field.Variable };

    private static object DescribeArr(PluginConfiguration config, ArrService service)
    {
        var def = IntegrationSettings.Arr.First(d => d.Service == service);
        var key = IntegrationSettings.Inspect(def.KeyVariable, def.SavedKey(config));
        return new
        {
            url = Show(IntegrationSettings.Inspect(def.UrlVariable, def.SavedUrl(config))),
            publicUrl = Show(IntegrationSettings.Inspect(def.PublicUrlVariable, def.SavedPublic(config))),
            apiKey = new { set = key.Value is not null, source = key.Source, variable = key.Variable },
        };
    }

    private static object DescribeLetterboxd(PluginConfiguration config)
    {
        var key = IntegrationSettings.Inspect(IntegrationSettings.LetterboxdApiKeyVariable, config.LetterboxdApiKey);
        var secret = IntegrationSettings.Inspect(IntegrationSettings.LetterboxdApiSecretVariable, config.LetterboxdApiSecret);
        return new
        {
            enabled = FeatureSwitches.On("letterboxd", config),
            apiKey = new { set = key.Value is not null, source = key.Source, variable = key.Variable },
            apiSecret = new { set = secret.Value is not null, source = secret.Source, variable = secret.Variable },
        };
    }

    private static bool Locked(string variable) => IntegrationSettings.Inspect(variable, null).Locked;

    /// <summary>The submitted value, or null when it was not sent or the environment owns the field.</summary>
    private static string? Writable(string variable, string? submitted) => Locked(variable) ? null : submitted?.Trim();

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim().TrimEnd('/');

    private static bool IsWebAddress(string value)
        => Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

    public sealed class SettingsBody
    {
        public string? SeerrUrl { get; set; }

        public string? SeerrPublicUrl { get; set; }

        /// <summary>Gets or sets a new key; empty or absent keeps the saved one.</summary>
        public string? SeerrApiKey { get; set; }

        public bool? ClearSeerrApiKey { get; set; }

        public string? SeerrUsers { get; set; }

        public string? MaintainerrUrl { get; set; }

        /// <summary>Gets or sets the download stack's addresses and keys, by service id: "sonarr", "radarr", "sabnzbd".</summary>
        public Dictionary<string, ServiceBody>? Services { get; set; }

        /// <summary>
        /// Gets or sets every on/off switch the form sent, by the name it posts it under (<c>discoverEnabled</c>,
        /// <c>activityEnabled</c>, ...). The names and what they change are listed once, in <see cref="FeatureSwitches"/>.
        /// </summary>
        [JsonExtensionData]
        public Dictionary<string, JsonElement> Switches { get; set; } = new(StringComparer.OrdinalIgnoreCase);

        /// <summary>Gets or sets the web modules to leave switched off, by name; null leaves them as saved.</summary>
        public List<string?>? DisabledModules { get; set; }

        public int? HeroItemCount { get; set; }

        public int? HeroIntervalSeconds { get; set; }

        public int? ArrivalsHour { get; set; }

        public string? WatchRegion { get; set; }

        /// <summary>Gets or sets which groups become collections, by group id: "genres", "awards", ...</summary>
        public Dictionary<string, bool>? CollectionGroups { get; set; }

        /// <summary>Gets or sets a new key; empty or absent keeps the saved one.</summary>
        public string? LetterboxdApiKey { get; set; }

        public bool? ClearLetterboxdApiKey { get; set; }

        /// <summary>Gets or sets a new secret; empty or absent keeps the saved one.</summary>
        public string? LetterboxdApiSecret { get; set; }

        public bool? ClearLetterboxdApiSecret { get; set; }

        /// <summary>Gets or sets how many days ahead Leaving Soon looks; 0 for everything.</summary>
        public int? LeavingSoonDays { get; set; }

        /// <summary>Gets or sets who sees the request quality capsule: "seerr", "admins" or "off".</summary>
        public string? RequestQualityPicker { get; set; }

        /// <summary>Gets or sets the quality the capsule starts on: "server", "1080p" or "4K".</summary>
        public string? RequestDefaultQuality { get; set; }

        /// <summary>Gets or sets the request profiles by slot ("movieHd", "movie4k", "tvHd", "tv4k"): "serverId:profileId", or empty to read them from the names.</summary>
        public Dictionary<string, string?>? RequestProfiles { get; set; }

        /// <summary>Gets or sets seasonal sets on or off, by key.</summary>
        public Dictionary<string, bool>? Seasons { get; set; }
    }

    public sealed class ServiceBody
    {
        public string? Url { get; set; }

        public string? PublicUrl { get; set; }

        /// <summary>Gets or sets a new key; empty or absent keeps the saved one.</summary>
        public string? ApiKey { get; set; }

        public bool? ClearApiKey { get; set; }
    }
}
