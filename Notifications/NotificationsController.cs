using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.HeraTv.Stats;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Notifications;

/// <summary>
/// The bell's side of the server: the signed-in person's own notices, marking them read, and which
/// kinds they want. Everything is keyed by the signed-in user, so one person can never read
/// or change another's.
/// </summary>
[ApiController]
[Authorize]
[Route("HeraTV/notifications")]
public class NotificationsController(NotificationStore store, ILibraryManager library, IUserManager userManager) : ControllerBase
{
    private const int MaxLimit = 100;
    private const int MaxIds = 200;

    // Written by hand rather than through MVC's output formatter so every field is always present (null, never left out), which is what the client's contract promises.
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>The signed-in user's newest notices, how many are unread, and the library items the unread ones announce.</summary>
    [HttpGet]
    public IActionResult Get([FromQuery] int limit = 50)
    {
        if (CurrentUserId() is not { } userId)
        {
            return Unauthorized();
        }

        // Revalidated every time, never served from the browser's cache: marking notices read is a POST to
        // another URL, which wouldn't clear a cached copy of this one, and the bell would keep showing the old
        // count. The read is one indexed query on a small file, so there is nothing worth caching.
        Response.Headers.CacheControl = "private, no-cache";
        var listing = NotificationCentre.Enabled ? store.Read(userId, Math.Clamp(limit, 1, MaxLimit)) : new Listing(0, [], []);
        return Reply(new
        {
            unread = listing.Unread,
            notices = listing.Notices.Select(n => new
            {
                id = n.Id,
                kind = n.Kind,
                title = n.Title,
                body = n.Body,
                itemId = n.ItemId,
                imageId = n.ImageId,
                url = n.Url,
                items = n.Items,
                createdAt = n.CreatedAt,
                read = n.Read,
            }),
            newItems = listing.NewItems,
        });
    }

    /// <summary>Marks the given notices read, or all of them when no <c>ids</c> are sent.</summary>
    [HttpPost("read")]
    public IActionResult MarkRead([FromBody] ReadBody? body)
    {
        if (CurrentUserId() is not { } userId)
        {
            return Unauthorized();
        }

        if (body?.Ids is { } ids)
        {
            if (ids.Count > MaxIds)
            {
                return BadRequest(new { message = $"Send at most {MaxIds} ids at a time." });
            }

            if (ids.Any(id => id <= 0))
            {
                return BadRequest(new { message = "Notice ids are positive numbers." });
            }
        }

        return Reply(new { unread = store.MarkRead(userId, body?.Ids?.Distinct().ToList()) });
    }

    /// <summary>Which kinds of notice the signed-in user wants.</summary>
    [HttpGet("prefs")]
    public IActionResult GetPrefs()
    {
        if (CurrentUserId() is not { } userId)
        {
            return Unauthorized();
        }

        Response.Headers.CacheControl = "private, no-cache";
        return Reply(Describe(store.GetPrefs(userId)));
    }

    /// <summary>Changes the kinds the signed-in user wants; what isn't sent stays as it was.</summary>
    [HttpPost("prefs")]
    public IActionResult SetPrefs([FromBody] PrefsBody? body)
    {
        if (CurrentUserId() is not { } userId)
        {
            return Unauthorized();
        }

        var current = store.GetPrefs(userId);
        var next = new NoticePrefs(body?.Requests ?? current.Requests, body?.Episodes ?? current.Episodes, body?.Arrivals ?? current.Arrivals);
        if (!store.SetPrefs(userId, next))
        {
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new { message = "Your choices couldn't be saved." });
        }

