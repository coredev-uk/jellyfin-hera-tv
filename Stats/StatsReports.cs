using System.Collections.Concurrent;
using System.Globalization;
using System.Text.RegularExpressions;
using MediaBrowser.Controller.Library;

namespace Jellyfin.Plugin.HeraTv.Stats;

/// <summary>What <see cref="StatsController"/> asks for; public because a controller's constructor must be.</summary>
public interface IStatsReports
{
    /// <summary>Gets everyone's history over the last <paramref name="days"/> days.</summary>
    object History(int days);

    /// <summary>Gets one person's history over the last <paramref name="days"/> days, or all of it when 0.</summary>
    object Me(Guid user, int days);
}

/// <summary>
/// Shapes Playback Reporting's history and Hera's own samples into what the Statistics pages draw,
/// and keeps each answer for a minute so a page that fetches it twice, or several admins looking at
/// once, cost one read.
/// </summary>
/// <remarks>
/// Days and hours are in the server's local time zone (<see cref="Clock"/>), so a household's evening
/// is on its own day. A play is counted on the day it started, and its time is spread over the hours
/// it ran through. Where clocks change, the repeated and skipped hours are approximated.
/// </remarks>
internal sealed partial class StatsReports(PlaybackReportingSource source, StatsStore store, IItemCatalogue catalogue, IUserManager users) : IStatsReports
{
    private const int ListLength = 10;
    private const int GenreCount = 6;

    /// <summary>A guard against a corrupt row claiming days of watching; no one watches for longer than this in one go.</summary>
    private const long LongestPlay = 24 * 3600;

    private static readonly TimeSpan CacheFor = TimeSpan.FromSeconds(60);

    private static readonly string[] MethodLabels = ["Direct Play", "Direct Stream", "Transcode"];

    private readonly ConcurrentDictionary<string, (DateTime Expires, object Value)> cache = new();

    private enum Kind
    {
        Film,
        Episode,
        Other,
    }

    /// <summary>Gets the admin history for the last <paramref name="days"/> days (today included).</summary>
    public object History(int days) => Cached($"history:{days}", () =>
    {
        var today = Clock.Today;
        var from = today.AddDays(1 - days);
        return BuildHistory(source.Read(from, null), store.Read(from), today, days, catalogue, UserName);
    });

    /// <summary>Gets one person's history for the last <paramref name="days"/> days, or all of it when 0.</summary>
    public object Me(Guid user, int days) => Cached($"me:{user:N}:{days}", () =>
    {
        var today = Clock.Today;
        var from = days == 0 ? DateTime.MinValue : today.AddDays(1 - days);
        return BuildMe(source.Read(from, user.ToString("N")), today, days, catalogue);
    });

    internal static object BuildHistory(IReadOnlyList<Play>? plays, Recorded? recorded, DateTime today, int days, IItemCatalogue catalogue, Func<string, string> userName)
    {
        var from = today.AddDays(1 - days);
        var viewed = Classify(plays ?? [], catalogue);

        var daily = new Day[days];
        var hours = new long[7 * 24];
        var methods = MethodLabels.ToDictionary(label => label, _ => new Tally(), StringComparer.Ordinal);
        var clients = new Dictionary<string, Tally>(StringComparer.Ordinal);
        var devices = new Dictionary<string, Tally>(StringComparer.Ordinal);
        var people = new Dictionary<string, Person>(StringComparer.Ordinal);
        var films = new Dictionary<string, Group>(StringComparer.Ordinal);
        var shows = new Dictionary<string, Group>(StringComparer.Ordinal);
        long totalSeconds = 0;

