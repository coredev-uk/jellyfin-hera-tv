using Jellyfin.Plugin.HeraTv.Integrations;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.HeraTv.Letterboxd;

/// <summary>
/// Retries every film still waiting for the Letterboxd diary each morning: anything a run left
/// pending, and anything that failed. The watcher does the first attempt a minute after a film ends.
/// </summary>
public sealed class LogFilmsToLetterboxdTask(LetterboxdSync sync, LetterboxdStore store) : IScheduledTask
{
    public string Name => "Log films to Letterboxd";

    public string Key => "HeraTvLetterboxd";

    public string Description => "Writes the films people have finished watching to their linked Letterboxd diaries, retrying any that couldn't be logged earlier.";

    public string Category => "Hera TV";

    public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        if (IntegrationSettings.Current.LetterboxdEnabled)
        {
            // Each run settles a capped number of films; keep going while runs make progress. Failed
            // films are retried on the first pass only, so one bad night can't use up their attempts.
            for (var run = 0; run < 20; run++)
            {
                var result = await sync.RunAsync(null, run == 0, LetterboxdSync.RunCap, cancellationToken).ConfigureAwait(false);
                if (result.Logged + result.Skipped == 0 || store.Count(null, WatchState.Pending) == 0)
                {
                    break;
                }
            }

            store.Prune(DateTime.UtcNow);
        }

        progress.Report(100);
    }

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        yield return new TaskTriggerInfo
        {
            Type = TaskTriggerInfoType.DailyTrigger,
            TimeOfDayTicks = new TimeSpan(4, 30, 0).Ticks,
        };
    }
}
