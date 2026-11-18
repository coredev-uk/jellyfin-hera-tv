using System.Globalization;
using System.Text;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Model.Entities;

namespace Jellyfin.Plugin.HeraTv.Collections;

/// <summary>The browse groups, in the order the Collections page lists them. Franchises are only grouped, never built.</summary>
internal enum CollectionGroup
{
    Franchises,
    Universes,
    Awards,
    Streaming,
    Seasonal,
    Homegrown,
    Decades,
    Genres,
    Studios,
    Networks,
    Certificates,
}

internal static class CollectionGroups
{
    public static readonly IReadOnlyList<CollectionGroup> InOrder = Enum.GetValues<CollectionGroup>();

    /// <summary>The group's id as the web client names it: the lower-case name.</summary>
    public static string Id(this CollectionGroup group) => group.ToString().ToLowerInvariant();

    /// <summary>The 1-based place in the browse order, which is also the number in a set's sort name.</summary>
    public static int Order(this CollectionGroup group) => (int)group + 1;

    /// <summary>Gets a value indicating whether Hera builds this group's sets (Franchises come from the TMDb Box Sets plugin).</summary>
    public static bool Builds(this CollectionGroup group) => group != CollectionGroup.Franchises;

    public static bool TryParse(string? id, out CollectionGroup group)
    {
        foreach (var candidate in InOrder)
        {
            if (string.Equals(candidate.Id(), id, StringComparison.Ordinal))
            {
                group = candidate;
                return true;
            }
        }

        group = default;
        return false;
    }

    /// <summary>Gets a value indicating whether the administrator has this group's sets switched on.</summary>
    public static bool Enabled(this CollectionGroup group, PluginConfiguration config) => group switch
    {
        CollectionGroup.Universes => config.CollectionsUniverses,
        CollectionGroup.Awards => config.CollectionsAwards,
        CollectionGroup.Streaming => config.CollectionsStreaming,
        CollectionGroup.Seasonal => config.CollectionsSeasonal,
        CollectionGroup.Homegrown => config.CollectionsHomegrown,
        CollectionGroup.Decades => config.CollectionsDecades,
        CollectionGroup.Genres => config.CollectionsGenres,
        CollectionGroup.Studios => config.CollectionsStudios,
        CollectionGroup.Networks => config.CollectionsNetworks,
        CollectionGroup.Certificates => config.CollectionsCertificates,
        _ => false,
    };

    /// <summary>Switches a group's sets on or off in the configuration. Franchises have no switch.</summary>
    public static void Set(this CollectionGroup group, PluginConfiguration config, bool on)
    {
        switch (group)
        {
            case CollectionGroup.Universes: config.CollectionsUniverses = on; break;
            case CollectionGroup.Awards: config.CollectionsAwards = on; break;
            case CollectionGroup.Streaming: config.CollectionsStreaming = on; break;
            case CollectionGroup.Seasonal: config.CollectionsSeasonal = on; break;
            case CollectionGroup.Homegrown: config.CollectionsHomegrown = on; break;
            case CollectionGroup.Decades: config.CollectionsDecades = on; break;
            case CollectionGroup.Genres: config.CollectionsGenres = on; break;
            case CollectionGroup.Studios: config.CollectionsStudios = on; break;
            case CollectionGroup.Networks: config.CollectionsNetworks = on; break;
            case CollectionGroup.Certificates: config.CollectionsCertificates = on; break;
        }
    }

    /// <summary>The name a set's sort name carries, so native apps list Hera's sets together, in group order, after the user's own.</summary>
    public static string SortName(CollectionGroup group, string name)
        => string.Create(CultureInfo.InvariantCulture, $"~{group.Order():00} {group} {name}");
}

/// <summary>What the rules need to know about one film or series, read once from the library item.</summary>
internal sealed class Title
{
    private Title(BaseItem item)
    {
        Item = item;
        IsSeries = item is Series;
        Tmdb = item.TryGetProviderId(MetadataProvider.Tmdb, out var id) && !string.IsNullOrEmpty(id) ? id : null;
        Key = Tmdb is null ? string.Empty : Keys.Of(IsSeries, Tmdb);
        Year = item.ProductionYear ?? item.PremiereDate?.Year;
        Premiere = item.PremiereDate;
        Rating = item.CommunityRating ?? 0f;
        Genres = GenreNames.Normalise(item.Genres);
        Tags = new HashSet<string>(item.Tags.Select(t => t.Trim().ToLowerInvariant()), StringComparer.Ordinal);
        Studios = item.Studios;
        British = item.ProductionLocations.Any(l => l.Contains("United Kingdom", StringComparison.OrdinalIgnoreCase));
        Certificate = UkCertificate.From(item.OfficialRating);
    }

