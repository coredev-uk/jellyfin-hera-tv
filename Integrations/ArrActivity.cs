using System.Globalization;
using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// What Sonarr, Radarr and SABnzbd know about a title: not Seerr's "processing", but whether it is
/// monitored, searching, queued, downloading (how far, how long left), importing or here, and for a
/// show how many episodes of each series have arrived. Joined to Seerr by TMDB and TVDB id, or by
/// the *arr id Seerr stores on the request. Every lookup fails soft: a service that is not set up
/// or not answering contributes nothing.
/// </summary>
public static class ArrActivity
{
    private static readonly TimeSpan QueueTtl = TimeSpan.FromSeconds(5);
    // Short: when a download leaves the queue, the title must read "available" within seconds, not "searching" until a minute-old lookup expires.
    private static readonly TimeSpan LibraryTtl = TimeSpan.FromSeconds(10);

    // Which of several downloads speaks for a title: the one furthest along.
    private static readonly string[] StatePriority = ["downloading", "importing", "queued", "attention", "failed"];

    /// <summary>One download the *arr queue tracks, with SABnzbd's own numbers where it has them.</summary>
    public sealed record QueueItem(
        ArrService Source,
        int? MediaId,
        int? SeasonNumber,
        int? EpisodeNumber,
        string? EpisodeTitle,
        string? MediaTitle,
        int? MediaYear,
        string Release,
        string State,
        bool Paused,
        long Size,
        long SizeLeft,
        int? EtaSeconds,
        string? Client,
        string? Protocol,
        string DownloadId,
        string? Message,
        string? Slug,
        int? TmdbId)
    {
        public double? Percent => Size > 0 ? Math.Round(Math.Clamp((Size - SizeLeft) * 100.0 / Size, 0, 100), 1) : null;
    }

    /// <summary>SABnzbd's queue: the overall speed and what each download is doing.</summary>
    public sealed record SabQueue(string Status, bool Paused, long SpeedBps, long SizeLeft, int? EtaSeconds, int Slots, IReadOnlyDictionary<string, SabSlot> ById);

    public sealed record SabSlot(string Status, long Size, long SizeLeft, int? EtaSeconds);

    /// <summary>One series of a show: episodes held against episodes wanted so far.</summary>
    public sealed record SeasonRow(int Number, string State, int Have, int Want, int Total, int Items, string? NextAiring);

    /// <summary>A title's state in the download stack.</summary>
    public sealed record Activity(
        string Service,
        int ArrId,
        string State,
        bool Monitored,
        double? Percent,
        int? EtaSeconds,
        long? SizeBytes,
        long? SizeLeftBytes,
        int Items,
        bool Paused,
        string? ReleaseDate,
        string? NextAiring,
        int? Have,
        int? Want,
        IReadOnlyList<SeasonRow>? Seasons)
    {
        /// <summary>Gets the *arr's slug for the title, for an administrator's "open in" link; never sent as is.</summary>
        public string? Slug { get; init; }

        /// <summary>The shape the web client reads: a title's state, never a release name, client or path.</summary>
        public object ToJson(SabQueue? sab) => new
        {
            service = Service,
            arrId = ArrId,
            state = State,
            monitored = Monitored,
            progress = Percent,
            etaSeconds = EtaSeconds,
            sizeBytes = SizeBytes,
            sizeLeftBytes = SizeLeftBytes,
            speedBps = State == "downloading" && sab is { Paused: false } ? (long?)sab.SpeedBps : null,
            items = Items,
            paused = Paused,
            releaseDate = ReleaseDate,
            nextAiring = NextAiring,
            have = Have,
            want = Want,
            seasons = Seasons?.Select(s => new
            {
                seasonNumber = s.Number,
                state = s.State,
                have = s.Have,
                want = s.Want,
                total = s.Total,
                items = s.Items,
                nextAiring = s.NextAiring,
            }).ToArray(),
        };
    }

    // ---------- queue --------------------------------------------------------------------------

