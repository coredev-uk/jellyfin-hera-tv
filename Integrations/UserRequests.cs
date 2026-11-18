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

    /// <summary>A title one user has requested.</summary>
    /// <param name="Type">"movie" or "tv".</param>
    /// <param name="Status">Seerr's request state, most urgent first when a title was requested more than once: pending, approved, failed, available or declined.</param>
    /// <param name="RequestedAt">When the title was last requested, as Seerr wrote it.</param>
    /// <param name="Title">Seerr's own record of the title, with <c>mediaType</c> set; what the client's title shape is built from.</param>
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
    public static bool ActivityOn() => IntegrationSettings.Current.ActivityEnabled && Plugin.Instance?.Configuration.ActivityEnabled != false;

    /// <summary>
    /// Reads a Seerr user's newest requests. Null when Seerr didn't answer, so a caller can tell
    /// "no requests" from "couldn't ask". A title whose own record can't be had is left out.
    /// </summary>
    public async Task<Result?> LoadAsync(int seerrUser, int take)
    {
        var live = ActivityOn();
        var queueTask = live ? ArrActivity.QueueAsync(upstream) : Task.FromResult<IReadOnlyList<ArrActivity.QueueItem>>([]);
        var sabTask = live ? ArrActivity.SabAsync(upstream) : Task.FromResult<ArrActivity.SabQueue?>(null);
        var node = await upstream.SeerrGetAsync($"api/v1/user/{seerrUser}/requests?take={take}&skip=0", TimeSpan.FromSeconds(20), seerrUser).ConfigureAwait(false);
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

        var entries = await Task.WhenAll(merged.Select(async m =>
        {
            // Request records carry ids only; the title's own record (cached) supplies the rest.
            var title = await upstream.SeerrGetAsync($"api/v1/{m.Type}/{m.TmdbId}?language=en", TimeSpan.FromHours(6)).ConfigureAwait(false);
            if (title is null)
            {
                return null;
            }

            title["mediaType"] = m.Type;
            ArrActivity.Activity? activity = null;
            // Only an approved request can be in the download stack.
            if (live && m.Status is "approved" or "available")
            {
                activity = await LookUp(m.Type, m.TmdbId, m.ArrId, m.TvdbId ?? title["externalIds"]?["tvdbId"]?.GetValue<int?>(), m.Seasons, queue).ConfigureAwait(false);
            }

            return new Entry(m.Type, m.TmdbId, m.Status, m.RequestedAt, m.Seasons, title, activity);
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