        foreach (var v in viewed)
        {
            var play = v.Play;
            totalSeconds += play.Seconds;

            var index = (play.Start.Date - from).Days;
            if (index >= 0 && index < days)
            {
                daily[index].Plays++;
                daily[index].Films += v.Kind == Kind.Film ? 1 : 0;
                daily[index].Episodes += v.Kind == Kind.Episode ? 1 : 0;
            }

            Spread(play.Start, play.Seconds, (at, seconds) =>
            {
                var slot = (at.Date - from).Days;
                if (slot >= 0 && slot < days)
                {
                    daily[slot].Seconds += seconds;
                }

                hours[HourSlot(at)] += seconds;
            });

            methods[play.Method].Add(play.Seconds);
            TallyFor(clients, play.Client).Add(play.Seconds);
            TallyFor(devices, play.Device).Add(play.Seconds);

            if (!people.TryGetValue(play.User, out var person))
            {
                people[play.User] = person = new Person();
            }

            person.Tally.Add(play.Seconds);
            if (play.Start >= person.LastSeen)
            {
                person.LastSeen = play.Start;
                person.LastTitle = Display(v);
            }

            if (v.Kind != Kind.Other)
            {
                GroupFor(v.Kind == Kind.Film ? films : shows, v).Tally.Add(play.Seconds);
            }
        }

        return new
        {
            available = plays is not null,
            range = new { from = DateString(from), to = DateString(today), days },
            totals = new { plays = viewed.Count, seconds = totalSeconds, users = people.Count, titles = films.Count + shows.Count },
            daily = daily.Select((d, i) => new { date = DateString(from.AddDays(i)), plays = d.Plays, seconds = d.Seconds, films = d.Films, episodes = d.Episodes }),
            hours = Heat(hours),
            users = people
                .OrderByDescending(p => p.Value.Tally.Seconds)
                .ThenBy(p => p.Key, StringComparer.Ordinal)
                .Select(p => new
                {
                    id = p.Key,
                    name = userName(p.Key),
                    plays = p.Value.Tally.Plays,
                    seconds = p.Value.Tally.Seconds,
                    lastSeen = Clock.UtcString(Clock.ToUtc(p.Value.LastSeen)),
                    lastTitle = p.Value.LastTitle,
                }),
            films = TopByPlays(films),
            shows = TopByPlays(shows),
            methods = MethodLabels.Select(label => new { label, plays = methods[label].Plays, seconds = methods[label].Seconds }),
            clients = TopLabels(clients),
            devices = TopLabels(devices),
            recorded = ShapeRecorded(recorded, from, today),
        };
    }

    internal static object BuildMe(IReadOnlyList<Play>? plays, DateTime today, int days, IItemCatalogue catalogue)
    {
        var viewed = Classify(plays ?? [], catalogue);

        // All time starts at the first play; otherwise the chart would open on year 1.
        var from = days == 0
            ? (viewed.Count == 0 ? today : viewed.Min(v => v.Play.Start.Date))
            : today.AddDays(1 - days);
        var span = (today - from).Days + 1;

        var daily = new long[span];
        var hours = new long[7 * 24];
        var films = new Dictionary<string, Group>(StringComparer.Ordinal);
        var shows = new Dictionary<string, Group>(StringComparer.Ordinal);
        var episodes = new HashSet<string>(StringComparer.Ordinal);
        var genres = new Dictionary<string, double>(StringComparer.Ordinal);
        var watched = new HashSet<DateTime>();
        long totalSeconds = 0;

        foreach (var v in viewed)
        {
            var play = v.Play;
            totalSeconds += play.Seconds;
            watched.Add(play.Start.Date);

            Spread(play.Start, play.Seconds, (at, seconds) =>
            {
                var slot = (at.Date - from).Days;
                if (slot >= 0 && slot < span)
                {
                    daily[slot] += seconds;
                }

                hours[HourSlot(at)] += seconds;
            });

            if (v.Kind != Kind.Other)
            {
                var group = GroupFor(v.Kind == Kind.Film ? films : shows, v);
                group.Tally.Add(play.Seconds);
                if (v.Kind == Kind.Episode)
                {
                    var episode = string.IsNullOrEmpty(play.ItemId) ? play.Name : play.ItemId;
                    episodes.Add(episode);
                    group.Episodes.Add(episode);
                }
            }

            // A play's time is shared out between its genres, so the shares add up to what was watched.
            if (v.Facts is { Genres.Count: > 0 } facts)
            {
                foreach (var genre in facts.Genres)
                {
                    genres[genre] = genres.GetValueOrDefault(genre) + ((double)play.Seconds / facts.Genres.Count);
                }
            }
        }