    /// <summary>Gets SABnzbd's queue, or null when it is not set up or not answering.</summary>
    public static async Task<SabQueue?> SabAsync(UpstreamClient upstream)
    {
        var body = await upstream.ArrGetAsync(ArrService.Sabnzbd, "api?mode=queue", QueueTtl).ConfigureAwait(false);
        if (body.At("queue") is not JsonObject queue)
        {
            return null;
        }

        var slots = new Dictionary<string, SabSlot>(StringComparer.OrdinalIgnoreCase);
        foreach (var slot in queue["slots"].Items())
        {
            var id = slot.At("nzo_id").Str();
            if (string.IsNullOrEmpty(id))
            {
                continue;
            }

            slots[id] = new SabSlot(
                slot.At("status").Str() ?? string.Empty,
                Megabytes(slot.At("mb")),
                Megabytes(slot.At("mbleft")),
                Seconds(slot.At("timeleft").Str()));
        }

        var kbPerSecond = queue["kbpersec"].Num() ?? 0;
        return new SabQueue(
            queue["status"].Str() ?? string.Empty,
            queue["paused"].Bool() ?? false,
            (long)(kbPerSecond * 1024),
            Megabytes(queue["mbleft"]),
            Seconds(queue["timeleft"].Str()),
            (int)(queue["noofslots"].Num() ?? slots.Count),
            slots);
    }

    /// <summary>Gets every download Sonarr and Radarr track, SABnzbd's numbers laid over theirs.</summary>
    public static async Task<IReadOnlyList<QueueItem>> QueueAsync(UpstreamClient upstream)
    {
        var sonarr = upstream.ArrGetAsync(ArrService.Sonarr, "api/v3/queue/details?includeSeries=true&includeEpisode=true", QueueTtl);
        var radarr = upstream.ArrGetAsync(ArrService.Radarr, "api/v3/queue/details?includeMovie=true", QueueTtl);
        var sabTask = SabAsync(upstream);
        await Task.WhenAll(sonarr, radarr, sabTask).ConfigureAwait(false);
        var sab = await sabTask.ConfigureAwait(false);

        var items = new List<QueueItem>();
        items.AddRange(upstream.MapEach("Sonarr", (await sonarr.ConfigureAwait(false)).Items(), node => Item(ArrService.Sonarr, node, sab)).OfType<QueueItem>());
        items.AddRange(upstream.MapEach("Radarr", (await radarr.ConfigureAwait(false)).Items(), node => Item(ArrService.Radarr, node, sab)).OfType<QueueItem>());
        return items;
    }

    private static QueueItem? Item(ArrService source, JsonNode node, SabQueue? sab)
    {
        var state = StateOf(node);
        if (state == "ignored")
        {
            return null;
        }

        var downloadId = node.At("downloadId").Str();
        var key = string.IsNullOrEmpty(downloadId) ? $"{source}:{node.At("id")}" : downloadId;
        SabSlot? slot = null;
        if (!string.IsNullOrEmpty(downloadId))
        {
            sab?.ById.TryGetValue(downloadId, out slot);
        }

        var size = (long)(node.At("size").Num() ?? 0);
        var left = (long)(node.At("sizeleft").Num() ?? 0);
        var eta = Seconds(node.At("timeleft").Str()) ?? SecondsUntil(node.At("estimatedCompletionTime").Str());
        var paused = false;
        if (slot is not null && state is "downloading" or "queued")
        {
            // Between the *arr's polls SABnzbd is the one that knows.
            (state, paused) = slot.Status.ToLowerInvariant() switch
            {
                "paused" => ("queued", true),
                "queued" or "propagating" => ("queued", false),
                "verifying" or "repairing" or "extracting" or "moving" or "running" => ("importing", false),
                _ => ("downloading", false),
            };
            if (slot.Size > 0)
            {
                size = slot.Size;
                left = slot.SizeLeft;
            }

            eta = state == "downloading" ? slot.EtaSeconds ?? eta : null;
        }

        if (state != "downloading")
        {
            eta = null;
        }

        var series = node.At("series");
        var movie = node.At("movie");
        var episode = node.At("episode");
        return new QueueItem(
            source,
            node.At("seriesId").Int() ?? node.At("movieId").Int(),
            node.At("seasonNumber").Int() ?? episode.At("seasonNumber").Int(),
            episode.At("episodeNumber").Int(),
            episode.At("title").Str(),
            series.At("title").Str() ?? movie.At("title").Str(),
            series.At("year").Int() ?? movie.At("year").Int(),
            node.At("title").Str() ?? string.Empty,
            state,
            paused,
            size,
            left,
            eta,
            node.At("downloadClient").Str(),
            node.At("protocol").Str(),
            key,
            Message(node),
            series.At("titleSlug").Str() ?? movie.At("titleSlug").Str(),
            series.At("tmdbId").Int() ?? movie.At("tmdbId").Int());
    }

