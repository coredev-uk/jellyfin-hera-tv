namespace Jellyfin.Plugin.HeraTv.Collections;

/// <summary>One collection Hera can build: what it is called, where it belongs and which titles are in it.</summary>
/// <param name="Id">Stable and unique, <c>&lt;group&gt;:&lt;slug&gt;</c>. It is what the set's <c>hera-tv:&lt;id&gt;</c> tag carries, so changing one orphans the set it built.</param>
/// <param name="Name">What the set is called, here and in native apps.</param>
/// <param name="Group">Where it sits on the Collections page.</param>
/// <param name="Matches">Whether a title belongs.</param>
internal sealed record Definition(string Id, string Name, CollectionGroup Group, Func<Title, bool> Matches)
{
    /// <summary>Gets the fewest titles a set must have to exist; below this it is deleted.</summary>
    public int Min { get; init; } = 2;

    /// <summary>Gets the most titles kept, best rated first; null keeps every match.</summary>
    public int? Best { get; init; }

    /// <summary>Gets when the set exists; null means always.</summary>
    public Window? Window { get; init; }

    /// <summary>Gets a sentence for the set's overview in native apps.</summary>
    public string? Summary { get; init; }

    public bool InSeason(DateOnly today) => Window?.Contains(today) ?? true;

    /// <summary>The titles in the pool that belong, best rated first (ties by name).</summary>
    public List<Title> Members(IEnumerable<Title> pool)
    {
        var members = pool.Where(Matches).OrderByDescending(t => t.Rating).ThenBy(t => t.Name, StringComparer.OrdinalIgnoreCase);
        return Best is int best ? [.. members.Take(best)] : [.. members];
    }
}

/// <summary>
/// Every collection Hera knows how to build. This is the one place to edit: the fixed sets are
/// written out below as data, and the faceted ones (genres, decades, studios, networks,
/// certificates, streaming services) are generated from what the library actually holds.
/// </summary>
/// <remarks>
/// It mirrors Kometa's set on the household's Plex, minus what needs data the library doesn't have:
/// IMDb votes become <see cref="Title.Rating"/> floors, IMDb lists become TMDB keyword tags and the
/// snapshots in Collections/Data, and US-only holidays are left out.
/// </remarks>
internal sealed class Catalogue(Snapshots snapshots)
{
    private const int GenreMinimum = 8;
    private const int DecadeMinimum = 6;
    private const int DecadeBest = 50;
    private const int StudioMinimum = 5;
    private const int NetworkMinimum = 3;

    // ---------- fixed sets, as data ---------------------------------------------------------

    /// <summary>
    /// Seasonal sets: when they exist, which TMDB keywords put a title in, and the curated list that
    /// adds to them. Windows follow Kometa's seasonal defaults and the household's UK additions;
    /// Easter, Mothering Sunday and Father's Day move, so they are computed rather than dated.
    /// </summary>
    private static readonly Season[] Seasons =
    [
        new("new-year", "New Year", Window.Fixed(12, 26, 1, 4), t => t.HasTag("new year's eve", "new year's day", "new year", "new years eve")),
        new("valentines-day", "Valentine's Day", Window.Fixed(2, 1, 2, 29), t => t.HasTag("valentine's day", "valentine", "valentines day")),
        new("st-patricks-day", "St Patrick's Day", Window.Fixed(3, 12, 3, 18), t => t.Rating >= 6.5f && (t.HasTag("ireland", "irish", "dublin, ireland", "st. patrick's day", "saint patrick's day", "leprechaun") || t.Item.ProductionLocations.Any(l => l.Contains("Ireland", StringComparison.OrdinalIgnoreCase)))),
        new("mothering-sunday", "Mothering Sunday", Window.Around(Calendar.MotheringSunday, 14, 0), t => t.Rating >= 6.5f && t.HasTag("motherhood", "mother", "mother's day", "mother daughter relationship", "mother son relationship", "pregnancy")),
        new("easter", "Easter", Window.Around(Calendar.Easter, 14, 1), t => t.HasTag("easter", "easter bunny", "easter egg hunt")),
        new("fathers-day", "Father's Day", Window.Around(Calendar.FathersDay, 7, 0), t => t.Rating >= 6.5f && t.HasTag("fatherhood", "father's day", "father son relationship", "father daughter relationship")),
        new("halloween", "Halloween", Window.Fixed(10, 1, 10, 31), t => t.HasTagStarting("halloween") || t.HasTag("haunted house", "trick or treating"), "halloween-classics"),
        new("bonfire-night", "Bonfire Night", Window.Fixed(10, 25, 11, 6), t => t.HasTag("guy fawkes", "gunpowder plot", "bonfire night", "fireworks") || (t.Rating >= 7f && t.Genres.Contains("Thriller", StringComparer.OrdinalIgnoreCase)), "bonfire-night"),
        new("remembrance", "Remembrance", Window.Fixed(10, 29, 11, 12), t => t.HasTag("remembrance day", "armistice day", "remembrance sunday") || (t.Rating >= 7f && t.Genres.Contains("War", StringComparer.OrdinalIgnoreCase))),
        new("christmas", "Christmas", Window.Fixed(12, 1, 12, 31), t => t.HasTagStarting("christmas") || t.HasTag("santa claus"), "christmas-classics"),
    ];

