using System.Text.Json.Nodes;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// One Seerr user's requests, one entry per title, each joined to its state in the download stack.
/// The Your Requests row and activity page read it for the person looking at them; the
/// notification centre reads it on a timer for everyone, so both agree on where a request stands.
/// </summary>
public sealed class UserRequests(UpstreamClient upstream)
{
    // Seerr's own request rank: what still needs looking at comes first when several requests share a title.
    private static readonly string[] StatusRank = ["pending", "approved", "failed", "available", "declined"];

    private const int MaxParallel = 6;

    /// <summary>A title one user has requested.</summary>
    /// <param name="Type">"movie" or "tv".</param>
    /// <param name="Status">Seerr's request state, most urgent first when a title was requested more than once: pending, approved, failed, available or declined.</param>
    /// <param name="RequestedAt">When the title was last requested, as Seerr wrote it.</param>
    /// <param name="Title">Seerr's own record of the title: what the client's title shape is built from. It is the cached record itself, shared with every other reader, so it is never changed; <paramref name="Type"/> is its media type.</param>
    /// <param name="Activity">Where the download stack has it, or null when it isn't there or isn't set up.</param>
    public sealed record Entry(
        string Type,
        int TmdbId,
        string Status,
        string? RequestedAt,
        IReadOnlyList<int> Seasons,
        JsonNode Title,
        ArrActivity.Activity? Activity);

    /// <summary>The entries of one read, and SABnzbd's queue as it was for them.</summary>
    public sealed record Result(IReadOnlyList<Entry> Entries, ArrActivity.SabQueue? Sab);

    // Sonarr or Radarr connected, and the dashboard's "Request progress" switch on.
    public static bool ActivityOn() => IntegrationSettings.Current.ArrConnected && Plugin.Instance?.Configuration.ActivityEnabled != false;

    /// <summary>
    /// Reads a Seerr user's newest requests. Null when Seerr didn't answer, so a caller can tell
    /// "no requests" from "couldn't ask". A title whose own record can't be had is left out.
    /// </summary>
    /// <param name="seerrUser">The Seerr user.</param>
    /// <param name="take">How many of their newest requests.</param>
    /// <param name="skip">How many of their newest requests to pass over first.</param>
    /// <param name="background">
    /// A timer reading for the notification centre, not a person looking at a page: a request Seerr
    /// already calls available isn't looked up in the download stack (nothing about it can change
    /// what is announced), and what is looked up may be a minute old.
    /// </param>
    public async Task<Result?> LoadAsync(int seerrUser, int take, int skip = 0, bool background = false)
    {
        var live = ActivityOn();
        var queueTask = live ? ArrActivity.QueueAsync(upstream) : Task.FromResult<IReadOnlyList<ArrActivity.QueueItem>>([]);
        var sabTask = live ? ArrActivity.SabAsync(upstream) : Task.FromResult<ArrActivity.SabQueue?>(null);
        var node = await upstream.SeerrGetAsync($"api/v1/user/{seerrUser}/requests?take={take}&skip={skip}", TimeSpan.FromSeconds(20), seerrUser).ConfigureAwait(false);
        var queue = await queueTask.ConfigureAwait(false);
        var sab = await sabTask.ConfigureAwait(false);
        if (node is null)
        {
            return null;
        }

        // A title requested more than once (a series, then its next series) is one entry.
        var merged = new List<Merged>();
        foreach (var request in node["results"]?.AsArray() ?? [])
        {
            var media = request?["media"];
            var type = (string?)media?["mediaType"] ?? (string?)request?["type"];
            var tmdbId = media?["tmdbId"]?.GetValue<int?>();
            if (request is null || type is null || tmdbId is null)
            {
                continue;
            }

            var status = SeerrMapper.RequestStatus(request["status"]?.GetValue<int>() ?? 0);
            var seasons = (request["seasons"]?.AsArray() ?? []).Select(s => s?["seasonNumber"]?.GetValue<int?>()).OfType<int>().ToList();
            var existing = merged.Find(m => m.Type == type && m.TmdbId == tmdbId);
            if (existing is null)
            {
                merged.Add(new Merged(type, tmdbId.Value, media?["externalServiceId"]?.GetValue<int?>(), media?["tvdbId"]?.GetValue<int?>(), status, (string?)request["createdAt"], seasons));
                continue;
            }

            existing.Seasons.AddRange(seasons.Except(existing.Seasons));
            if (Array.IndexOf(StatusRank, status) < Array.IndexOf(StatusRank, existing.Status))
            {
                existing.Status = status;
            }

            if (string.CompareOrdinal((string?)request["createdAt"], existing.RequestedAt) > 0)
            {
                existing.RequestedAt = (string?)request["createdAt"];
            }
        }

        // A cold read of 60 titles is 60 Seerr calls and then a few *arr calls each: a handful at a time.
        using var gate = new SemaphoreSlim(MaxParallel);
        // The *arr reads keep their own short cache: they share keys with the pages that show a download's state.
        var entries = await Task.WhenAll(merged.Select(async m =>
        {
            await gate.WaitAsync().ConfigureAwait(false);
            try
            {
                // Request records carry ids only; the title's own record (cached) supplies the rest.
                var title = await upstream.SeerrGetAsync($"api/v1/{m.Type}/{m.TmdbId}?language=en", TimeSpan.FromHours(6)).ConfigureAwait(false);
                if (title is null)
                {
                    return null;
                }

                ArrActivity.Activity? activity = null;
                // Only an approved request can be in the download stack; an available one is there too, but only a page shows how.
                if (live && (m.Status == "approved" || (m.Status == "available" && !background)))
                {
                    activity = await LookUp(m.Type, m.TmdbId, m.ArrId, m.TvdbId ?? title["externalIds"]?["tvdbId"]?.GetValue<int?>(), m.Seasons, queue).ConfigureAwait(false);
                }

                return new Entry(m.Type, m.TmdbId, m.Status, m.RequestedAt, m.Seasons, title, activity);
            }
            finally
            {
                gate.Release();
            }
        })).ConfigureAwait(false);

        return new Result([.. entries.OfType<Entry>()], sab);
    }

    private Task<ArrActivity.Activity?> LookUp(string type, int tmdbId, int? arrId, int? tvdbId, IReadOnlyCollection<int> seasons, IReadOnlyList<ArrActivity.QueueItem> queue)
        => type == "tv"
            ? ArrActivity.SeriesAsync(upstream, tmdbId, tvdbId, arrId, seasons, queue)
            : ArrActivity.MovieAsync(upstream, tmdbId, arrId, queue);

    private sealed class Merged(string type, int tmdbId, int? arrId, int? tvdbId, string status, string? requestedAt, List<int> seasons)
    {
        public string Type { get; } = type;

        public int TmdbId { get; } = tmdbId;

        public int? ArrId { get; } = arrId;

        public int? TvdbId { get; } = tvdbId;

        public string Status { get; set; } = status;

        public string? RequestedAt { get; set; } = requestedAt;

        public List<int> Seasons { get; } = seasons;
    }
}