    // The *arr's own words, two layers: a download's state, then its status.
    private static string StateOf(JsonNode node)
    {
        var tracked = node.At("trackedDownloadState").Str();
        var status = (node.At("status").Str() ?? string.Empty).ToLowerInvariant();
        return tracked switch
        {
            "importBlocked" => "attention",
            "importPending" or "importing" or "imported" => "importing",
            "failed" or "failedPending" => "failed",
            "ignored" => "ignored",
            _ => status switch
            {
                "downloading" => "downloading",
                "completed" => "importing",
                "failed" => "failed",
                "warning" or "downloadclientunavailable" => "attention",
                _ => "queued",
            },
        };
    }

    private static string? Message(JsonNode node)
    {
        var parts = new List<string>();
        if (node.At("errorMessage").Str() is { } error && !string.IsNullOrWhiteSpace(error))
        {
            parts.Add(error.Trim());
        }

        foreach (var entry in node.At("statusMessages").Items())
        {
            foreach (var message in entry.At("messages").Items())
            {
                var text = message.Str()?.Trim();
                if (!string.IsNullOrEmpty(text) && !parts.Contains(text))
                {
                    parts.Add(text);
                }
            }
        }

        return parts.Count == 0 ? null : string.Join(" ", parts.Take(2));
    }

    private sealed record Summary(string State, long Size, long SizeLeft, int? EtaSeconds, int Count, bool Paused);

    /// <summary>One state for a title's downloads: a season pack is one download however many episodes it holds.</summary>
    private static Summary? Summarise(IReadOnlyCollection<QueueItem> items)
    {
        if (items.Count == 0)
        {
            return null;
        }

        var state = StatePriority.First(s => items.Any(i => i.State == s));
        var downloads = items.GroupBy(i => i.DownloadId).Select(g => g.First()).ToList();
        var moving = downloads.Where(d => d.State is "downloading" or "queued").ToList();
        var etas = downloads.Where(d => d.State == "downloading" && d.EtaSeconds is not null).Select(d => d.EtaSeconds!.Value).ToList();
        return new Summary(
            state,
            moving.Sum(d => d.Size),
            moving.Sum(d => d.SizeLeft),
            etas.Count == 0 ? null : etas.Max(),
            items.Count,
            state == "queued" && moving.All(d => d.Paused));
    }

    // ---------- titles -------------------------------------------------------------------------

    /// <summary>A film's state in Radarr; null when Radarr is not set up, not answering, or does not know it.</summary>
    public static async Task<Activity?> MovieAsync(UpstreamClient upstream, int tmdbId, int? arrId, IReadOnlyList<QueueItem> queue)
    {
        string? slug = null;
        var activity = await MovieCoreAsync(upstream, tmdbId, arrId, queue, s => slug = s).ConfigureAwait(false);
        return activity is null ? null : activity with { Slug = slug };
    }