    /// <summary>
    /// Homegrown: British-made titles. Kometa's IMDb vote counts become <see cref="Title.Rating"/>
    /// floors, with the same ratings; TMDB's average runs a little below IMDb's, so a floor here is the
    /// stricter test.
    /// </summary>
    private static readonly Definition[] Homegrown =
    [
        new("homegrown:british", "Homegrown", CollectionGroup.Homegrown, t => t.British) { Min = 6, Summary = "Films and series made in the United Kingdom." },
        new("homegrown:classic-cinema", "Classic Cinema", CollectionGroup.Homegrown, t => t.British && !t.IsSeries && t.Year < 1990 && t.Rating >= 7.5f) { Summary = "Essential homegrown films from before 1990." },
        new("homegrown:contemporary-cinema", "Contemporary Cinema", CollectionGroup.Homegrown, t => t.British && !t.IsSeries && t.Year >= 1990 && t.Rating >= 7f) { Summary = "The best of homegrown filmmaking from 1990 onwards." },
        new("homegrown:comedy-greats", "Comedy Greats", CollectionGroup.Homegrown, t => t.British && t.Genres.Contains("Comedy", StringComparer.OrdinalIgnoreCase) && t.Rating >= (t.IsSeries ? 7.5f : 7f)) { Summary = "Great British comedy, film and television." },
        new("homegrown:crime-drama", "Crime Drama", CollectionGroup.Homegrown, t => t.British && t.IsSeries && t.Genres.Contains("Crime", StringComparer.OrdinalIgnoreCase) && t.Rating >= 7.5f) { Summary = "The finest British crime drama." },
    ];

    // ---------- the whole catalogue ----------------------------------------------------------

    /// <summary>
    /// Builds every definition for a pool of titles, in browse order. The pool decides which
    /// facets exist (a genre nobody has gets no set), so the same call serves the builder, with the
    /// whole library, and a person's home rows, with what they can see.
    /// </summary>
    /// <param name="pool">The titles in play.</param>
    /// <param name="streaming">Where they stream; null when Seerr has never answered, which leaves the Streaming group empty.</param>
    public IReadOnlyList<Definition> Build(IReadOnlyList<Title> pool, StreamingSnapshot? streaming)
    {
        var all = new List<Definition>();
        all.AddRange(Curated());
        all.AddRange(StreamingServices(streaming));
        all.AddRange(SeasonalSets());
        all.AddRange(Homegrown);
        all.AddRange(Decades());
        all.AddRange(Genres(pool));
        all.AddRange(Studios(pool));
        all.AddRange(Networks(pool));
        all.AddRange(Certificates());

        // Ids are the sets' identity: a clash would have two definitions fighting over one BoxSet.
        var seen = new HashSet<string>(StringComparer.Ordinal);
        return [.. all.Where(d => seen.Add(d.Id)).OrderBy(d => d.Group)];
    }

    /// <summary>Awards and universes: titles matched by TMDB id against the compiled-in lists.</summary>
    private IEnumerable<Definition> Curated()
    {
        foreach (var snapshot in snapshots.All.Where(s => s.Group.Builds() && s.Group != CollectionGroup.Seasonal))
        {
            var keys = snapshot.Keys;
            yield return new Definition($"{snapshot.Group.Id()}:{snapshot.Id}", snapshot.Name, snapshot.Group, t => keys.Contains(t.Key))
            {
                Summary = snapshot.Source is null ? null : $"From {snapshot.Source}. Updated {snapshot.Updated}.",
            };
        }
    }

    private static IEnumerable<Definition> StreamingServices(StreamingSnapshot? streaming)
    {
        if (streaming is null)
        {
            yield break;
        }

        // The providers were read for the server's streaming region (Settings: Streaming region).
        var where = streaming.Region.Equals("GB", StringComparison.OrdinalIgnoreCase) ? "the UK" : RegionName(streaming.Region);
        foreach (var provider in StreamingProvider.All)
        {
            yield return new Definition($"streaming:{provider.Key}", $"On {provider.Name}", CollectionGroup.Streaming, t => streaming.Has(provider, t.Key))
            {
                Summary = $"What you have that streams on {provider.Name} in {where}.",
            };
        }
    }

