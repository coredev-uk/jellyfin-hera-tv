using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.HeraTv.Collections;

/// <summary>
/// Chooses which member's art stands for each set in a run. Left alone, every set that holds the
/// library's best-rated title would show that title's poster; here each set takes its best member
/// whose art no earlier set has used, and falls back to its best member only when every candidate
/// is taken.
/// </summary>
/// <remarks>
/// It is deterministic: the choice depends only on the order the sets are offered in, on each set's
/// members and on their ratings, so an unchanged library gives unchanged art. The builder and the
/// browse page both offer sets in sort-name order, so the page's fallback art matches what was built.
/// </remarks>
internal sealed class ArtPicker
{
    private readonly HashSet<Guid> _primary = [];
    private readonly HashSet<Guid> _backdrop = [];

    /// <summary>
    /// Picks the member whose <paramref name="type"/> image represents a set, and marks it used.
    /// Null when no member has that image.
    /// </summary>
    public BaseItem? Pick(IEnumerable<BaseItem> members, ImageType type)
    {
        var candidates = members
            .Where(m => m.GetImageInfo(type, 0) is { Path.Length: > 0 })
            .OrderByDescending(m => m.CommunityRating ?? 0f)
            .ThenBy(m => m.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
        if (candidates.Count == 0)
        {
            return null;
        }

        var used = type == ImageType.Backdrop ? _backdrop : _primary;
        var chosen = candidates.FirstOrDefault(m => !used.Contains(m.Id)) ?? candidates[0];
        used.Add(chosen.Id);
        return chosen;
    }
}