        var busiestIndex = Array.IndexOf(daily, daily.Max());
        var (longest, current) = Streaks(watched, today);

        return new
        {
            available = plays is not null,
            range = new { from = DateString(from), to = DateString(today), days = span },
            totals = new
            {
                plays = viewed.Count,
                seconds = totalSeconds,
                films = films.Count,
                episodes = episodes.Count,
                shows = shows.Count,
            },
            daily = daily.Select((seconds, i) => new { date = DateString(from.AddDays(i)), seconds }),
            hours = Heat(hours),
            films = films.Values
                .OrderByDescending(g => g.Tally.Seconds).ThenBy(g => g.Name, StringComparer.Ordinal)
                .Take(ListLength)
                .Select(g => new { id = IdString(g.Id), name = g.Name, plays = g.Tally.Plays, seconds = g.Tally.Seconds }),
            shows = shows.Values
                .OrderByDescending(g => g.Tally.Seconds).ThenBy(g => g.Name, StringComparer.Ordinal)
                .Take(ListLength)
                .Select(g => new { id = IdString(g.Id), name = g.Name, episodes = g.Episodes.Count, seconds = g.Tally.Seconds }),
            genres = genres
                .OrderByDescending(g => g.Value).ThenBy(g => g.Key, StringComparer.Ordinal)
                .Take(GenreCount)
                .Select(g => new { name = g.Key, seconds = (long)Math.Round(g.Value) }),
            streak = new { longest, current },
            busiest = viewed.Count == 0 || daily[busiestIndex] == 0
                ? null
                : new { date = DateString(from.AddDays(busiestIndex)), seconds = daily[busiestIndex] },
            first = viewed.Count == 0 ? null : DateString(viewed.Min(v => v.Play.Start.Date)),
        };
    }

    /// <summary>
    /// Works out what each play was of: a film, or an episode of a show, with the library's id for
    /// the title where it still has one. A title the library no longer holds is matched to one it
    /// does by name (a film re-added under a new id is still the same film) or kept by its name.
    /// </summary>
    private static List<Viewed> Classify(IReadOnlyList<Play> plays, IItemCatalogue catalogue)
    {
        var facts = new Dictionary<string, ItemFacts?>(StringComparer.Ordinal);
        var named = new Dictionary<string, Guid>(StringComparer.OrdinalIgnoreCase);
        var first = new List<(Play Play, Kind Kind, string Title, Guid? Id, ItemFacts? Facts)>(plays.Count);

        foreach (var play in plays)
        {
            var kind = play.Type switch
            {
                "Movie" => Kind.Film,
                "Episode" => Kind.Episode,
                _ => Kind.Other,
            };

            ItemFacts? found = null;
            Guid? item = Guid.TryParse(play.ItemId, out var parsed) ? parsed : null;
            if (item is { } itemId && !facts.TryGetValue(play.ItemId, out found))
            {
                facts[play.ItemId] = found = catalogue.Find(itemId);
            }

            var (title, id) = kind switch
            {
                Kind.Episode => (found?.SeriesName ?? SeriesOf(play.Name), found?.SeriesId),
                Kind.Film => (play.Name, found is null ? null : item),
                _ => (play.Name, (Guid?)null),
            };

            if (id is { } known && kind != Kind.Other)
            {
                named.TryAdd($"{kind}:{title}", known);
            }

            first.Add((play, kind, title, id, found));
        }

        var viewed = new List<Viewed>(first.Count);
        foreach (var (play, kind, title, id, found) in first)
        {
            Guid? resolved = id ?? (kind != Kind.Other && named.TryGetValue($"{kind}:{title}", out var byName) ? byName : null);
            var key = kind == Kind.Other
                ? $"other:{(string.IsNullOrEmpty(play.ItemId) ? play.Name : play.ItemId)}"
                : resolved is { } g ? g.ToString("N") : $"{kind}:{title.ToLowerInvariant()}";
            viewed.Add(new Viewed(play, kind, key, title, resolved, found));
        }

        return viewed;
    }

