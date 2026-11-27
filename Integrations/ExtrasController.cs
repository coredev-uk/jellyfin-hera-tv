using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// What Hera TV adds to a title that Jellyfin has no page for: where else it streams, how critics
/// rate it, what quality the file is, and the titles a person asked not to see again. Reads run as
/// the signed-in Jellyfin user. Seerr's API key stays here.
/// </summary>
[ApiController]
[Authorize]
[Route("HeraTV")]
public partial class ExtrasController(
    UpstreamClient upstream,
    HiddenStore hidden,
    ILibraryManager libraryManager,
    IUserManager userManager,
    IMediaSourceManager mediaSources) : ControllerBase
{
    private const int MaxProviders = 6;
    private const int MaxBadgeIds = 60;

    private static readonly TimeSpan BadgeTtl = TimeSpan.FromMinutes(30);
    private const int MaxBadgeEntries = 4000;
    private static readonly AsyncTtlCache<Guid, string[]> BadgeCache = new(MaxBadgeEntries);

    // A provider offered again as an ad tier or as a channel inside another service adds nothing.
    [GeneratedRegex(@"\s+(Standard )?with Ads$|\s+(Amazon|Apple TV|Roku Premium|Prime Video) Channel$", RegexOptions.IgnoreCase)]
    private static partial Regex Variant();

    /// <summary>Quality badges, ratings and streaming providers for the film or series a page is about.</summary>
    [HttpGet("extras/{itemId:guid}")]
    public async Task<IActionResult> GetExtras([FromRoute] Guid itemId)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        var item = libraryManager.GetItemById(itemId);
        if (item is null || !item.IsVisible(user))
        {
            return NotFound();
        }

        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var type = item switch
        {
            Movie => "movie",
            Series => "tv",
            _ => null,
        };
        var seerr = IntegrationSettings.Current.SeerrEnabled;
        item.TryGetProviderId(MediaBrowser.Model.Entities.MetadataProvider.Tmdb, out var tmdbId);
        var lookup = type is not null && seerr && !string.IsNullOrEmpty(tmdbId);

        var ratingsTask = lookup && config.RatingsEnabled ? Ratings(type!, tmdbId!) : Task.FromResult<object?>(null);
        var providersTask = lookup && config.ElsewhereEnabled ? Providers(type!, tmdbId!, config.WatchRegion) : Task.FromResult<object?>(null);
        var badges = config.QualityBadgesEnabled ? BadgesOf(item, user) : [];

        return Ok(new
        {
            badges,
            ratings = await ratingsTask.ConfigureAwait(false),
            providers = await providersTask.ConfigureAwait(false),
        });
    }

    /// <summary>Quality badges for many items at once, for the cards a page has on screen.</summary>
    [HttpGet("extras/badges")]
    public IActionResult GetBadges([FromQuery] string ids)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        var result = new Dictionary<string, string[]>(StringComparer.Ordinal);
        if (Plugin.Instance?.Configuration.QualityBadgesEnabled == false)
        {
            return Ok(result);
        }

        var wanted = (ids ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Take(MaxBadgeIds)
            .Select(raw => Guid.TryParse(raw, out var id) ? id : Guid.Empty)
            .Where(id => id != Guid.Empty)
            .Distinct()
            .ToArray();
        if (wanted.Length > 0)
        {
            // One query settles which of them this person may see, however many are asked for.
            foreach (var item in libraryManager.GetItemList(new InternalItemsQuery(user) { ItemIds = wanted }))
            {
                result[item.Id.ToString("N", CultureInfo.InvariantCulture)] = BadgesOf(item, user);
            }
        }

        Response.Headers.CacheControl = "private, max-age=300";
        return Ok(result);
    }

    /// <summary>The viewer's hidden titles: Up Next removals and "Not Interested", newest first.</summary>
    [HttpGet("hidden")]
    public IActionResult GetHidden()
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        return Ok(Describe(hidden.Read(user.Id)));
    }

    [HttpPost("hidden")]
    public IActionResult Hide([FromBody] HideBody body)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        if (body.Scope is not (HiddenStore.UpNext or HiddenStore.Interest)
            || string.IsNullOrWhiteSpace(body.Key) || body.Key.Length > 100
            || string.IsNullOrWhiteSpace(body.Title))
        {
            return BadRequest(new { message = "Nothing to hide." });
        }

        var entry = new HiddenTitle
        {
            Scope = body.Scope,
            Key = body.Key.Trim(),
            Title = Clip(body.Title, 200)!,
            Year = Clip(body.Year, 12),
            Kind = Clip(body.Kind, 20),
            Image = body.Image is { } image && Uri.TryCreate(image, UriKind.Absolute, out var uri) && uri.Scheme is "http" or "https" && image.Length <= 500 ? image : null,
            Aliases = (body.Aliases ?? []).Where(a => !string.IsNullOrWhiteSpace(a) && a.Length <= 100).Select(a => a.Trim()).Distinct().Take(4).ToList(),
            At = DateTime.UtcNow,
        };
        return Ok(Describe(hidden.Add(user.Id, entry)));
    }

    [HttpDelete("hidden")]
    public IActionResult Unhide([FromQuery] string scope, [FromQuery] string key)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        return Ok(Describe(hidden.Remove(user.Id, scope, key)));
    }

    private static string? Clip(string? value, int length)
    {
        var trimmed = value?.Trim();
        return string.IsNullOrEmpty(trimmed) ? null : trimmed.Length > length ? trimmed[..length] : trimmed;
    }

    private static object[] Describe(IEnumerable<HiddenTitle> list)
        => list.OrderByDescending(t => t.At).Select(t => (object)new
        {
            scope = t.Scope,
            key = t.Key,
            title = t.Title,
            year = t.Year,
            kind = t.Kind,
            image = t.Image,
            aliases = t.Aliases,
            at = t.At,
        }).ToArray();

    // ---------- Seerr ---------------------------------------------------------------------------

    private async Task<object?> Ratings(string type, string tmdbId)
    {
        var path = type == "tv" ? $"api/v1/tv/{tmdbId}/ratings" : $"api/v1/movie/{tmdbId}/ratingscombined";
        var node = await upstream.SeerrGetAsync(path, TimeSpan.FromHours(2)).ConfigureAwait(false);
        if (node is null)
        {
            return null;
        }

        // A series answers with the Rotten Tomatoes record itself; a film nests it beside IMDb's.
        var rt = type == "tv" ? node : node.At("rt");
        var imdb = type == "tv" ? null : node.At("imdb");
        var critics = Score(rt.At("criticsScore"), rt.At("criticsRating").Str());
        var audience = Score(rt.At("audienceScore"), rt.At("audienceRating").Str());
        var imdbScore = imdb.At("criticsScore").Num();
        if (critics is null && audience is null && imdbScore is null)
        {
            return null;
        }

        return new
        {
            imdb = imdbScore is null ? null : new { score = imdbScore, votes = imdb.At("criticsScoreCount").Int(), url = imdb.At("url").Str() },
            rt = critics is null && audience is null ? null : new { url = rt.At("url").Str(), critics, audience },
        };
    }

    // Rotten Tomatoes' own words for a score's state: Certified Fresh and Fresh, Rotten; Upright, Spilled.
    private static object? Score(JsonNode? score, string? rating)
    {
        var value = score.Num() is { } number ? (int)Math.Round(number) : (int?)null;
        if (value is null)
        {
            return null;
        }

        var good = rating is not null && (rating.Contains("Fresh", StringComparison.OrdinalIgnoreCase) || rating.Equals("Upright", StringComparison.OrdinalIgnoreCase));
        return new { score = value, fresh = good };
    }

    private async Task<object?> Providers(string type, string tmdbId, string region)
    {
        var node = await upstream.SeerrGetAsync($"api/v1/{type}/{tmdbId}?language=en", TimeSpan.FromMinutes(30)).ConfigureAwait(false);
        var here = node.At("watchProviders").Items()
            .FirstOrDefault(p => string.Equals(p.At("iso_3166_1").Str(), region, StringComparison.OrdinalIgnoreCase));
        var streaming = here.At("flatrate").Items()
            .Where(p => !string.IsNullOrEmpty(p.At("logoPath").Str()))
            .OrderBy(p => p.At("displayPriority").Int() ?? int.MaxValue)
            .ToList();
        if (streaming.Count == 0)
        {
            return null;
        }

        var names = streaming.Select(p => p.At("name").Str() ?? string.Empty).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var shown = streaming
            .Where(p =>
            {
                var name = p.At("name").Str() ?? string.Empty;
                var bare = Variant().Replace(name, string.Empty);
                return bare == name || !names.Contains(bare);
            })
            .Take(MaxProviders)
            .Select(p => new
            {
                id = p.At("id").Int(),
                name = p.At("name").Str(),
                logo = SeerrMapper.Image(p.At("logoPath").Str(), "w154"),
            })
            .ToArray();
        return new { region = region.ToUpperInvariant(), link = here.At("link").Str(), streaming = shown };
    }

    // ---------- quality -------------------------------------------------------------------------

    private string[] BadgesOf(BaseItem item, User user)
        => BadgeCache.Get(item.Id, BadgeTtl, () =>
        {
            // A show has no file of its own: its first few episodes say what it is shot and mastered in.
            IEnumerable<BaseItem> sources = item is Series
                ? libraryManager.GetItemList(new InternalItemsQuery(user)
                {
                    AncestorIds = [item.Id],
                    IncludeItemTypes = [BaseItemKind.Episode],
                    Recursive = true,
                    IsVirtualItem = false,
                    Limit = 3,
                })
                : [item];

            var found = new HashSet<string>(StringComparer.Ordinal);
            foreach (var source in sources)
            {
                foreach (var badge in Quality(mediaSources.GetMediaStreams(source.Id)))
                {
                    found.Add(badge);
                }
            }

            return new[] { "4k", "dv", "hdr", "atmos", "7.1", "5.1" }.Where(found.Contains).ToArray();
        });

    private static IEnumerable<string> Quality(IReadOnlyList<MediaStream> streams)
    {
        foreach (var stream in streams)
        {
            if (stream.Type == MediaStreamType.Video && !stream.IsExternal)
            {
                if ((stream.Width ?? 0) >= 3600 || (stream.Height ?? 0) >= 2000)
                {
                    yield return "4k";
                }

                var range = stream.VideoRangeType;
                if (range != VideoRangeType.DOVIInvalid && range.ToString().StartsWith("DOVI", StringComparison.Ordinal))
                {
                    yield return "dv";
                }
                else if (range is VideoRangeType.HDR10 or VideoRangeType.HDR10Plus or VideoRangeType.HLG)
                {
                    yield return "hdr";
                }
            }
            else if (stream.Type == MediaStreamType.Audio)
            {
                if (stream.AudioSpatialFormat == AudioSpatialFormat.DolbyAtmos || (stream.Profile ?? string.Empty).Contains("Atmos", StringComparison.OrdinalIgnoreCase))
                {
                    yield return "atmos";
                }
                else if ((stream.Channels ?? 0) >= 8)
                {
                    yield return "7.1";
                }
                else if ((stream.Channels ?? 0) >= 6)
                {
                    yield return "5.1";
                }
            }
        }
    }

    private User? CurrentUser() => this.Current(userManager);

    public sealed class HideBody
    {
        public string? Scope { get; set; }

        public string? Key { get; set; }

        public string? Title { get; set; }

        public string? Year { get; set; }

        public string? Kind { get; set; }

        public string? Image { get; set; }

        public List<string>? Aliases { get; set; }
    }
}