        return Reply(Describe(next));
    }

    /// <summary>
    /// A test aid for administrators: writes one sample notice of each kind for the caller, from their
    /// own library, so the bell and its "New" badges can be checked without waiting for a download or
    /// a scan. Run it again and the same three notices come back unread.
    /// </summary>
    [HttpPost("test")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult Seed()
    {
        var user = Guid.TryParse(User.FindFirst("Jellyfin-UserId")?.Value, out var id) ? userManager.GetUserById(id) : null;
        if (user is null)
        {
            return Unauthorized();
        }

        if (!NotificationCentre.Enabled)
        {
            return Conflict(new { message = "Notifications are switched off in the plugin's settings." });
        }

        var userId = user.Id.ToString("N");
        var now = DateTime.UtcNow;
        var today = Clock.Today;
        var films = Newest(user, BaseItemKind.Movie);
        var shows = Newest(user, BaseItemKind.Series);
        var written = new List<string>();

        var film = films.FirstOrDefault();
        var (requestTitle, requestBody) = NoticeText.Request(film?.Name ?? "Dune: Part Two", "available", today.AddDays(-2), today);
        var filmId = film?.Id.ToString("N");
        if (store.Add(
            userId,
            new NoticeDraft(NoticeKind.Request, "test:request", requestTitle, requestBody, filmId, filmId, filmId is null ? "#/home?hera=requests" : null, null, filmId is null ? [] : [filmId]),
            true,
            now))
        {
            written.Add(NoticeKind.Request);
        }

        var show = shows.FirstOrDefault();
        var showId = show?.Id.ToString("N");
        var (episodeTitle, episodeBody) = NoticeText.Episodes(
            show?.Name ?? "Bosch: Legacy",
            [new EpisodeRef(string.Empty, 2, 4, null, "Pilot"), new EpisodeRef(string.Empty, 2, 5, null, "Second"), new EpisodeRef(string.Empty, 2, 6, null, "Third")]);
        if (store.Add(
            userId,
            new NoticeDraft(NoticeKind.Episode, "test:episode", episodeTitle, episodeBody, showId, showId, null, null, showId is null ? [] : [showId]),
            true,
            now))
        {
            written.Add(NoticeKind.Episode);
        }

        var arrived = films.Take(3).Concat(shows.Take(3)).ToList();
        if (arrived.Count >= 1)
        {
            var items = arrived.Select(i => new NoticeItem(i.Id.ToString("N"), i.Name, i is MediaBrowser.Controller.Entities.TV.Series ? "Series" : "Movie")).ToList();
            var filmCount = arrived.Count(i => i is not MediaBrowser.Controller.Entities.TV.Series);
            var (arrivalsTitle, arrivalsBody) = NoticeText.Arrivals(items, filmCount, arrived.Count - filmCount);
            if (store.Add(
                userId,
                new NoticeDraft(NoticeKind.Arrivals, "test:arrivals", arrivalsTitle, arrivalsBody, null, items[0].Id, null, items, [.. items.Select(i => i.Id)]),
                true,
                now))
            {
                written.Add(NoticeKind.Arrivals);
            }
        }

        return Reply(new { written, unread = store.Read(userId, 1).Unread });
    }

    private static object Describe(NoticePrefs prefs) => new { requests = prefs.Requests, episodes = prefs.Episodes, arrivals = prefs.Arrivals };

    private IReadOnlyList<BaseItem> Newest(User user, BaseItemKind kind)
        => library.GetItemList(new InternalItemsQuery(user)
        {
            IncludeItemTypes = [kind],
            Recursive = true,
            IsVirtualItem = false,
            Limit = 3,
            OrderBy = [(ItemSortBy.DateCreated, Jellyfin.Database.Implementations.Enums.SortOrder.Descending)],
        });

    private ContentResult Reply(object value) => Content(JsonSerializer.Serialize(value, Json), "application/json");

    private string? CurrentUserId()
        => Guid.TryParse(User.FindFirst("Jellyfin-UserId")?.Value, out var id) ? id.ToString("N") : null;

    public sealed class ReadBody
    {
        /// <summary>Gets or sets the notices to mark read; absent means all of them.</summary>
        public List<long>? Ids { get; set; }
    }

    public sealed class PrefsBody
    {
        public bool? Requests { get; set; }

        public bool? Episodes { get; set; }

        public bool? Arrivals { get; set; }
    }
}
