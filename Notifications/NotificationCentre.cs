using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.HeraTv.Integrations;
using Jellyfin.Plugin.HeraTv.Stats;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.HeraTv.Notifications;

/// <summary>
/// Writes the notices behind the header's bell, for the three things a household cares about:
/// where its own Seerr requests have got to, new episodes of shows it is watching, and a daily
/// summary of what arrived.
/// </summary>
/// <remarks>
/// One timer, every minute, drives all three. Each producer fails on its own and is logged once per
/// kind until it recovers; nothing here may take the server down or cost a user a page. Every
/// library question is asked as the user it is for (a user-scoped query), so a notice never names
/// a title that person can't open.
/// </remarks>
internal sealed class NotificationCentre(
    ILibraryManager library,
    IUserManager users,
    IUserDataManager userData,
    UserRequests requests,
    LibraryLookup lookup,
    NotificationStore store,
    ILogger<NotificationCentre> logger) : BackgroundService
{
    /// <summary>How often each user's requests are read.</summary>
    private const int RequestMinutes = 5;

    /// <summary>A show is "being watched" when one of its episodes was played this recently.</summary>
    private const int WatchingDays = 90;

    // A scan adds episodes in a stream; the notice waits until it has gone quiet. A scan that never
    // goes quiet (a large import) is flushed after the longer wait so the notice isn't held for ever.
    private static readonly TimeSpan Quiet = TimeSpan.FromMinutes(10);
    private static readonly TimeSpan MostWaiting = TimeSpan.FromMinutes(60);

    // The list shows a handful of titles; the count in the headline is the real total.
    private const int MaxListed = 30;

    // Ids a notice marks "New". Newest first, so a huge first import marks the latest rather than a random slice.
    private const int MaxMarked = 100;

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly Lock gate = new();
    private readonly Dictionary<Guid, HashSet<Guid>> pending = [];
    private readonly ConcurrentDictionary<string, bool> failing = new();
    private DateTime firstAdded;
    private DateTime lastAdded;
    private DateTime prunedOn = DateTime.MinValue;

    /// <summary>Gets a value indicating whether the server-wide switch is on.</summary>
    internal static bool Enabled => Plugin.Instance?.Configuration.NotificationsEnabled != false;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        library.ItemAdded += OnItemAdded;
        try
        {
            using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
            var tick = 0;
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                tick++;
                if (!Enabled)
                {
                    lock (gate)
                    {
                        pending.Clear();
                    }

                    continue;
                }

                var now = DateTime.UtcNow;
                if (tick % RequestMinutes == 1)
                {
                    await Guard("poll requests", () => PollRequests(stoppingToken), stoppingToken).ConfigureAwait(false);
                }

                await Guard("write episode notices", () => Task.FromResult(FlushEpisodes(now)), stoppingToken).ConfigureAwait(false);
                await Guard("write the daily summary", () => Task.FromResult(WriteArrivals(now)), stoppingToken).ConfigureAwait(false);
                await Guard("prune old notices", () => Task.FromResult(Prune(now)), stoppingToken).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException)
        {
            // The server is stopping.
        }
        finally
        {
            library.ItemAdded -= OnItemAdded;
        }
    }

    /// <summary>Runs one producer, logging its first failure and then staying quiet until it has run clean again.</summary>
    private async Task Guard(string what, Func<Task<bool>> work, CancellationToken stoppingToken)
    {
        try
        {
            if (await work().ConfigureAwait(false))
            {
                failing.TryRemove(what, out _);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            Failed(what, ex);
        }
    }

    private void Failed(string what, Exception ex)
    {
        if (failing.TryAdd(what, true))
        {
            logger.LogWarning(ex, "Hera TV couldn't {What}; it will try again. Further failures are logged at debug level", what);
        }
        else
        {
            logger.LogDebug(ex, "Hera TV couldn't {What}", what);
        }
    }

    // ---------- requests -----------------------------------------------------------------------

    private async Task<bool> PollRequests(CancellationToken stoppingToken)
    {
        var clean = true;
        var settings = IntegrationSettings.Current;
        if (!settings.SeerrEnabled)
        {
            return true;
        }

        foreach (var user in users.GetUsers().ToList())
        {
            stoppingToken.ThrowIfCancellationRequested();
            if (settings.SeerrUserFor(user.Username) is not { } seerrUser)
            {
                continue;
            }

            try
            {
                await PollUser(user, seerrUser).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                // One person's failure must not stop the rest being looked at.
                clean = false;
                Failed("poll requests", ex);
            }
        }

        return clean;
    }

    private async Task PollUser(User user, int seerrUser)
    {
        var result = await requests.LoadAsync(seerrUser, 60).ConfigureAwait(false);
        if (result is null)
        {
            // Seerr didn't answer. That is not "no requests", so nothing is learnt or recorded.
            return;
        }

        var userId = user.Id.ToString("N");
        var baselineKey = "requests:" + userId;
        // A first look only records where everything stands; announcing a whole history at once would be a flood.
        var baselined = store.Meta(baselineKey) is not null;
        var prefs = store.GetPrefs(userId);
        var known = store.RequestStates(userId);
        var now = DateTime.UtcNow;
        var changed = new List<(string, RequestState)>();
        var notices = new List<NoticeDraft>();

        foreach (var entry in result.Entries)
        {
            var tmdb = entry.TmdbId.ToString(CultureInfo.InvariantCulture);
            var key = $"{entry.Type}:{tmdb}";
            // The user's own library, asked once for this title and only if a state or a notice needs it.
            var held = new Lazy<BaseItem?>(() => lookup.Find(user, entry.Type, tmdb));
            var state = RequestTransitions.StateOf(entry.Status, entry.Activity, entry.Type, () => held.Value is not null);
            known.TryGetValue(key, out var previous);
            if (previous is not null && previous.State == state && previous.RequestedAt == entry.RequestedAt)
            {
                continue;
            }

            changed.Add((key, new RequestState(state, entry.RequestedAt)));
            // The state is recorded whether or not it is announced, so switching requests back on later doesn't replay what happened meanwhile.
            if (baselined && prefs.Requests && RequestTransitions.ShouldNotify(previous, state, entry.RequestedAt, now)
                && RequestNotice(entry, state, held) is { } notice)
            {
                notices.Add(notice);
            }
        }

        if (changed.Count > 0 || !baselined)
        {
            store.ApplyRequests(userId, changed, notices, baselined ? null : baselineKey, now);
        }
    }

    private static NoticeDraft? RequestNotice(UserRequests.Entry entry, string state, Lazy<BaseItem?> held)
    {
        var name = (string?)entry.Title["title"] ?? (string?)entry.Title["name"];
        if (string.IsNullOrWhiteSpace(name))
        {
            return null;
        }

        // A series asked for a season at a time can already be in the library, so the link goes to it whatever the state.
        var itemId = held.Value?.Id.ToString("N");
        var requested = RequestTransitions.ParseUtc(entry.RequestedAt) is { } utc ? Clock.FromUtc(utc) : (DateTime?)null;
        var (title, body) = NoticeText.Request(name, state, requested, Clock.Today);
        return new NoticeDraft(
            NoticeKind.Request,
            $"request:{entry.Type}:{entry.TmdbId.ToString(CultureInfo.InvariantCulture)}:{state}:{entry.RequestedAt}",
            title,
            body,
            itemId,
            itemId,
            itemId is null ? "#/home?hera=requests" : null,
            null,
            // Only "ready to watch" marks the title New; an approval isn't something to watch yet.
            state == "available" && itemId is not null ? [itemId] : []);
    }

    // ---------- new episodes -------------------------------------------------------------------

    private void OnItemAdded(object? sender, ItemChangeEventArgs e)
    {
        try
        {
            if (!Enabled || e.Item is not Episode { IsVirtualItem: false } episode)
            {
                return;
            }

            var series = episode.SeriesId;
            if (series == Guid.Empty)
            {
                series = episode.FindSeriesId();
            }

            if (series == Guid.Empty)
            {
                return;
            }

            var now = DateTime.UtcNow;
            lock (gate)
            {
                if (pending.Count == 0)
                {
                    firstAdded = now;
                }

                lastAdded = now;
                if (!pending.TryGetValue(series, out var ids))
                {
                    pending[series] = ids = [];
                }

                ids.Add(episode.Id);
            }
        }
        catch (Exception ex)
        {
            // An event handler runs inside the library scan; it must never throw into it.
            Failed("note an added episode", ex);
        }
    }

    private bool FlushEpisodes(DateTime now)
    {
        Dictionary<Guid, HashSet<Guid>> batch;
        lock (gate)
        {
            if (pending.Count == 0 || (now - lastAdded < Quiet && now - firstAdded < MostWaiting))
            {
                return true;
            }

            batch = new Dictionary<Guid, HashSet<Guid>>(pending);
            pending.Clear();
        }

        var added = new Dictionary<Guid, (Series Series, List<Episode> Episodes)>();
        foreach (var (seriesId, ids) in batch)
        {
            if (library.GetItemById(seriesId) is not Series series)
            {
                continue;
            }

            var episodes = ids.Select(id => library.GetItemById(id)).OfType<Episode>().Where(e => !e.IsVirtualItem).ToList();
            if (episodes.Count > 0)
            {
                added[seriesId] = (series, episodes);
            }
        }

        if (added.Count == 0)
        {
            return true;
        }

        var clean = true;
        var cutoff = now.AddDays(-WatchingDays);
        var date = Clock.DateString(Clock.Today);
        var seriesIds = added.Keys.ToArray();
        foreach (var user in users.GetUsers().ToList())
        {
            var userId = user.Id.ToString("N");
            if (!store.GetPrefs(userId).Episodes)
            {
                continue;
            }

            try
            {
                // One user-scoped query for all the shows that gained episodes: the database filters to what this
                // person has played (and can see, which is the access check), and only that handful has its play date
                // read, in one batch. Asking each show about each of the user's items, or reading every episode's play
                // date to find the few that count, would scale with the library instead of with what was just added.
                var played = library.GetItemList(new InternalItemsQuery(user)
                {
                    IncludeItemTypes = [BaseItemKind.Episode],
                    Recursive = true,
                    IsPlayed = true,
                    IsVirtualItem = false,
                    AncestorIds = seriesIds,
                });
                if (played.Count == 0)
                {
                    continue;
                }

                var dates = userData.GetUserDataBatch(played, user);
                var watching = played
                    .OfType<Episode>()
                    .Where(e => dates.TryGetValue(e.Id, out var data) && data.LastPlayedDate >= cutoff)
                    .Select(e => e.SeriesId)
                    .ToHashSet();

                foreach (var seriesId in watching)
                {
                    if (added.TryGetValue(seriesId, out var entry))
                    {
                        WriteEpisodeNotice(user, userId, entry.Series, entry.Episodes, date, now);
                    }
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                clean = false;
                Failed("write episode notices", ex);
            }
        }

        return clean;
    }

    private void WriteEpisodeNotice(User user, string userId, Series series, List<Episode> episodes, string date, DateTime now)
    {
        var visible = episodes.Where(e => e.IsVisible(user)).Select(Ref).ToList();
        if (visible.Count == 0)
        {
            return;
        }

        // One notice per show per day: a second batch the same day adds to it rather than posting again.
        var key = $"episode:{series.Id:N}:{date}";
        var all = (store.DataOf(userId, key) is { } stored ? JsonSerializer.Deserialize<List<EpisodeRef>>(stored, Json) : null) ?? [];
        var ids = all.Select(e => e.Id).ToHashSet(StringComparer.Ordinal);
        all.AddRange(visible.Where(e => ids.Add(e.Id)));

        var (title, body) = NoticeText.Episodes(series.Name, all);
        var seriesId = series.Id.ToString("N");
        store.Add(
            userId,
            new NoticeDraft(
                NoticeKind.Episode,
                key,
                title,
                body,
                seriesId,
                seriesId,
                null,
                null,
                [seriesId, .. all.Select(e => e.Id).Take(MaxMarked)],
                JsonSerializer.Serialize(all, Json)),
            true,
            now);
    }

    private static EpisodeRef Ref(Episode e)
        => new(e.Id.ToString("N"), e.ParentIndexNumber, e.IndexNumber, e.IndexNumberEnd, e.Name);

    // ---------- arrivals -----------------------------------------------------------------------

    private bool WriteArrivals(DateTime now)
    {
        var hour = Math.Clamp(Plugin.Instance?.Configuration.ArrivalsHour ?? 18, 0, 23);
        var local = Clock.FromUtc(now);
        var today = Clock.DateString(local);
        // Once a day, from the chosen hour on. The day it last ran is kept, so a restart in the evening doesn't run it again.
        if (local.Hour < hour || store.Meta("arrivals") == today)
        {
            return true;
        }

        var since = now.AddHours(-24);
        var failed = false;
        foreach (var user in users.GetUsers().ToList())
        {
            var userId = user.Id.ToString("N");
            if (!store.GetPrefs(userId).Arrivals)
            {
                continue;
            }

            try
            {
                var added = library.GetItemList(new InternalItemsQuery(user)
                {
                    IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
                    Recursive = true,
                    IsVirtualItem = false,
                    // A new series by when it was first added, so a show gaining episodes isn't "new"; those are the episode notices.
                    MinDateCreated = since,
                    OrderBy = [(ItemSortBy.DateCreated, Jellyfin.Database.Implementations.Enums.SortOrder.Descending)],
                });
                if (added.Count == 0)
                {
                    continue;
                }

                var films = added.Count(i => i is not Series);
                var items = added
                    .Take(MaxListed)
                    .Select(i => new NoticeItem(i.Id.ToString("N"), i.Name, i is Series ? "Series" : "Movie"))
                    .ToList();
                var (title, body) = NoticeText.Arrivals(items, films, added.Count - films);
                store.Add(
                    userId,
                    new NoticeDraft(
                        NoticeKind.Arrivals,
                        $"arrivals:{today}",
                        title,
                        body,
                        null,
                        items[0].Id,
                        null,
                        items,
                        [.. added.Take(MaxMarked).Select(i => i.Id.ToString("N"))]),
                    false,
                    now);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                failed = true;
                Failed("write the daily summary", ex);
            }
        }

        // A user who failed is tried again next minute; those who didn't already have their notice, and the same key can't be written twice.
        if (!failed)
        {
            store.SetMeta("arrivals", today);
        }

        return !failed;
    }

    // ---------- upkeep -------------------------------------------------------------------------

    private bool Prune(DateTime now)
    {
        if (prunedOn.Date != now.Date)
        {
            // A failed prune waits for tomorrow like a done one: the table is small and the failure is already logged.
            prunedOn = now;
            store.Prune(now);
        }

        return true;
    }
}
