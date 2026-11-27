using System.Text.Json;
using System.Text.Json.Nodes;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.HeraTv.Integrations;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.HeraTv.Collections;

/// <summary>A streaming service, as TMDB's watch-provider list names it. One service has several ids: its ad tier, its Amazon or Apple TV channel.</summary>
/// <param name="Key">The slug the set and row ids carry.</param>
/// <param name="Name">The service's name.</param>
/// <param name="Ids">TMDB provider ids, checked against Seerr's <c>/watchproviders</c> list for GB.</param>
/// <param name="Network">
/// The TMDB network whose logo is the service's wordmark, as Seerr's Networks row draws it, or null
/// when TMDB has no network for the service (NOW, Sky Go and BBC iPlayer have none of their own);
/// those show the provider's app icon instead. Checked against Seerr's <c>/network/{id}</c>.
/// </param>
internal sealed record StreamingProvider(string Key, string Name, int[] Ids, int? Network)
{
    /// <summary>
    /// The services a UK household is likely to have, in the order they are listed. Ids are TMDB's
    /// (Seerr passes them through): 8 Netflix, 9 Amazon Prime Video, 337 Disney Plus, 350 Apple TV,
    /// 39 Now TV, 531 Paramount Plus, 41 ITVX, 38 BBC iPlayer, 103 Channel 4, 29 Sky Go. Networks:
    /// 213 Netflix, 1024 Prime Video, 2739 Disney+, 2552 Apple TV, 4330 Paramount+, 5871 ITVX, 26 Channel 4.
    /// </summary>
    public static readonly IReadOnlyList<StreamingProvider> All =
    [
        new("netflix", "Netflix", [8, 1796, 175], 213),
        new("prime-video", "Prime Video", [9, 2100, 613], 1024),
        new("disney-plus", "Disney+", [337], 2739),
        new("apple-tv", "Apple TV+", [350], 2552),
        new("now", "NOW", [39, 591], null),
        new("paramount-plus", "Paramount+", [531, 582, 1853, 2303, 2304], 4330),
        new("itvx", "ITVX", [41, 2300], 5871),
        new("bbc-iplayer", "BBC iPlayer", [38], null),
        new("channel-4", "Channel 4", [103, 2311], 26),
        new("sky-go", "Sky Go", [29], null),
    ];

    public static StreamingProvider? Find(string key) => All.FirstOrDefault(p => string.Equals(p.Key, key, StringComparison.Ordinal));
}

/// <summary>A service's logos as TMDB image paths: its wordmark (a network logo) and its app icon.</summary>
internal sealed record ProviderLogo(string? Wordmark, string? Icon);

/// <summary>Where the library's titles stream in the watch region, and which of them are trending, as of one fetch.</summary>
internal sealed class StreamingSnapshot
{
    /// <summary>Gets or sets when Seerr was asked.</summary>
    public DateTimeOffset Fetched { get; set; }

    /// <summary>Gets or sets the country the providers are for.</summary>
    public string Region { get; set; } = "GB";

    /// <summary>Gets or sets TMDB provider ids by title (<c>movie:603</c>), subscription and free tiers only.</summary>
    public Dictionary<string, int[]> Titles { get; set; } = [];

    /// <summary>Gets or sets the titles Seerr lists as trending, most trending first, as <c>movie:603</c>.</summary>
    public List<string> Trending { get; set; } = [];

    /// <summary>Gets or sets each service's logos by provider key, as TMDB image paths.</summary>
    public Dictionary<string, ProviderLogo> Logos { get; set; } = [];

    public bool Has(StreamingProvider provider, string key)
        => key.Length > 0 && Titles.TryGetValue(key, out var ids) && ids.Any(id => Array.IndexOf(provider.Ids, id) >= 0);
}

/// <summary>
/// Streaming availability and trending, fetched from Seerr once a day and kept in the plugin's data
/// folder. A title's flat-rate providers come from Seerr's own page for it (the same data "Also
/// on" shows) rather than from paging through the discover lists with a provider filter: those
/// lists run to thousands of titles a service, and a library title that isn't popular enough to
/// be near the front would never turn up in them.
/// </summary>
/// <remarks>
/// It fails soft. If Seerr is down the last file stays in use, however old; a title Seerr can't
/// answer for keeps what it was last known to have.
/// </remarks>
internal sealed class StreamingCache(UpstreamClient upstream, ILibraryManager libraryManager, ILogger<StreamingCache> logger, ServerHealth health)
{
    private const string Feature = "Streaming availability";

    /// <summary>A refresh that finds fewer than this share of the titles the last snapshot had on a service is taken for a broken answer, not a real change.</summary>
    private const int DropFactor = 5;

    /// <summary>Below this many titles on a service in the last snapshot, a drop proves nothing: a small library may truly lose them all.</summary>
    private const int ComparableTitles = 10;

    /// <summary>Older than this and a read starts a refresh in the background; the nightly task normally gets there first.</summary>
    private static readonly TimeSpan Stale = TimeSpan.FromHours(30);

