using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.HeraTv.Stats;

/// <summary>
/// Notes every playing stream once a minute: who, what, how it was delivered and at what size and
/// rate. Jellyfin forgets all of it when a stream ends and Playback Reporting never stored it, so
/// concurrent streams, resolution, bitrate and transcoding can only be reported from the day this
/// first ran.
/// </summary>
/// <remarks>
/// Nothing here may take the server down: a failed tick is logged and the next one runs as normal.
/// </remarks>
internal sealed class StreamRecorder(ISessionManager sessions, StatsStore store, ILogger<StreamRecorder> logger) : BackgroundService
{
    private DateTime pruned = DateTime.MinValue;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(StatsStore.SampleSeconds));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                Tick(DateTime.UtcNow);
            }
        }
        catch (OperationCanceledException)
        {
            // The server is stopping.
        }
    }

    private void Tick(DateTime now)
    {
        try
        {
            var samples = new List<Sample>();
            foreach (var session in sessions.Sessions)
            {
                // A paused stream isn't being delivered, so it doesn't count towards concurrency or the mix.
                if (session.NowPlayingItem is not { } item || session.PlayState?.IsPaused == true || session.UserId == Guid.Empty)
                {
                    continue;
                }

                var stream = StreamInfo.From(session);
                if (stream is null)
                {
                    continue;
                }

                samples.Add(new Sample(
                    session.UserId.ToString("N"),
                    item.Id.ToString("N"),
                    stream.PlayMethod,
                    stream.Source.Width,
                    stream.Source.Height,
                    stream.Source.Bitrate,
                    stream.Transcode?.Width,
                    stream.Transcode?.Height,
                    stream.Transcode?.Bitrate,
                    stream.Transcode?.Hardware ?? false,
                    string.Join(',', stream.Transcode?.Reasons ?? [])));
            }

            store.Add(now, samples);

            if (pruned.Date != now.Date)
            {
                // Once the day's prune has run, even a failed one waits for tomorrow: the table is tiny
                // and a retry every minute would only repeat the same logged failure.
                pruned = now;
                store.Prune(now);
            }
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Hera TV couldn't sample the playing streams");
        }
    }
}
