using System.Collections.Concurrent;
using System.Globalization;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.HeraTv.Stats;
using MediaBrowser.Controller.Drawing;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.HeraTv.Collections;

/// <summary>What the web client shows of collections: the grouped Collections page and today's home rows.</summary>
public interface ICollectionsView
{
    /// <summary>Gets the groups and collections this person can see, as <c>{ groups: [...] }</c>.</summary>
    object Groups(User user);

    /// <summary>Gets today's home rows for this person, as <c>{ rows: [...] }</c>.</summary>
    object Rows(User user);

    /// <summary>
    /// Gets the film that follows <paramref name="itemId"/> in a franchise collection (the TMDb Box
    /// Sets plugin's), skipping any already watched, as <c>{ id, collection }</c>; null when the film
    /// is in none or is the last unwatched one.
    /// </summary>
    object? NextInCollection(User user, Guid itemId);

    /// <summary>Forgets what was cached, so the next read sees a new build.</summary>
    void Clear();
}

/// <summary>
/// Reads collections and builds the home rows for one person. Everything is filtered to what that
/// person can see: the pool of titles, a set's count, the art offered for a set and a row's titles
/// all come from their own library view, so a household with different access sees different shelves.
/// </summary>
/// <remarks>
/// Rotation (which genre, which service, which decade) is deterministic and changes daily: it is
/// seeded with the server's local date, so a refresh or a second device shows the same rows, and
/// tomorrow shows different ones.
/// </remarks>
internal sealed class CollectionsView(
    ILibraryManager libraryManager,
    IUserDataManager userDataManager,
    IImageProcessor imageProcessor,
    Catalogue catalogue,
    StreamingCache streaming,
    PlaybackReportingSource playbackReporting,
    IItemCatalogue itemCatalogue) : ICollectionsView
{
    private static readonly TimeSpan GroupsFor = TimeSpan.FromMinutes(5);
    private static readonly TimeSpan RowsFor = TimeSpan.FromMinutes(10);

    private const int RowSize = 12;
    private const int RowMinimum = 3;
    private const int NewDays = 120;
    private const int PopularDays = 30;
    private const int RatedItems = 8; // The fewest titles at RatedRating or above for the row to show.
    private const float RatedRating = 7.5f;
    private const int StreamingMinimum = 6;
    private const int GenreRows = 2;
    private const int DecadeMinimum = 6;
    private const int AwardsMinimum = 4;
    private const int HomegrownMinimum = 6;

    private readonly ConcurrentDictionary<Guid, (DateTime Expires, object Value)> _groups = new();
    private readonly ConcurrentDictionary<Guid, (DateTime Expires, object Value)> _rows = new();
    private readonly Lock _popularGate = new();
    private (DateTime Expires, IReadOnlyList<Guid> Ids)? _popular;

    public void Clear()
    {
        _groups.Clear();
        _rows.Clear();
    }

    // ---------- groups ----------------------------------------------------------------------

    public object Groups(User user)
    {
        if (_groups.TryGetValue(user.Id, out var hit) && hit.Expires > DateTime.UtcNow)
        {
            return hit.Value;
        }

        var found = new List<(BoxSet Set, CollectionGroup Group, List<BaseItem> Members)>();
        foreach (var set in VisibleBoxSets(user))
        {
            CollectionGroup group;
            var id = CollectionBuilder.DefinitionId(set);
            if (CollectionBuilder.IsHera(set))
            {
                // The definition id starts with its group's id: "genres:comedy". A set whose group
                // isn't one Hera builds is left out rather than guessed at.
                if (id is null || !CollectionGroups.TryParse(id.Split(':')[0], out group) || !group.Builds())
                {
                    continue;
                }
            }
            else if (set.TryGetProviderId(MetadataProvider.Tmdb, out var tmdb) && !string.IsNullOrEmpty(tmdb))
            {
                // The TMDb Box Sets plugin's franchises: only grouped, never changed. Any other
                // BoxSet has no group and stays in Jellyfin's own grid.
                group = CollectionGroup.Franchises;
            }
            else
            {
                continue;
            }

            var members = set.GetChildren(user, true, null).Where(c => c is Movie or MediaBrowser.Controller.Entities.TV.Series).ToList();
            if (members.Count > 0)
            {
                found.Add((set, group, members));
            }
        }

        // Fallback art is picked the way the builder picks a set's own art: sets in sort-name order, each
        // taking its best member whose art no earlier set has. Hera's sets share one picker; the
        // franchises, which the builder never touches, have their own so they don't use Hera's choices up.
        var heraArt = new ArtPicker();
        var franchiseArt = new ArtPicker();
        var logos = streaming.Current?.Logos;
        var byGroup = new Dictionary<CollectionGroup, List<(string Sort, object Entry)>>();
        foreach (var (set, group, members) in found.OrderBy(f => CollectionGroups.SortName(f.Group, f.Set.Name), StringComparer.Ordinal))
        {
            var picker = group == CollectionGroup.Franchises ? franchiseArt : heraArt;
            // A streaming set's definition id is "streaming:<provider key>"; its logo goes with it.
            var logo = group == CollectionGroup.Streaming
                && CollectionBuilder.DefinitionId(set)?.Split(':') is [_, var key]
                && logos?.TryGetValue(key, out var found2) == true
                    ? new { wordmark = found2!.Wordmark, icon = found2.Icon }
                    : null;
            var entry = new
            {
                id = Plain(set.Id),
                name = set.Name,
                count = members.Count,
                kind = members.All(m => m is Movie) ? "movie" : members.All(m => m is MediaBrowser.Controller.Entities.TV.Series) ? "series" : "mixed",
                // A member's own art, for a set that has none of its own yet.
                imageId = picker.Pick(members, ImageType.Primary) is { } p ? Plain(p.Id) : null,
                backdropId = picker.Pick(members, ImageType.Backdrop) is { } b ? Plain(b.Id) : null,
                // TMDB image paths for the service's wordmark and app icon; null for other groups.
                logo,
            };
            if (!byGroup.TryGetValue(group, out var list))
            {
                byGroup[group] = list = [];
            }

            list.Add((set.Name, entry));
        }

        var value = new
        {
            groups = CollectionGroups.InOrder
                .Where(byGroup.ContainsKey)
                .Select(g => new
                {
                    id = g.Id(),
                    title = g.ToString(),
                    collections = byGroup[g].OrderBy(e => e.Sort, StringComparer.OrdinalIgnoreCase).Select(e => e.Entry).ToArray(),
                })
                .ToArray(),
        };
        _groups[user.Id] = (DateTime.UtcNow + GroupsFor, value);
        return value;
    }

    /// <summary>Every BoxSet this person can open, read without a user filter and then checked against their access.</summary>
    private List<BoxSet> VisibleBoxSets(User user)
        => [.. libraryManager.GetItemList(new InternalItemsQuery { IncludeItemTypes = [BaseItemKind.BoxSet], Recursive = true })
            .OfType<BoxSet>()
            .Where(b => b.IsVisible(user))];

    // ---------- next in a collection ---------------------------------------------------------

    public object? NextInCollection(User user, Guid itemId)
    {
        // Only the TMDb Box Sets plugin's franchises run in an order; Hera's own sets are groupings.
        foreach (var set in VisibleBoxSets(user).Where(s => !CollectionBuilder.IsHera(s)))
        {
            var films = set.GetChildren(user, true, null)
                .OfType<Movie>()
                .OrderBy(f => f.PremiereDate ?? (f.ProductionYear is int year ? new DateTime(year, 1, 1) : DateTime.MaxValue))
                .ToList();
            var index = films.FindIndex(f => f.Id == itemId);
            if (index < 0)
            {
                continue;
            }

            var next = films.Skip(index + 1).FirstOrDefault(f => !IsPlayed(user, f));
            return next is null ? null : new { id = Plain(next.Id), collection = set.Name };
        }

        return null;
    }

    // ---------- rows ------------------------------------------------------------------------

    public object Rows(User user)
    {
        if (_rows.TryGetValue(user.Id, out var hit) && hit.Expires > DateTime.UtcNow)
        {
            return hit.Value;
        }

        var value = new { rows = Plugin.Instance?.Configuration.HomeRowsEnabled == false ? Array.Empty<object>() : BuildRows(user) };
        _rows[user.Id] = (DateTime.UtcNow + RowsFor, value);
        return value;
    }

    private object[] BuildRows(User user)
    {
        var pool = Title.From(libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
            Recursive = true,
            IsVirtualItem = false,
        }));
        var played = pool.Where(t => IsPlayed(user, t.Item)).Select(t => t.Id).ToHashSet();
        var today = DateOnly.FromDateTime(Clock.Today);
        var day = today.DayNumber;

        streaming.RefreshIfStale();
        var snapshot = streaming.Current;
        var definitions = catalogue.Build(pool, snapshot);
        var members = new Dictionary<string, List<Title>>(StringComparer.Ordinal);
        List<Title> MembersOf(Definition d) => members.TryGetValue(d.Id, out var found) ? found : members[d.Id] = d.Members(pool);

        // A row opens the BoxSet Hera built for it when this person can see one.
        var sets = new Dictionary<string, Guid>(StringComparer.Ordinal);
        foreach (var set in VisibleBoxSets(user).Where(CollectionBuilder.IsHera))
        {
            if (CollectionBuilder.DefinitionId(set) is { } id)
            {
                sets.TryAdd(id, set.Id);
            }
        }

        var rows = new List<object>();
        void Add(string id, string title, string? setId, IEnumerable<Title> items, bool shuffle = false)
        {
            var ordered = shuffle ? Shuffle(items, Keys.Stable(id) ^ day) : [.. items];
            // Titles already watched go last, in the order they had; 12 is a row's worth.
            var picked = ordered.Where(t => !played.Contains(t.Id)).Concat(ordered.Where(t => played.Contains(t.Id))).Take(RowSize).ToArray();
            if (picked.Length == 0)
            {
                return;
            }

            rows.Add(new
            {
                id,
                title,
                href = setId is not null && sets.TryGetValue(setId, out var boxSet) ? $"#/details?id={Plain(boxSet)}" : null,
                items = picked.Select(Item).ToArray(),
            });
        }

        // The season that is on, if any: the one with the most titles.
        var season = definitions
            .Where(d => d.Group == CollectionGroup.Seasonal && d.Window is not null && d.InSeason(today))
            .Select(d => (Definition: d, Members: MembersOf(d)))
            .Where(s => s.Members.Count >= s.Definition.Min)
            .OrderByDescending(s => s.Members.Count)
            .FirstOrDefault();
        if (season.Definition is not null)
        {
            Add(season.Definition.Id, season.Definition.Name, season.Definition.Id, season.Members);
        }

        var recent = pool
            .Where(t => t.Premiere is { } p && p.ToLocalTime().Date <= today.ToDateTime(TimeOnly.MinValue) && p.ToLocalTime().Date >= today.AddDays(-NewDays).ToDateTime(TimeOnly.MinValue))
            .OrderByDescending(t => t.Premiere)
            .ToList();
        if (recent.Count >= RowMinimum)
        {
            Add("new", "Newly Released", null, recent);
        }

        var popular = PopularIds();
        var byId = pool.ToDictionary(t => t.Id);
        var popularTitles = popular.Where(byId.ContainsKey).Select(id => byId[id]).ToList();
        if (popularTitles.Count >= RowMinimum)
        {
            Add("popular", "Popular This Month", null, popularTitles);
        }

        var rated = pool.Where(t => t.Rating >= RatedRating).ToList();
        if (rated.Count >= RatedItems)
        {
            Add("rated", "Highly Rated in Your Library", null, rated, shuffle: true);
        }

        // TMDB's trending, by Seerr, as far as this library has them. Home only; never a BoxSet, since it changes by the day.
        if (snapshot is not null)
        {
            var byKey = pool.Where(t => t.Key.Length > 0).GroupBy(t => t.Key).ToDictionary(g => g.Key, g => g.First());
            var trending = snapshot.Trending.Where(byKey.ContainsKey).Select(k => byKey[k]).ToList();
            if (trending.Count >= RowMinimum)
            {
                Add("charts", "Trending Now", null, trending);
            }
        }

        // One streaming service: of those with enough you haven't watched, a different one each day.
        var services = definitions
            .Where(d => d.Group == CollectionGroup.Streaming)
            .Select(d => (Definition: d, Members: MembersOf(d)))
            .Select(s => (s.Definition, s.Members, Unwatched: s.Members.Count(t => !played.Contains(t.Id))))
            .Where(s => s.Unwatched >= StreamingMinimum)
            .OrderByDescending(s => s.Unwatched)
            .ThenBy(s => s.Definition.Id, StringComparer.Ordinal)
            .ToList();
        if (services.Count > 0)
        {
            var service = services[day % services.Count];
            Add(service.Definition.Id, service.Definition.Name, service.Definition.Id, service.Members, shuffle: true);
        }

        // Two genres, picked by a date-seeded order so they change daily but not between refreshes.
        var genres = definitions
            .Where(d => d.Group == CollectionGroup.Genres)
            .Select(d => (Definition: d, Members: MembersOf(d)))
            .Where(g => g.Members.Count >= g.Definition.Min)
            .OrderBy(g => Keys.Stable(g.Definition.Id + day.ToString(CultureInfo.InvariantCulture)))
            .Take(GenreRows);
        foreach (var genre in genres)
        {
            Add($"genre:{genre.Definition.Id[(genre.Definition.Id.IndexOf(':') + 1)..]}", genre.Definition.Name, genre.Definition.Id, genre.Members, shuffle: true);
        }

        var decades = definitions
            .Where(d => d.Group == CollectionGroup.Decades)
            .Select(d => (Definition: d, Members: MembersOf(d)))
            .Where(d => d.Members.Count >= DecadeMinimum)
            .ToList();
        if (decades.Count > 0)
        {
            var decade = decades[day % decades.Count];
            Add($"decade:{decade.Definition.Id[(decade.Definition.Id.IndexOf(':') + 1)..]}", decade.Definition.Name, decade.Definition.Id, decade.Members);
        }

        // BAFTA and Oscar winners: one list a day, of those with enough in the library.
        var awards = definitions
            .Where(d => d.Group == CollectionGroup.Awards)
            .Select(d => (Definition: d, Members: MembersOf(d)))
            .Where(a => a.Members.Count >= AwardsMinimum)
            .ToList();
        if (awards.Count > 0)
        {
            var award = awards[day % awards.Count];
            Add(award.Definition.Id, award.Definition.Name, award.Definition.Id, award.Members, shuffle: true);
        }

        var homegrown = definitions.FirstOrDefault(d => d.Id == "homegrown:british");
        if (homegrown is not null && MembersOf(homegrown) is { } british && british.Count >= HomegrownMinimum)
        {
            Add("homegrown", "Homegrown", homegrown.Id, british, shuffle: true);
        }

        return [.. rows];
    }

    private object Item(Title title)
    {
        var primary = title.Item.GetImageInfo(ImageType.Primary, 0);
        return new
        {
            id = Plain(title.Id),
            name = title.Name,
            type = title.IsSeries ? "Series" : "Movie",
            year = title.Year,
            imageTags = primary is null ? null : new { Primary = imageProcessor.GetImageCacheTag(title.Item, primary) },
        };
    }

    private bool IsPlayed(User user, BaseItem item)
    {
        var data = userDataManager.GetUserData(user, item);
        return data is not null && item.IsPlayed(user, data);
    }

    private static List<Title> Shuffle(IEnumerable<Title> items, int seed)
    {
        var list = items.ToList();
        var random = new Random(seed);
        for (var i = list.Count - 1; i > 0; i--)
        {
            var j = random.Next(i + 1);
            (list[i], list[j]) = (list[j], list[i]);
        }

        return list;
    }

    /// <summary>The most-played titles of the last 30 days across everyone, most played first; episodes count towards their series.</summary>
    private IReadOnlyList<Guid> PopularIds()
    {
        lock (_popularGate)
        {
            if (_popular is { } hit && hit.Expires > DateTime.UtcNow)
            {
                return hit.Ids;
            }

            var ids = new List<Guid>();
            if (playbackReporting.Read(Clock.Today.AddDays(-PopularDays), null) is { } plays)
            {
                var tally = new Dictionary<Guid, (int Plays, long Seconds)>();
                foreach (var play in plays)
                {
                    if (!Guid.TryParse(play.ItemId, out var item) || itemCatalogue.Find(item) is not { } facts)
                    {
                        continue;
                    }

                    var title = facts.SeriesId ?? item;
                    tally[title] = tally.TryGetValue(title, out var so) ? (so.Plays + 1, so.Seconds + play.Seconds) : (1, play.Seconds);
                }

                ids = [.. tally.OrderByDescending(t => t.Value.Plays).ThenByDescending(t => t.Value.Seconds).Select(t => t.Key)];
            }

            _popular = (DateTime.UtcNow + RowsFor, ids);
            return ids;
        }
    }

    private static string Plain(Guid id) => id.ToString("N", CultureInfo.InvariantCulture);
}
