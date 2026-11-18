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

internal sealed class ItemCatalogue(ILibraryManager libraryManager) : IItemCatalogue
{
    public ItemFacts? Find(Guid id)
    {
        if (id == Guid.Empty || libraryManager.GetItemById(id) is not { } item)
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