    private static async Task<Activity?> MovieCoreAsync(UpstreamClient upstream, int tmdbId, int? arrId, IReadOnlyList<QueueItem> queue, Action<string?> slugSink)
    {
        JsonNode? movie = null;
        if (arrId is int id)
        {
            movie = await upstream.ArrGetAsync(ArrService.Radarr, $"api/v3/movie/{id}", LibraryTtl).ConfigureAwait(false);
            if (movie.At("tmdbId").Int() is int known && known != tmdbId)
            {
                movie = null;
            }
        }

        movie ??= (await upstream.ArrGetAsync(ArrService.Radarr, $"api/v3/movie?tmdbId={tmdbId}", LibraryTtl).ConfigureAwait(false)).Items().FirstOrDefault();
        if (movie.At("id").Int() is not int movieId)
        {
            return null;
        }

        slugSink(movie.At("titleSlug").Str());

        var monitored = movie.At("monitored").Bool() ?? false;
        var hasFile = movie.At("hasFile").Bool() ?? false;
        long? onDisk = (long?)movie.At("sizeOnDisk").Num();
        var items = queue.Where(q => q.Source == ArrService.Radarr && q.MediaId == movieId).ToList();
        if (hasFile)
        {
            return new Activity("radarr", movieId, "available", monitored, null, null, onDisk, null, 0, false, null, null, null, null, null);
        }

        if (Summarise(items) is { } summary)
        {
            return FromSummary("radarr", movieId, monitored, summary, null, null, null, null);
        }

        if (!monitored)
        {
            return new Activity("radarr", movieId, "unmonitored", false, null, null, null, null, 0, false, null, null, null, null, null);
        }

        if (movie.At("isAvailable").Bool() ?? false)
        {
            return new Activity("radarr", movieId, "searching", true, null, null, null, null, 0, false, null, null, null, null, null);
        }

        // Not out yet by the profile's rules. The digital or physical release is when it can arrive.
        var release = Date(movie.At("digitalRelease").Str()) ?? Date(movie.At("physicalRelease").Str())
            ?? (movie.At("minimumAvailability").Str() == "inCinemas" ? Date(movie.At("inCinemas").Str()) : null);
        return new Activity("radarr", movieId, "waiting", true, null, null, null, null, 0, false, release, null, null, null, null);
    }

    /// <summary>
    /// A show's state in Sonarr. <paramref name="seasons"/> narrows it to the series a request asked
    /// for; null or empty means every series Sonarr is watching.
    /// </summary>
    public static async Task<Activity?> SeriesAsync(
        UpstreamClient upstream,
        int tmdbId,
        int? tvdbId,
        int? arrId,
        IReadOnlyCollection<int>? seasons,
        IReadOnlyList<QueueItem> queue)
    {
        string? slug = null;
        var activity = await SeriesCoreAsync(upstream, tmdbId, tvdbId, arrId, seasons, queue, s => slug = s).ConfigureAwait(false);
        return activity is null ? null : activity with { Slug = slug };
    }