    public BaseItem Item { get; }

    public Guid Id => Item.Id;

    public string Name => Item.Name;

    public bool IsSeries { get; }

    public string? Tmdb { get; }

    /// <summary>Gets <c>movie:603</c> or <c>tv:1396</c>, the form snapshots, Seerr's data and the rules match on; empty without a TMDB id.</summary>
    public string Key { get; }

    public int? Year { get; }

    public DateTime? Premiere { get; }

    /// <summary>Gets the community rating (TMDB's vote average); 0 when there is none.</summary>
    public float Rating { get; }

    public IReadOnlyList<string> Genres { get; }

    /// <summary>Gets the TMDB keywords, lower-cased.</summary>
    public IReadOnlySet<string> Tags { get; }

    public IReadOnlyList<string> Studios { get; }

    public bool British { get; }

    /// <summary>Gets the BBFC-style certificate (U, PG, 12A, 12, 15, 18), US ratings mapped across; null when unrated or unknown.</summary>
    public string? Certificate { get; }

    public static Title From(BaseItem item) => new(item);

    /// <summary>Reads the films and series in a query's result.</summary>
    public static List<Title> From(IEnumerable<BaseItem> items)
        => [.. items.Where(i => i is Movie or Series).Select(From)];

    public bool HasTag(params string[] tags) => tags.Any(Tags.Contains);

    public bool HasTagStarting(string prefix) => Tags.Any(t => t.StartsWith(prefix, StringComparison.Ordinal));
}

internal static class Keys
{
    public static string Of(bool series, string tmdb) => (series ? "tv:" : "movie:") + tmdb;

    public static string Of(string type, int tmdb)
        => Of(string.Equals(type, "tv", StringComparison.OrdinalIgnoreCase), tmdb.ToString(CultureInfo.InvariantCulture));

    /// <summary>Lower-case, hyphen-separated: a name made safe to sit in an id.</summary>
    public static string Slug(string name)
    {
        var text = new StringBuilder(name.Length);
        foreach (var c in name.Normalize(NormalizationForm.FormD))
        {
            if (char.IsAsciiLetterOrDigit(c))
            {
                text.Append(char.ToLowerInvariant(c));
            }
            else if (CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark && text.Length > 0 && text[^1] != '-')
            {
                text.Append('-');
            }
        }

        return text.ToString().Trim('-');
    }

    /// <summary>A stable hash for seeding a rotation. string.GetHashCode is different in every process, which would reshuffle on each restart.</summary>
    public static int Stable(string text)
    {
        var hash = 2166136261u;
        foreach (var c in text)
        {
            hash = (hash ^ c) * 16777619u;
        }

        return (int)(hash & 0x7fffffff);
    }
}

/// <summary>TMDB names TV genres differently from film ones; the rules and the browse page want one list.</summary>
internal static class GenreNames
{
    private static readonly Dictionary<string, string[]> Split = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Sci-Fi & Fantasy"] = ["Science Fiction", "Fantasy"],
        ["Action & Adventure"] = ["Action", "Adventure"],
        ["War & Politics"] = ["War"],
        ["Kids"] = ["Family"],
    };

    public static IReadOnlyList<string> Normalise(IEnumerable<string> genres)
    {
        var names = new List<string>();
        foreach (var genre in genres)
        {
            foreach (var name in Split.TryGetValue(genre.Trim(), out var parts) ? parts : [genre.Trim()])
            {
                if (name.Length > 0 && !names.Contains(name, StringComparer.OrdinalIgnoreCase))
                {
                    names.Add(name);
                }
            }
        }

        return names;
    }
}

/// <summary>
/// Certificates as people here read them. Jellyfin stores them as <c>GB-15</c>; US ones are mapped
/// onto the nearest UK band, as Kometa's content_rating_uk does, so a library of mixed metadata
/// still lands in one set per band.
/// </summary>
internal static class UkCertificate
{
    /// <summary>The bands, lightest first: the order the Certificates group lists them in. 12 and 12A share a set.</summary>
    public static readonly string[] Bands = ["U", "PG", "12", "15", "18"];

    public static string? From(string? rating)
    {
        if (string.IsNullOrWhiteSpace(rating))
        {
            return null;
        }

        var text = rating.Trim().ToUpperInvariant();
        if (text.StartsWith("GB-", StringComparison.Ordinal))
        {
            text = text[3..];
        }

        return text switch
        {
            "U" or "G" or "TV-Y" or "TV-Y7" or "TV-G" => "U",
            "PG" or "TV-PG" => "PG",
            "12" or "12A" or "PG-13" => "12",
            "15" or "R" or "TV-14" => "15",
            "18" or "R18" or "NC-17" or "TV-MA" or "X" => "18",
            _ => null,
        };
    }
}
