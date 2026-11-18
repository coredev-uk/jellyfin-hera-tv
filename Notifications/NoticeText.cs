using System.Globalization;

namespace Jellyfin.Plugin.HeraTv.Notifications;

/// <summary>One episode a notice is about.</summary>
/// <param name="Number">The episode's number in its season, or null for a special or an undated order.</param>
/// <param name="NumberEnd">The last episode a double-length file covers, or null.</param>
public sealed record EpisodeRef(string Id, int? Season, int? Number, int? NumberEnd, string Name);

/// <summary>
/// What each notice says: sentence case, British English, no exclamation marks. Pure, so the
/// wording can be checked without a server.
/// </summary>
public static class NoticeText
{
    // Spelled out rather than taken from the culture, so the wording doesn't depend on the server's locale data.
    private static readonly string[] Months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    /// <summary>The two lines of a request notice. <paramref name="state"/> is approved, downloading, available or declined.</summary>
    public static (string Title, string? Body) Request(string name, string state, DateTime? requestedLocal, DateTime todayLocal)
    {
        var title = state switch
        {
            "available" => $"{name} is ready to watch",
            "downloading" => $"{name} is downloading",
            "declined" => $"{name} was declined",
            _ => $"{name} was approved",
        };
        return (title, requestedLocal is { } when ? $"You requested it on {ShortDate(when, todayLocal)}." : null);
    }

    /// <summary>"3 Nov", with the year when it isn't this one.</summary>
    public static string ShortDate(DateTime date, DateTime todayLocal)
    {
        var text = $"{date.Day.ToString(CultureInfo.InvariantCulture)} {Months[date.Month - 1]}";
        return date.Year == todayLocal.Year ? text : $"{text} {date.Year.ToString(CultureInfo.InvariantCulture)}";
    }

    /// <summary>"3 new episodes of Bosch: Legacy" over "S2, E4 to E6"; for one, "New episode of …" over "S2, E4 · Title".</summary>
    public static (string Title, string? Body) Episodes(string series, IReadOnlyList<EpisodeRef> episodes)
    {
        if (episodes.Count == 1)
        {
            var only = episodes[0];
            var label = Label(only.Season, only.Number);
            var body = label is null ? OrNull(only.Name) : string.IsNullOrWhiteSpace(only.Name) ? label : $"{label} · {only.Name}";
            return ($"New episode of {series}", body);
        }

        return ($"{episodes.Count.ToString(CultureInfo.InvariantCulture)} new episodes of {series}", Range(episodes));
    }

    /// <summary>"S2, E4 to E6" for a run, "S2, E4, E6" for a few apart, "S1, E9 to S2, E2" across seasons; null when no episode has a number.</summary>
    public static string? Range(IReadOnlyList<EpisodeRef> episodes)
    {
        var numbered = episodes
            .Where(e => e.Number is not null)
            .OrderBy(e => e.Season ?? 0)
            .ThenBy(e => e.Number)
            .ToList();
        if (numbered.Count == 0)
        {
            return null;
        }

        var first = numbered[0];
        var last = numbered[^1];
        var lastNumber = Math.Max(last.NumberEnd ?? 0, last.Number!.Value);
        if (first.Season != last.Season)
        {
            return $"{Label(first.Season, first.Number)} to {Label(last.Season, lastNumber)}";
        }

        var numbers = numbered.Select(e => e.Number!.Value).Distinct().ToList();
        var season = first.Season is { } s ? $"S{s.ToString(CultureInfo.InvariantCulture)}, " : string.Empty;
        if (numbers.Count == 1)
        {
            return lastNumber > numbers[0] ? $"{season}E{numbers[0]} to E{lastNumber}" : $"{season}E{numbers[0]}";
        }

        var run = lastNumber - numbers[0] + 1 == numbers.Count;
        if (run || numbers.Count > 4)
        {
            return $"{season}E{numbers[0]} to E{lastNumber}";
        }

        return season + string.Join(", ", numbers.Select(n => $"E{n.ToString(CultureInfo.InvariantCulture)}"));
    }

    /// <summary>"New today: Runner, Mutiny and 4 more" over "3 films and 3 new series".</summary>
    public static (string Title, string? Body) Arrivals(IReadOnlyList<NoticeItem> items, int films, int series)
    {
        var names = items.Select(i => i.Name).ToList();
        var total = films + series;
        var title = total switch
        {
            1 => $"New today: {names[0]}",
            2 => $"New today: {names[0]} and {names[1]}",
            _ => $"New today: {names[0]}, {names[1]} and {(total - 2).ToString(CultureInfo.InvariantCulture)} more",
        };

        var parts = new List<string>();
        if (films > 0)
        {
            parts.Add(films == 1 ? "1 film" : $"{films.ToString(CultureInfo.InvariantCulture)} films");
        }

        if (series > 0)
        {
            parts.Add(series == 1 ? "1 new series" : $"{series.ToString(CultureInfo.InvariantCulture)} new series");
        }

        return (title, string.Join(" and ", parts));
    }

    private static string? Label(int? season, int? number)
        => number is null
            ? null
            : season is { } s
                ? $"S{s.ToString(CultureInfo.InvariantCulture)}, E{number.Value.ToString(CultureInfo.InvariantCulture)}"
                : $"E{number.Value.ToString(CultureInfo.InvariantCulture)}";

    private static string? OrNull(string text) => string.IsNullOrWhiteSpace(text) ? null : text;
}
