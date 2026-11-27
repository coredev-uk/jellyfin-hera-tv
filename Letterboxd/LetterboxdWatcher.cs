using System.Globalization;
using Jellyfin.Plugin.HeraTv.Integrations;
using Jellyfin.Plugin.HeraTv.Stats;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.HeraTv.Letterboxd;

/// <summary>
/// Notices films people finish and logs them to their Letterboxd diary a minute later.
/// </summary>
/// <remarks>
/// A film counts when its playback stops having run to completion: Jellyfin's own judgement, at its
/// resume threshold, the equivalent of "watched to the end". Starting a film already watched and
/// stopping early isn't a completion, and marking a film watched by hand involves no playback, so
/// neither counts. The title, ids and the server's local date are captured when it happens, so a
/// file deleted later still logs. The minute's wait lets a burst (a few films finished together, or
/// the same one twice) go in a single run. While Letterboxd is off the watcher does nothing at all,
/// not even open its database.
/// </remarks>
public sealed class LetterboxdWatcher(ISessionManager sessions, LetterboxdStore store, LetterboxdSync sync, ILogger<LetterboxdWatcher> logger, ServerHealth health) : GuardedBackgroundService(Feature, health)
{
    /// <summary>The name the dashboard and the log know this feature by.</summary>
    internal const string Feature = "Letterboxd logging";

    private static readonly TimeSpan Debounce = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan AfterStart = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan Tick = TimeSpan.FromSeconds(15);

    private long dueAt;

    /// <summary>Asks for the queue to be processed once things have gone quiet for a minute.</summary>
    public void Schedule() => Interlocked.Exchange(ref dueAt, (DateTime.UtcNow + Debounce).Ticks);

    /// <summary>Captures a film someone watched as it is now: its title, ids and the server's local date.</summary>
    internal static WatchDraft Draft(string userId, MediaBrowser.Controller.Entities.BaseItem item, DateTime watchedLocal)
        => new(
            userId,
            item.Id.ToString("N"),
            item.TryGetProviderId(MetadataProvider.Tmdb, out var tmdb) ? tmdb : null,
            item.TryGetProviderId(MetadataProvider.Imdb, out var imdb) ? imdb : null,
            item.Name ?? string.Empty,
            item.ProductionYear,
            Clock.DateString(watchedLocal));

    /// <summary>Queues a film someone watched. False when it was already queued for that day, or couldn't be saved.</summary>
    internal bool Enqueue(string userId, MediaBrowser.Controller.Entities.BaseItem item, DateTime watchedLocal)
        => store.Enqueue(Draft(userId, item, watchedLocal), DateTime.UtcNow);

    /// <summary>Queues many watches in one step; returns how many were new.</summary>
    internal int EnqueueMany(IReadOnlyList<WatchDraft> drafts) => store.EnqueueMany(drafts, DateTime.UtcNow);

    protected override async Task RunAsync(CancellationToken stoppingToken)
    {
        sessions.PlaybackStopped += OnStopped;
        try
        {
            using var timer = new PeriodicTimer(Tick);
            var resumed = false;
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                if (!IntegrationSettings.Current.LetterboxdEnabled)
                {
                    // Switched off: nothing is read or written, and what a restart interrupted is looked at again when it comes on.
                    resumed = false;
                    continue;
                }

                if (!resumed)
                {
                    resumed = true;
                    // Whatever a restart interrupted.
                    if (store.Count(null, WatchState.Pending) > 0)
                    {
                        Interlocked.Exchange(ref dueAt, (DateTime.UtcNow + AfterStart).Ticks);
                    }
                }

                var due = Interlocked.Read(ref dueAt);
                if (due == 0 || due > DateTime.UtcNow.Ticks)
                {
                    continue;
                }

                Interlocked.CompareExchange(ref dueAt, 0, due);
                try
                {
                    var result = await sync.RunAsync(null, false, LetterboxdSync.RunCap, stoppingToken).ConfigureAwait(false);
                    Health.Recovered(Feature);

                    // A backlog is worked through a run at a time, for as long as runs make progress.
                    if (result.Pending > 0 && result.Logged + result.Skipped > 0)
                    {
                        Schedule();
                    }
                }
                catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    Health.Fault(Feature, "log films to Letterboxd; the daily task will try again", ex);
                }
            }
        }
        finally
        {
            sessions.PlaybackStopped -= OnStopped;
        }
    }

    private void OnStopped(object? sender, PlaybackStopEventArgs e)
    {
        try
        {
            if (!e.PlayedToCompletion || e.Item is not Movie movie || !IntegrationSettings.Current.LetterboxdEnabled)
            {
                return;
            }

            foreach (var user in e.Users)
            {
                var userId = user.Id.ToString("N");
                if (store.GetLink(userId) is not { LogFinished: true } || !Enqueue(userId, movie, DateTime.Now))
                {
                    continue;
                }

                logger.LogDebug("Queued {Film} ({Year}) for Letterboxd", movie.Name, movie.ProductionYear?.ToString(CultureInfo.InvariantCulture));
                Schedule();
            }
        }
        catch (Exception ex)
        {
            // Never let this reach playback.
            logger.LogDebug(ex, "Hera TV couldn't queue a finished film for Letterboxd");
        }
    }
}