    /// <summary>The least time between one read-triggered refresh starting and the next, however the first went.</summary>
    private static readonly TimeSpan RetryAfter = TimeSpan.FromMinutes(15);

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly Lock _gate = new();
    private StreamingSnapshot? _current;
    private bool _loaded;
    private int _refreshing;
    private long _nextAttempt;
    private volatile string? _attemptRegion;

    /// <summary>Gets the latest snapshot, or null when none has ever been fetched.</summary>
    public StreamingSnapshot? Current
    {
        get
        {
            lock (_gate)
            {
                if (!_loaded)
                {
                    _current = Read();
                    _loaded = true;
                }

                return _current;
            }
        }
    }

    private static string Region
    {
        get
        {
            var region = Plugin.Instance?.Configuration.WatchRegion;
            return string.IsNullOrWhiteSpace(region) ? "GB" : region.Trim().ToUpperInvariant();
        }
    }

    /// <summary>Starts a refresh without waiting for it, when the snapshot is missing, for another region, or stale. Never throws.</summary>
    public void RefreshIfStale()
    {
        var current = Current;
        if (!IntegrationSettings.Current.SeerrEnabled
            || (current is not null && current.Region == Region && DateTimeOffset.UtcNow - current.Fetched < Stale)
            || (_attemptRegion == Region && Environment.TickCount64 < Interlocked.Read(ref _nextAttempt))
            || Interlocked.Exchange(ref _refreshing, 1) == 1)
        {
            return;
        }

        // However it ends, the next read leaves it alone for a while: a Seerr that is down (or has nothing to
        // say) would otherwise start a whole library's worth of calls from every home-row build. A new
        // region is not kept waiting.
        _attemptRegion = Region;
        Interlocked.Exchange(ref _nextAttempt, Environment.TickCount64 + (long)RetryAfter.TotalMilliseconds);
        _ = Task.Run(async () =>
        {
            try
            {
                await RefreshCoreAsync(CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                health.Fault(Feature, "refresh streaming availability", ex);
            }
            finally
            {
                Interlocked.Exchange(ref _refreshing, 0);
            }
        });
    }

    /// <summary>Fetches everything again. Returns false (keeping what it had) when Seerr isn't set up or answered for nothing.</summary>
    public async Task<bool> RefreshAsync(CancellationToken cancellationToken)
    {
        // A background refresh already running does the same work; wait for it rather than doubling the calls.
        while (Interlocked.Exchange(ref _refreshing, 1) == 1)
        {
            await Task.Delay(500, cancellationToken).ConfigureAwait(false);
        }

        try
        {
            return await RefreshCoreAsync(cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            Interlocked.Exchange(ref _refreshing, 0);
        }
    }

    private async Task<bool> RefreshCoreAsync(CancellationToken cancellationToken)
    {
        if (!IntegrationSettings.Current.SeerrEnabled)
        {
            return false;
        }

        var region = Region;
        var previous = Current;
        var carry = previous is not null && previous.Region == region ? previous.Titles : [];

        var library = Title.From(libraryManager.GetItemList(new InternalItemsQuery
        {
            IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
            Recursive = true,
            IsVirtualItem = false,
        })).Where(t => t.Tmdb is not null).ToList();

        var titles = new System.Collections.Concurrent.ConcurrentDictionary<string, int[]>(StringComparer.Ordinal);
        var answered = 0;
        await Parallel.ForEachAsync(library, new ParallelOptions { MaxDegreeOfParallelism = 4, CancellationToken = cancellationToken }, async (title, token) =>
        {
            var node = await upstream.SeerrGetAsync($"api/v1/{(title.IsSeries ? "tv" : "movie")}/{title.Tmdb}?language=en", TimeSpan.Zero).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            if (node is null)
            {
                if (carry.TryGetValue(title.Key, out var known))
                {
                    titles[title.Key] = known;
                }

                return;
            }

            Interlocked.Increment(ref answered);
            titles[title.Key] = Flatrate(node, region);
        }).ConfigureAwait(false);

        if (library.Count > 0 && answered == 0)
        {
            health.Fault(Feature, "refresh streaming availability: Seerr gave none for any title, so the last snapshot is kept");
            return false;
        }

        // Seerr answering, but with providers for hardly any title it used to, is a changed answer (a renamed
        // field reads as "no providers") far more often than a library that left every service at once.
        // Keeping the last snapshot keeps the "On <service>" collections the build would otherwise delete.
        var withProviders = titles.Count(t => t.Value.Length > 0);
        if (previous is not null && previous.Region == region)
        {
            var hadProviders = previous.Titles.Count(t => t.Value.Length > 0);
            if (hadProviders >= ComparableTitles && withProviders * DropFactor < hadProviders)
            {
                health.Fault(Feature, string.Create(System.Globalization.CultureInfo.InvariantCulture, $"refresh streaming availability: only {withProviders} titles had a streaming service where the last snapshot had {hadProviders}. Seerr's answers may have changed shape, so the last snapshot is kept"));

                // The next full sweep is a day's work for nothing if Seerr still answers the same way: leave it until the snapshot would be stale.
                _attemptRegion = region;
                Interlocked.Exchange(ref _nextAttempt, Environment.TickCount64 + (long)Stale.TotalMilliseconds);
                return false;
            }
        }

        var trending = new List<string>();
        for (var page = 1; page <= 5; page++)
        {
            var node = await upstream.SeerrGetAsync($"api/v1/discover/trending?page={page}&language=en", TimeSpan.Zero).ConfigureAwait(false);
            if (node.At("results") is not JsonArray results)
            {
                break;
            }

            foreach (var result in results.Items())
            {
                var type = result.At("mediaType").Str();
                if (type is "movie" or "tv" && result.At("id").Int() is int id)
                {
                    trending.Add(Keys.Of(type, id));
                }
            }
        }

        var logos = await LogosAsync(region, previous?.Logos ?? []).ConfigureAwait(false);

        // A failed trending call leaves yesterday's list rather than an empty one.
        var next = new StreamingSnapshot
        {
            Fetched = DateTimeOffset.UtcNow,
            Region = region,
            Titles = new Dictionary<string, int[]>(titles, StringComparer.Ordinal),
            Trending = trending.Count > 0 ? trending : previous?.Trending ?? [],
            Logos = logos,
        };
        Write(next);
        lock (_gate)
        {
            _current = next;
            _loaded = true;
        }

        health.Recovered(Feature);
        logger.LogInformation("Hera TV: streaming availability for {Region} refreshed: {Titles} titles, {WithProviders} on a service, {Trending} trending, {Logos} logos", region, titles.Count, withProviders, next.Trending.Count, logos.Count);
        return true;
    }

    /// <summary>
    /// Each service's wordmark (its TMDB network's logo, as Seerr's Networks row shows them) and app
    /// icon (the watch-provider logo). A service Seerr can't answer for keeps what it had.
    /// </summary>
    private async Task<Dictionary<string, ProviderLogo>> LogosAsync(string region, Dictionary<string, ProviderLogo> previous)
    {
        var icons = new Dictionary<int, string>();
        foreach (var kind in new[] { "movies", "tv" })
        {
            var list = await upstream.SeerrGetAsync($"api/v1/watchproviders/{kind}?watchRegion={region}", TimeSpan.Zero).ConfigureAwait(false);
            foreach (var provider in list.Items())
            {
                if (provider.At("id").Int() is int id && provider.At("logoPath").Str() is { Length: > 0 } path)
                {
                    icons.TryAdd(id, path);
                }
            }
        }

        var logos = new Dictionary<string, ProviderLogo>(StringComparer.Ordinal);
        foreach (var service in StreamingProvider.All)
        {
            string? wordmark = null;
            if (service.Network is int network)
            {
                var node = await upstream.SeerrGetAsync($"api/v1/network/{network}", TimeSpan.Zero).ConfigureAwait(false);
                wordmark = node.At("logoPath").Str();
            }

            var icon = service.Ids.Select(id => icons.GetValueOrDefault(id)).FirstOrDefault(path => path is not null);
            previous.TryGetValue(service.Key, out var known);
            wordmark ??= known?.Wordmark;
            icon ??= known?.Icon;
            if (wordmark is not null || icon is not null)
            {
                logos[service.Key] = new ProviderLogo(wordmark, icon);
            }
        }

        return logos;
    }

    /// <summary>The provider ids that carry a title on subscription or free with ads in a region.</summary>
    private static int[] Flatrate(JsonNode title, string region)
    {
        var ids = new List<int>();
        foreach (var entry in title.At("watchProviders").Items())
        {
            if (entry.At("iso_3166_1").Str() != region)
            {
                continue;
            }

            foreach (var tier in new[] { "flatrate", "ads", "free" })
            {
                foreach (var provider in entry.At(tier).Items())
                {
                    if (provider.At("id").Int() is int id && !ids.Contains(id))
                    {
                        ids.Add(id);
                    }
                }
            }
        }

        return [.. ids];
    }

    private static string? DataFile
    {
        get
        {
            var folder = Plugin.Instance?.DataFolderPath;
            return folder is null ? null : Path.Combine(folder, "streaming.json");
        }
    }

    private StreamingSnapshot? Read()
    {
        try
        {
            var file = DataFile;
            return file is not null && System.IO.File.Exists(file)
                ? JsonSerializer.Deserialize<StreamingSnapshot>(System.IO.File.ReadAllText(file), Json)
                : null;
        }
        catch (JsonException ex)
        {
            // Unreadable, and about to be fetched again and replaced: keep what was there.
            health.Fault(Feature, $"read its streaming availability file ({DamagedFiles.Describe(DamagedFiles.Keep(DataFile!))}); it will be fetched again", ex);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            health.Fault(Feature, "read its streaming availability file; it will be fetched again", ex);
            return null;
        }
    }

    private void Write(StreamingSnapshot snapshot)
    {
        try
        {
            var file = DataFile;
            if (file is null)
            {
                return;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            // Written beside, then moved over, so a crash mid-write never leaves half a file as the "last good" copy.
            var temporary = file + ".tmp";
            System.IO.File.WriteAllText(temporary, JsonSerializer.Serialize(snapshot, Json));
            System.IO.File.Move(temporary, file, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            health.Fault(Feature, "save its streaming availability file", ex);
        }
    }
}