    private static string RegionName(string code)
    {
        try
        {
            return new System.Globalization.RegionInfo(code).EnglishName;
        }
        catch (ArgumentException)
        {
            return code;
        }
    }

    /// <summary>The seasonal sets, by key and name, for the admin page's per-season switches.</summary>
    internal static IEnumerable<(string Key, string Name)> SeasonNames => Seasons.Select(s => (s.Key, s.Name));

    /// <summary>The seasons switched off in Settings (<see cref="PluginConfiguration.SeasonalOff"/>).</summary>
    internal static HashSet<string> SeasonsOff(PluginConfiguration? config)
        => new((config?.SeasonalOff ?? string.Empty).Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries), StringComparer.Ordinal);

    private IEnumerable<Definition> SeasonalSets()
    {
        var off = SeasonsOff(Plugin.Instance?.Configuration);
        foreach (var season in Seasons.Where(s => !off.Contains(s.Key)))
        {
            IReadOnlySet<string> listed = season.Snapshot is null ? new HashSet<string>() : snapshots.KeysOf(season.Snapshot);
            var rule = season.Rule;
            yield return new Definition($"seasonal:{season.Key}", season.Name, CollectionGroup.Seasonal, t => listed.Contains(t.Key) || rule(t))
            {
                Window = season.Window,
                Summary = $"Films and series for {season.Name}, while it lasts.",
            };
        }
    }

    private static IEnumerable<Definition> Decades()
    {
        for (var start = 1950; start <= 2020; start += 10)
        {
            var from = start;
            yield return new Definition($"decades:{from}s", $"Best of the {from}s", CollectionGroup.Decades, t => t.Year >= from && t.Year < from + 10)
            {
                Min = DecadeMinimum,
                Best = DecadeBest,
                Summary = $"The best rated titles of the {from}s in your library.",
            };
        }
    }

    private static IEnumerable<Definition> Genres(IReadOnlyList<Title> pool)
    {
        foreach (var genre in pool.SelectMany(t => t.Genres).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(g => g, StringComparer.OrdinalIgnoreCase))
        {
            var name = genre;
            yield return new Definition($"genres:{Keys.Slug(name)}", name, CollectionGroup.Genres, t => t.Genres.Contains(name, StringComparer.OrdinalIgnoreCase))
            {
                Min = GenreMinimum,
                Summary = $"{name} films and series in your library.",
            };
        }
    }

    private static IEnumerable<Definition> Studios(IReadOnlyList<Title> pool)
        => Facet(pool.Where(t => !t.IsSeries), CollectionGroup.Studios, StudioMinimum, "Films from {0}.");

    private static IEnumerable<Definition> Networks(IReadOnlyList<Title> pool)
        => Facet(pool.Where(t => t.IsSeries), CollectionGroup.Networks, NetworkMinimum, "Series from {0}.");

    /// <summary>One set per studio with enough titles. Jellyfin's studios for a series are its networks and production companies together.</summary>
    private static IEnumerable<Definition> Facet(IEnumerable<Title> pool, CollectionGroup group, int minimum, string summary)
    {
        var counts = pool
            .SelectMany(t => t.Studios.Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s.Trim()).Distinct(StringComparer.OrdinalIgnoreCase))
            .GroupBy(s => s, StringComparer.OrdinalIgnoreCase)
            .Where(g => g.Count() >= minimum)
            .OrderBy(g => g.Key, StringComparer.OrdinalIgnoreCase);
        foreach (var studio in counts)
        {
            var name = studio.Key;
            var series = group == CollectionGroup.Networks;
            yield return new Definition($"{group.Id()}:{Keys.Slug(name)}", name, group, t => t.IsSeries == series && t.Studios.Contains(name, StringComparer.OrdinalIgnoreCase))
            {
                Min = minimum,
                Summary = string.Format(System.Globalization.CultureInfo.InvariantCulture, summary, name),
            };
        }
    }

    private static IEnumerable<Definition> Certificates()
    {
        foreach (var band in UkCertificate.Bands)
        {
            var name = band == "12" ? "Rated 12 and 12A" : $"Rated {band}";
            yield return new Definition($"certificates:{band.ToLowerInvariant()}", name, CollectionGroup.Certificates, t => t.Certificate == band)
            {
                Summary = $"{name} in your library.",
            };
        }
    }

    private sealed record Season(string Key, string Name, Window Window, Func<Title, bool> Rule, string? Snapshot = null);
}
