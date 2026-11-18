using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// Where requests really stand. Seerr says "processing" for everything from "not looked at" to
/// "importing"; Sonarr, Radarr and SABnzbd know whether it is searching, queued, downloading (how
/// far, how long left) or how many episodes of a series have arrived. These endpoints join the two
/// by TMDB and TVDB id, as the signed-in user, and fail soft: with the download stack down or not
/// set up, every title simply has no activity.
/// </summary>
[ApiController]
[Authorize]
[Route("HeraTV/activity")]
public class ActivityController(UpstreamClient upstream, UserRequests requests, LibraryLookup library, IUserManager userManager) : ControllerBase
{
    private const int MaxRequests = 60;

    /// <summary>
    /// The signed-in user's own Seerr requests, one per title, each with its state in the download
    /// stack. An administrator may read another user's with <c>?user=name</c>.
    /// </summary>
    [HttpGet("requests")]
    public async Task<IActionResult> GetRequests([FromQuery] int take = 20, [FromQuery] string? user = null)
    {
        var viewer = CurrentUser();
        if (viewer is null)
        {
            return Unauthorized();
        }

        var target = viewer;
        if (!string.IsNullOrWhiteSpace(user))
        {
            if (!IsAdmin())
            {
                return StatusCode(403);
            }

            target = userManager.GetUserByName(user.Trim());
            if (target is null)
            {
                return NotFound();
            }
        }

        var seerrUser = IntegrationSettings.Current.SeerrUserFor(target.Username);
        if (seerrUser is null)
        {
            return Ok(Array.Empty<object>());
        }

        var loaded = await requests.LoadAsync(seerrUser.Value, Math.Clamp(take, 1, MaxRequests)).ConfigureAwait(false);
        var settings = IntegrationSettings.Current;
        var admin = IsAdmin();

        var rows = (loaded?.Entries ?? []).Select(e => new
        {
            item = SeerrMapper.Item(e.Title, target, library),
            requestStatus = e.Status,
            requestedAt = e.RequestedAt,
            seasons = e.Seasons.Order().ToArray(),
            activity = e.Activity?.ToJson(loaded!.Sab),
            links = ExternalLinks.For(settings, admin, e.Type, e.TmdbId, e.Activity is null ? null : ServiceOf(e.Type), e.Activity?.Slug),
        }).ToArray();

        return Ok(rows);
    }

    /// <summary>A film's or show's state in the download stack, for its sheet or detail page.</summary>
    [HttpGet("title/{mediaType}/{tmdbId:int}")]
    public async Task<IActionResult> GetTitle([FromRoute] string mediaType, [FromRoute] int tmdbId, [FromQuery] int? tvdb = null, [FromQuery] string? seasons = null)
    {
        if (CurrentUser() is null)
        {
            return Unauthorized();
        }

        var type = mediaType == "tv" ? "tv" : "movie";
        var settings = IntegrationSettings.Current;
        if (!UserRequests.ActivityOn())
        {
            return Ok(new { activity = (object?)null, links = ExternalLinks.For(settings, false, type, tmdbId, null, null) });
        }

        int? arrId = null;
        // Seerr keeps the *arr id and the TVDB id of what it has requested; the title's own record is cached.
        var record = settings.SeerrEnabled
            ? await upstream.SeerrGetAsync($"api/v1/{type}/{tmdbId}?language=en", TimeSpan.FromMinutes(5)).ConfigureAwait(false)
            : null;
        arrId = record?["mediaInfo"]?["externalServiceId"]?.GetValue<int?>();
        tvdb ??= record?["externalIds"]?["tvdbId"]?.GetValue<int?>() ?? record?["mediaInfo"]?["tvdbId"]?.GetValue<int?>();

        var numbers = (seasons ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(s => int.TryParse(s, out var n) ? n : (int?)null)
            .OfType<int>()
            .ToList();
        var queueTask = ArrActivity.QueueAsync(upstream);
        var sabTask = ArrActivity.SabAsync(upstream);
        var queue = await queueTask.ConfigureAwait(false);
        var activity = await LookUp(type, tmdbId, arrId, tvdb, numbers, queue).ConfigureAwait(false);
        var sab = await sabTask.ConfigureAwait(false);
        return Ok(new
        {
            activity = activity?.ToJson(sab),
            links = ExternalLinks.For(settings, IsAdmin(), type, tmdbId, activity is null ? null : ServiceOf(type), activity?.Slug),
        });
    }

    /// <summary>Everything in Sonarr's and Radarr's queues, with SABnzbd's overall speed. Administrators only.</summary>
    [HttpGet("downloads")]
    [Authorize(Policy = "RequiresElevation")]
    public async Task<IActionResult> GetDownloads()
        => Ok(await ArrActivity.DownloadsAsync(upstream).ConfigureAwait(false));

    private Task<ArrActivity.Activity?> LookUp(string type, int tmdbId, int? arrId, int? tvdbId, IReadOnlyCollection<int> seasons, IReadOnlyList<ArrActivity.QueueItem> queue)
        => type == "tv"
            ? ArrActivity.SeriesAsync(upstream, tmdbId, tvdbId, arrId, seasons, queue)
            : ArrActivity.MovieAsync(upstream, tmdbId, arrId, queue);

    private bool IsAdmin() => User.IsInRole("Administrator");

    private static ArrService ServiceOf(string mediaType) => mediaType == "tv" ? ArrService.Sonarr : ArrService.Radarr;

    private User? CurrentUser()
    {
        var claim = User.FindFirst("Jellyfin-UserId")?.Value;
        return Guid.TryParse(claim, out var id) ? userManager.GetUserById(id) : null;
    }
}