    private static async Task<Activity?> SeriesCoreAsync(
        UpstreamClient upstream,
        int tmdbId,
        int? tvdbId,
        int? arrId,
        IReadOnlyCollection<int>? seasons,
        IReadOnlyList<QueueItem> queue,
        Action<string?> slugSink)
    {
        JsonNode? series = null;
        if (arrId is int id)
        {
            series = await upstream.ArrGetAsync(ArrService.Sonarr, $"api/v3/series/{id}", LibraryTtl).ConfigureAwait(false);
            // A stale id from Seerr: the show it names must be the show asked about.
            if ((series.At("tmdbId").Int() is int known && known > 0 && known != tmdbId)
                || (tvdbId is int tvdb && series.At("tvdbId").Int() is int knownTvdb && knownTvdb > 0 && knownTvdb != tvdb))
            {
                series = null;
            }
        }

        if (series is null && tvdbId is int lookup)
        {
            series = (await upstream.ArrGetAsync(ArrService.Sonarr, $"api/v3/series?tvdbId={lookup}", LibraryTtl).ConfigureAwait(false)).Items().FirstOrDefault();
        }

        if (series.At("id").Int() is not int seriesId)
        {
            return null;
        }

        slugSink(series.At("titleSlug").Str());

        var monitored = series.At("monitored").Bool() ?? false;
        var mine = queue.Where(q => q.Source == ArrService.Sonarr && q.MediaId == seriesId).ToList();
        var wanted = seasons is { Count: > 0 } ? seasons.ToHashSet() : null;
        var rows = new List<SeasonRow>();
        foreach (var node in series.At("seasons").Items())
        {
            var number = node.At("seasonNumber").Int();
            if (number is null || (wanted is null ? number == 0 : !wanted.Contains(number.Value)))
            {
                continue;
            }

            var stats = node.At("statistics");
            var have = (int)(stats.At("episodeFileCount").Num() ?? 0);
            var want = Math.Max((int)(stats.At("episodeCount").Num() ?? 0), have);
            var total = Math.Max((int)(stats.At("totalEpisodeCount").Num() ?? 0), want);
            var seasonItems = mine.Where(q => q.SeasonNumber == number).ToList();
            var next = Date(stats.At("nextAiring").Str(), future: true);
            var seasonMonitored = node.At("monitored").Bool() ?? false;
            string state;
            if (want > 0 && have >= want)
            {
                state = "available";
            }
            else if (Summarise(seasonItems) is { } running)
            {
                state = running.State;
            }
            else if (have > 0)
            {
                state = "partial";
            }
            else if (!seasonMonitored)
            {
                state = "unmonitored";
            }
            else
            {
                state = want == 0 && total > 0 ? "waiting" : "searching";
            }

            rows.Add(new SeasonRow(number.Value, state, have, want, total, seasonItems.Count, next));
        }

        // Asked for everything: series Sonarr is not watching and holds nothing of are not part of the picture.
        if (wanted is null)
        {
            rows.RemoveAll(r => r.State == "unmonitored");
        }

        rows.Sort((a, b) => a.Number.CompareTo(b.Number));
        var haveTotal = rows.Sum(r => r.Have);
        var wantTotal = rows.Sum(r => r.Want);
        var nextAiring = rows.Select(r => r.NextAiring).Where(d => d is not null).Min();
        // A series that has not aired anything yet is not owed: only the rest counts as missing.
        var open = rows.Where(r => r.State is not ("available" or "waiting")).ToList();
        var openNumbers = open.Select(r => r.Number).ToHashSet();
        var downloading = Summarise(mine.Where(q => q.SeasonNumber is null || openNumbers.Contains(q.SeasonNumber.Value)).ToList());

        if (rows.Count == 0)
        {
            return new Activity("sonarr", seriesId, "unmonitored", monitored, null, null, null, null, 0, false, null, null, 0, 0, rows);
        }

        if (rows.All(r => r.State == "waiting"))
        {
            return new Activity("sonarr", seriesId, "waiting", monitored, null, null, null, null, 0, false, null, nextAiring, haveTotal, wantTotal, rows);
        }

        if (open.Count == 0)
        {
            return new Activity("sonarr", seriesId, "available", monitored, null, null, null, null, 0, false, null, nextAiring, haveTotal, wantTotal, rows);
        }

        if (downloading is not null)
        {
            return FromSummary("sonarr", seriesId, monitored, downloading, nextAiring, haveTotal, wantTotal, rows);
        }

        var overall = rows.Any(r => r.Have > 0) ? "partial"
            : open.All(r => r.State == "unmonitored") ? "unmonitored"
            : "searching";
        return new Activity("sonarr", seriesId, overall, monitored, null, null, null, null, 0, false, null, nextAiring, haveTotal, wantTotal, rows);
    }

    private static Activity FromSummary(string service, int arrId, bool monitored, Summary s, string? nextAiring, int? have, int? want, IReadOnlyList<SeasonRow>? rows)
    {
        var percent = s.State is "downloading" or "queued" && s.Size > 0
            ? Math.Round(Math.Clamp((s.Size - s.SizeLeft) * 100.0 / s.Size, 0, 100), 1)
            : (double?)null;
        return new Activity(service, arrId, s.State, monitored, percent, s.EtaSeconds, s.Size > 0 ? s.Size : null, s.Size > 0 ? s.SizeLeft : null, s.Count, s.Paused, null, nextAiring, have, want, rows);
    }

