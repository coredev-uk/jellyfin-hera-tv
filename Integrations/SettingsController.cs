using Jellyfin.Plugin.HeraTv.Collections;
using Jellyfin.Plugin.HeraTv.Letterboxd;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// What the dashboard's Hera TV page reads and writes. Admin only. HERATV_* environment variables
/// win over saved values, so each field reports where its effective value comes from and a save
/// leaves the fields the environment owns alone. The Seerr API key is write-only: it is accepted
/// here, never sent back.
/// </summary>
[ApiController]
[Authorize(Policy = "RequiresElevation")]
[Route("HeraTV/settings")]
public class SettingsController(
    UpstreamClient upstream,
    ICollectionBuilder collectionBuilder,
    ICollectionsView collectionsView,
    ITaskManager taskManager,
    LetterboxdStore letterboxd,
    IUserManager userManager) : ControllerBase
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

        config.LetterboxdEnabled = body.LetterboxdEnabled ?? config.LetterboxdEnabled;

        var users = Writable(IntegrationSettings.SeerrUsersVariable, body.SeerrUsers);
        if (users is not null)
        {
            var pairs = IntegrationSettings.ParseUsers(users).OrderBy(p => p.Key, StringComparer.OrdinalIgnoreCase);
            config.SeerrUsers = Clean(string.Join(",", pairs.Select(p => $"{p.Key}={p.Value}")));
        }

        config.HeroItemCount = Math.Clamp(body.HeroItemCount ?? config.HeroItemCount, 1, 20);
        config.HeroIntervalSeconds = Math.Clamp(body.HeroIntervalSeconds ?? config.HeroIntervalSeconds, 4, 60);
        config.DiscoverEnabled = body.DiscoverEnabled ?? config.DiscoverEnabled;
        config.LeavingSoonEnabled = body.LeavingSoonEnabled ?? config.LeavingSoonEnabled;
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

        config.RequestsRowEnabled = body.RequestsRowEnabled ?? config.RequestsRowEnabled;
        config.TrendingRowEnabled = body.TrendingRowEnabled ?? config.TrendingRowEnabled;
        config.ElsewhereEnabled = body.ElsewhereEnabled ?? config.ElsewhereEnabled;
        config.RatingsEnabled = body.RatingsEnabled ?? config.RatingsEnabled;
        config.QualityBadgesEnabled = body.QualityBadgesEnabled ?? config.QualityBadgesEnabled;
        config.ActivityEnabled = body.ActivityEnabled ?? config.ActivityEnabled;
        config.NotificationsEnabled = body.NotificationsEnabled ?? config.NotificationsEnabled;
        config.ArrivalsHour = Math.Clamp(body.ArrivalsHour ?? config.ArrivalsHour, 0, 23);
        config.CollectionsEnabled = body.CollectionsEnabled ?? config.CollectionsEnabled;
        config.HomeRowsEnabled = body.HomeRowsEnabled ?? config.HomeRowsEnabled;
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

        if (status.Status == 200 && status.Body?["version"] is { } version)
        {
            return Ok(new { ok = true, version = version.ToString(), message = $"Connected to Maintainerr {version}." });
        }

        // Older builds have no status route; their collections list says the same thing.
        var collections = await upstream.ProbeAsync(url, "api/collections", null).ConfigureAwait(false);
        if (collections.Status == 200 && collections.Body is System.Text.Json.Nodes.JsonArray list)
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
        if (reply.Status != 200 || reply.Body?["results"] is not System.Text.Json.Nodes.JsonArray results)
        {
            return Ok(new
            {
                ok = false,
                message = reply.Failure ?? (reply.Status is 401 or 403 ? "Seerr rejected the API key." : $"Seerr answered HTTP {reply.Status}."),
                users = Array.Empty<object>(),
            });
        }

        var users = results
            .Where(r => r?["id"] is not null)
            .Select(r => new
            {
                id = r!["id"]!.GetValue<int>(),
                displayName = (string?)r["displayName"] ?? (string?)r["username"] ?? $"User {r["id"]}",
                email = (string?)r["email"],
                username = (string?)r["jellyfinUsername"] ?? (string?)r["plexUsername"] ?? (string?)r["username"],
            })
            .OrderBy(u => u.displayName, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return Ok(new { ok = true, message = (string?)null, users });
    }

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

    /// <summary>Which Jellyfin users have linked Letterboxd, and how each diary is going. Tokens never leave the server.</summary>
    [HttpGet("letterboxd/links")]
    public IActionResult LetterboxdLinks()
    {
        var links = letterboxd.Links().Select(link => new
        {
            user = Guid.TryParse(link.UserId, out var id) ? userManager.GetUserById(id)?.Username : null,
            username = link.Username,
            logFinished = link.LogFinished,
            linkedAt = link.LinkedAt,
            lastLoggedAt = link.LastLoggedAt,
            lastError = link.LastError,
            pending = letterboxd.Count(link.UserId, WatchState.Pending),
            failed = letterboxd.Count(link.UserId, WatchState.Failed),
        });
        return Ok(new { links });
    }

    /// <summary>Starts the Build Hera TV collections task now, unless it is already running.</summary>
    [HttpPost("collections/build")]
    public IActionResult BuildCollections()
    {
        if (collectionBuilder.Status.Running)
        {
            return Ok(new { ok = true, message = "A build is already running." });
        }

        taskManager.QueueIfNotRunning<BuildCollectionsTask>();
        return Ok(new { ok = true, message = "Building collections. This takes a minute or two for a larger library." });
    }

    /// <summary>Whether the collections build is running, and how the last one went.</summary>
    [HttpGet("collections/status")]
    public IActionResult CollectionsStatus() => Ok(DescribeBuild());

    private object DescribeBuild()
    {
        var status = collectionBuilder.Status;
        return new
        {
            running = status.Running,
            last = status.Last is { } last
                ? new { at = last.At, created = last.Created, updated = last.Updated, removed = last.Removed, unchanged = last.Unchanged, failed = last.Failed, seconds = last.Seconds, note = last.Note }
                : null,
        };
    }

    private object Describe()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var key = IntegrationSettings.Inspect(IntegrationSettings.SeerrApiKeyVariable, config.SeerrApiKey);
        var users = IntegrationSettings.Inspect(IntegrationSettings.SeerrUsersVariable, config.SeerrUsers);
        return new
        {
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
            features = IntegrationSettings.Features(config),
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
                enabled = config.CollectionsEnabled,
                homeRows = config.HomeRowsEnabled,
                groups = CollectionGroups.InOrder.Where(g => g.Builds()).ToDictionary(g => g.Id(), g => g.Enabled(config)),
                seasons = Collections.Catalogue.SeasonNames.Select(s => new { key = s.Key, name = s.Name, on = !Collections.Catalogue.SeasonsOff(config).Contains(s.Key) }).ToArray(),
                build = DescribeBuild(),
            },
        };
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
            foreach (var server in servers?.AsArray() ?? [])
            {
                if (server?["id"]?.GetValue<int>() is not int id)
                {
                    continue;
                }

                var detail = await upstream.SeerrGetAsync($"api/v1/service/{service}/{id}", TimeSpan.FromMinutes(1)).ConfigureAwait(false);
                list.Add(new
                {
                    id,
                    name = (string?)server["name"],
                    is4k = server["is4k"]?.GetValue<bool>() == true,
                    isDefault = server["isDefault"]?.GetValue<bool>() == true,
                    activeProfileId = server["activeProfileId"]?.GetValue<int?>(),
                    profiles = (detail?["profiles"]?.AsArray() ?? [])
                        .Where(p => p?["id"]?.GetValue<int>() is not null)
                        .Select(p => new { id = p!["id"]!.GetValue<int>(), name = (string?)p["name"], guess = DiscoverController.Resolution((string?)p["name"]) })
                        .ToArray(),
                });
            }

            return [.. list];
        }

        return Ok(new { movie = await Servers("radarr").ConfigureAwait(false), tv = await Servers("sonarr").ConfigureAwait(false) });
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
            enabled = config.LetterboxdEnabled,
            apiKey = new { set = key.Value is not null, source = key.Source, variable = key.Variable },
            apiSecret = new { set = secret.Value is not null, source = secret.Source, variable = secret.Variable },
        };
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

            if (version.Status != 200 || version.Body?["version"] is not { } sabVersion)
            {
                return new { ok = false, message = $"{host} answered HTTP {version.Status} but does not look like SABnzbd. Check the URL." };
            }

            var queue = await upstream.ProbeAsync(url, $"api?mode=queue&limit=1&output=json&apikey={Uri.EscapeDataString(key)}", null).ConfigureAwait(false);
            return queue.Status == 200 && queue.Body?["queue"] is not null
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

        if (status.Status == 200 && status.Body?["version"] is { } arrVersion)
        {
            var app = (string?)status.Body["appName"];
            return app is not null && !app.Equals(def.Name, StringComparison.OrdinalIgnoreCase)
                ? new { ok = false, version = arrVersion.ToString(), message = $"{host} is {app}, not {def.Name}. Check the URL." }
                : new { ok = true, version = arrVersion.ToString(), message = $"Connected to {def.Name} {arrVersion}. The API key works." };
        }

        return new { ok = false, message = $"{host} answered HTTP {status.Status} but does not look like {def.Name}. Check the URL." };
    }

    private static bool Locked(string variable) => IntegrationSettings.Inspect(variable, null).Locked;

    /// <summary>The submitted value, or null when it was not sent or the environment owns the field.</summary>
    private static string? Writable(string variable, string? submitted) => Locked(variable) ? null : submitted?.Trim();

    private static string? Clean(string? value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim().TrimEnd('/');

    private static bool IsWebAddress(string value)
        => Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri) && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps);

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

        if (status.Status != 200 || status.Body?["version"] is not { } version)
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

        public int? HeroItemCount { get; set; }

        public int? HeroIntervalSeconds { get; set; }

        public bool? DiscoverEnabled { get; set; }

        public bool? LeavingSoonEnabled { get; set; }

        public bool? RequestsRowEnabled { get; set; }

        public bool? TrendingRowEnabled { get; set; }

        public bool? ElsewhereEnabled { get; set; }

        public bool? RatingsEnabled { get; set; }

        public bool? QualityBadgesEnabled { get; set; }

        public bool? ActivityEnabled { get; set; }

        public bool? NotificationsEnabled { get; set; }

        public int? ArrivalsHour { get; set; }

        public string? WatchRegion { get; set; }

        public bool? CollectionsEnabled { get; set; }

        public bool? HomeRowsEnabled { get; set; }

        /// <summary>Gets or sets which groups become collections, by group id: "genres", "awards", ...</summary>
        public Dictionary<string, bool>? CollectionGroups { get; set; }

        public bool? LetterboxdEnabled { get; set; }

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
