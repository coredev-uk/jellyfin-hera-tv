using System.Collections.Concurrent;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.HeraTv.Stats;

/// <summary>What the library knows about an item that history only has an id and a name for.</summary>
/// <param name="SeriesId">The series an episode belongs to; null for anything else.</param>
/// <param name="SeriesName">That series' current name.</param>
/// <param name="Genres">The item's genres; an episode's are its series'.</param>
internal sealed record ItemFacts(Guid? SeriesId, string? SeriesName, IReadOnlyList<string> Genres);

/// <summary>Looks items up in the library. A seam so the history can be shaped without a running server.</summary>
internal interface IItemCatalogue
{
    /// <summary>Gets the item's facts, or null when it is no longer in the library.</summary>
    ItemFacts? Find(Guid id);
}

/// <summary>
/// Looks items up in the library, and remembers what it found for <see cref="KeepFor"/>: the history
/// and the popular row ask about the same few hundred items on every request, and each lookup is a
/// database read (and, for an episode, another for its series).
/// </summary>
/// <remarks>
/// An item that wasn't there is remembered too, so a title that left the library isn't looked for on
/// every play. A change to an item's name or genres shows up within <see cref="KeepFor"/>.
/// </remarks>
internal sealed class ItemCatalogue(ILibraryManager libraryManager) : IItemCatalogue
{
    private static readonly TimeSpan KeepFor = TimeSpan.FromMinutes(10);

    /// <summary>More than this and expired entries are swept; a library's watched titles are far fewer.</summary>
    private const int SweepAbove = 4096;

    private readonly ConcurrentDictionary<Guid, (DateTime Expires, ItemFacts? Facts)> known = new();

    public ItemFacts? Find(Guid id)
    {
        if (id == Guid.Empty)
        {
            return null;
        }

        var now = DateTime.UtcNow;
        if (known.TryGetValue(id, out var hit) && hit.Expires > now)
        {
            return hit.Facts;
        }

        var facts = Look(id);
        if (known.Count > SweepAbove)
        {
            foreach (var stale in known.Where(e => e.Value.Expires <= now).Select(e => e.Key))
            {
                known.TryRemove(stale, out _);
            }
        }

        known[id] = (now + KeepFor, facts);
        return facts;
    }

    private ItemFacts? Look(Guid id)
    {
        if (libraryManager.GetItemById(id) is not { } item)
        {
            return null;
        }

        if (item is Episode episode)
        {
            var series = episode.Series;
            Guid? seriesId = episode.SeriesId == Guid.Empty ? null : episode.SeriesId;
            return new ItemFacts(seriesId, series?.Name ?? episode.SeriesName, series?.Genres ?? episode.Genres);
        }

        return new ItemFacts(null, null, item.Genres);
    }
}
