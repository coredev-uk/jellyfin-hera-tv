using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>Finds a user's films and shows by TMDB id, honouring that user's library access.</summary>
public sealed class LibraryLookup(ILibraryManager libraryManager)
{
    // A cold Discover page asks about a dozen titles at once: they share one build per person. A minute,
    // no longer: the notification poll, five minutes apart, must see a title imported since its last one.
    private readonly UserCache<Dictionary<string, BaseItem>> _byUser = new(TimeSpan.FromMinutes(1));

    /// <summary>Gets the user's item for a TMDB id and kind ("movie" or "tv"), or null.</summary>
    public BaseItem? Find(User user, string mediaType, string? tmdbId)
    {
        if (string.IsNullOrEmpty(tmdbId))
        {
            return null;
        }

        return Index(user).GetValueOrDefault(Key(mediaType, tmdbId));
    }

    private static string Key(string mediaType, string tmdbId) => $"{(mediaType == "tv" ? "tv" : "movie")}:{tmdbId}";

    // The household library is small: one pass over every film and show, kept for a minute and
    // built once however many lookups ask while it is cold, answers every lookup a page makes.
    private Dictionary<string, BaseItem> Index(User user)
        => _byUser.Get(user.Id, () =>
        {
            var items = libraryManager.GetItemList(new InternalItemsQuery(user)
            {
                IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
                Recursive = true,
                IsVirtualItem = false,
            });

            var index = new Dictionary<string, BaseItem>(StringComparer.Ordinal);
            foreach (var item in items)
            {
                if (item.TryGetProviderId(MetadataProvider.Tmdb, out var tmdb) && !string.IsNullOrEmpty(tmdb))
                {
                    index.TryAdd(Key(item is MediaBrowser.Controller.Entities.TV.Series ? "tv" : "movie", tmdb), item);
                }
            }

            return index;
        });
}