    /// <summary>Calls <paramref name="into"/> for each stretch of a play that falls in one hour.</summary>
    private static void Spread(DateTime start, long seconds, Action<DateTime, long> into)
    {
        var left = Math.Min(seconds, LongestPlay);
        var at = start;
        while (left > 0)
        {
            var next = new DateTime(at.Year, at.Month, at.Day, at.Hour, 0, 0, DateTimeKind.Unspecified).AddHours(1);
            var take = Math.Min(left, Math.Max(1, (long)Math.Ceiling((next - at).TotalSeconds)));
            into(at, take);
            left -= take;
            at = at.AddSeconds(take);
        }
    }

    /// <summary>Monday is 0, as the page draws its week.</summary>
    private static int HourSlot(DateTime at) => (((int)at.DayOfWeek + 6) % 7 * 24) + at.Hour;

    private static IEnumerable<object> Heat(long[] hours)
        => Enumerable.Range(0, hours.Length).Select(i => (object)new { day = i / 24, hour = i % 24, seconds = hours[i] });

    private static (int Longest, int Current) Streaks(HashSet<DateTime> watched, DateTime today)
    {
        var longest = 0;
        foreach (var day in watched.Where(d => !watched.Contains(d.AddDays(-1))))
        {
            var length = 1;
            while (watched.Contains(day.AddDays(length)))
            {
                length++;
            }

            longest = Math.Max(longest, length);
        }

        // Today may simply not have been watched yet, which doesn't end a streak.
        var cursor = watched.Contains(today) ? today : today.AddDays(-1);
        var current = 0;
        while (watched.Contains(cursor))
        {
            current++;
            cursor = cursor.AddDays(-1);
        }

        return (longest, current);
    }

    private static object? ShapeRecorded(Recorded? recorded, DateTime from, DateTime today)
    {
        if (recorded is null)
        {
            return null;
        }

        // Days before the recorder first ran have no data, which is not the same as no streams.
        var sinceDay = Clock.FromUtc(recorded.Since).Date;
        var start = sinceDay > from ? sinceDay : from;
        var dates = Enumerable.Range(0, Math.Max(0, (today - start).Days + 1)).Select(i => DateString(start.AddDays(i))).ToList();

        return new
        {
            since = Clock.UtcString(recorded.Since),
            peaks = dates.Select(date => new { date, streams = recorded.Peaks.GetValueOrDefault(date) }),
            resolution = StatsStore.ResolutionLabels.Select((label, i) => new { label, seconds = recorded.Resolution[i] }),
            transcode = dates.Select(date =>
            {
                var (direct, transcode) = recorded.Transcodes.GetValueOrDefault(date);
                return new { date, direct, transcode };
            }),
            bitrate = StatsStore.BitrateLabels.Select((label, i) => new { label, seconds = recorded.Bitrate[i] }),
        };
    }

    private static IEnumerable<object> TopByPlays(Dictionary<string, Group> groups) => groups.Values
        .OrderByDescending(g => g.Tally.Plays).ThenByDescending(g => g.Tally.Seconds).ThenBy(g => g.Name, StringComparer.Ordinal)
        .Take(ListLength)
        .Select(g => (object)new { id = IdString(g.Id), name = g.Name, plays = g.Tally.Plays, seconds = g.Tally.Seconds });