    // ---------- the admin's downloads ----------------------------------------------------------

    /// <summary>Every download in Sonarr's and Radarr's queues with SABnzbd's overall state.</summary>
    public static async Task<object> DownloadsAsync(UpstreamClient upstream)
    {
        var queueTask = QueueAsync(upstream);
        var sabTask = SabAsync(upstream);
        var queue = await queueTask.ConfigureAwait(false);
        var sab = await sabTask.ConfigureAwait(false);
        var settings = IntegrationSettings.Current;

        var rows = queue
            .GroupBy(i => (i.Source, i.DownloadId))
            .Select(g =>
            {
                var first = g.First();
                var episodes = g.Where(i => i.EpisodeNumber is not null).OrderBy(i => i.SeasonNumber).ThenBy(i => i.EpisodeNumber).ToList();
                return new
                {
                    id = $"{first.Source}:{first.DownloadId}".ToLowerInvariant(),
                    source = first.Source.ToString().ToLowerInvariant(),
                    kind = first.Source == ArrService.Radarr ? "movie" : "tv",
                    title = first.MediaTitle ?? first.Release,
                    year = first.MediaYear,
                    season = first.SeasonNumber,
                    episodes = g.Count(i => i.Source == ArrService.Sonarr),
                    episode = episodes.Count == 1 ? episodes[0].EpisodeNumber : null,
                    episodeTitle = episodes.Count == 1 ? episodes[0].EpisodeTitle : null,
                    release = first.Release,
                    state = first.State,
                    paused = first.Paused,
                    progress = first.Percent,
                    etaSeconds = first.EtaSeconds,
                    sizeBytes = first.Size > 0 ? (long?)first.Size : null,
                    sizeLeftBytes = first.Size > 0 ? (long?)first.SizeLeft : null,
                    client = first.Client,
                    protocol = first.Protocol,
                    message = first.Message,
                    links = ExternalLinks.For(settings, true, first.Source == ArrService.Radarr ? "movie" : "tv", first.TmdbId, first.Source, first.Slug),
                };
            })
            .OrderBy(r => Array.IndexOf(StatePriority, r.state))
            .ThenByDescending(r => r.progress ?? 0)
            .ToArray();

        return new
        {
            items = rows,
            sab = sab is null
                ? null
                : new
                {
                    status = sab.Paused ? "paused" : sab.Slots == 0 ? "idle" : "downloading",
                    paused = sab.Paused,
                    speedBps = sab.SpeedBps,
                    sizeLeftBytes = sab.SizeLeft,
                    etaSeconds = sab.EtaSeconds,
                    queued = sab.Slots,
                },
            links = ExternalLinks.Sabnzbd(settings, true),
            services = new
            {
                sonarr = settings.Enabled(ArrService.Sonarr),
                radarr = settings.Enabled(ArrService.Radarr),
                sabnzbd = settings.Enabled(ArrService.Sabnzbd),
            },
        };
    }

    // ---------- parsing ------------------------------------------------------------------------

    private static long Megabytes(JsonNode? node) => (long)((node.Num() ?? 0) * 1048576);

    /// <summary>Reads "0:12:34" or "1.02:03:04"; a download with no time left or no estimate gives null.</summary>
    private static int? Seconds(string? text)
        => TimeSpan.TryParse(text, CultureInfo.InvariantCulture, out var span) && span > TimeSpan.Zero ? (int)span.TotalSeconds : null;

    private static int? SecondsUntil(string? iso)
        => DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) && at > DateTimeOffset.UtcNow
            ? (int)(at - DateTimeOffset.UtcNow).TotalSeconds
            : null;

    /// <summary>The date part of an ISO timestamp; with <paramref name="future"/>, only a date still to come.</summary>
    private static string? Date(string? iso, bool future = false)
        => DateTimeOffset.TryParse(iso, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var at) && (!future || at > DateTimeOffset.UtcNow)
            ? at.UtcDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
            : null;
}