    private static IEnumerable<object> TopLabels(Dictionary<string, Tally> tallies) => tallies
        .OrderByDescending(t => t.Value.Plays).ThenByDescending(t => t.Value.Seconds).ThenBy(t => t.Key, StringComparer.Ordinal)
        .Take(ListLength)
        .Select(t => (object)new { label = t.Key, plays = t.Value.Plays, seconds = t.Value.Seconds });

    private static Tally TallyFor(Dictionary<string, Tally> tallies, string label)
    {
        var key = string.IsNullOrWhiteSpace(label) ? "Unknown" : label;
        if (!tallies.TryGetValue(key, out var tally))
        {
            tallies[key] = tally = new Tally();
        }

        return tally;
    }

    private static Group GroupFor(Dictionary<string, Group> groups, Viewed v)
    {
        if (!groups.TryGetValue(v.Key, out var group))
        {
            groups[v.Key] = group = new Group();
        }

        // Plays arrive oldest first, so the name and id settle on the newest.
        group.Name = v.Title;
        group.Id = v.Id ?? group.Id;
        return group;
    }

    /// <summary>"Show · S1, E3" for an episode; a film's own name otherwise.</summary>
    private static string Display(Viewed v)
    {
        if (v.Kind == Kind.Episode && EpisodeLabel().Match(v.Play.Name) is { Success: true } m)
        {
            return string.Create(CultureInfo.InvariantCulture, $"{v.Title} \u00b7 S{int.Parse(m.Groups["s"].Value, CultureInfo.InvariantCulture)}, E{int.Parse(m.Groups["e"].Value, CultureInfo.InvariantCulture)}");
        }

        return v.Play.Name;
    }

    /// <summary>Playback Reporting names episodes "Series - s01e03 - Title".</summary>
    private static string SeriesOf(string name)
    {
        if (EpisodeLabel().Match(name) is { Success: true } m)
        {
            return m.Groups["series"].Value;
        }

        var cut = name.IndexOf(" - s", StringComparison.OrdinalIgnoreCase);
        return cut > 0 ? name[..cut] : name;
    }

    [GeneratedRegex(@"^(?<series>.+) - s(?<s>\d{1,4})e(?<e>\d{1,4})", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, matchTimeoutMilliseconds: 1000)]
    private static partial Regex EpisodeLabel();

    private static string DateString(DateTime day) => Clock.DateString(day);

    private static string? IdString(Guid? id) => id?.ToString("N");

    private string UserName(string id)
        => Guid.TryParse(id, out var guid) && users.GetUserById(guid) is { } user ? user.Username : "Deleted user";

    private object Cached(string key, Func<object> build)
    {
        var now = DateTime.UtcNow;
        if (cache.TryGetValue(key, out var hit) && hit.Expires > now)
        {
            return hit.Value;
        }

        var value = build();

        // Per-user keys are bounded by the household, but expired entries needn't stay.
        foreach (var stale in cache.Where(e => e.Value.Expires <= now).Select(e => e.Key))
        {
            cache.TryRemove(stale, out _);
        }

        cache[key] = (now + CacheFor, value);
        return value;
    }

    private sealed class Tally
    {
        public long Plays { get; private set; }

        public long Seconds { get; private set; }

        public void Add(long seconds)
        {
            Plays++;
            Seconds += seconds;
        }
    }

    private sealed class Group
    {
        public string Name { get; set; } = string.Empty;

        public Guid? Id { get; set; }

        public Tally Tally { get; } = new();

        public HashSet<string> Episodes { get; } = new(StringComparer.Ordinal);
    }

    private sealed class Person
    {
        public Tally Tally { get; } = new();

        public DateTime LastSeen { get; set; } = DateTime.MinValue;

        public string LastTitle { get; set; } = string.Empty;
    }

    private struct Day
    {
        public long Plays;
        public long Seconds;
        public long Films;
        public long Episodes;
    }

    private sealed record Viewed(Play Play, Kind Kind, string Key, string Title, Guid? Id, ItemFacts? Facts);
}
