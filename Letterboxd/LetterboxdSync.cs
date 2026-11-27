using Jellyfin.Plugin.HeraTv.Integrations;

namespace Jellyfin.Plugin.HeraTv.Letterboxd;

/// <summary>What one run did. <see cref="Pending"/> is how many watches are still waiting afterwards.</summary>
public sealed record SyncResult(int Logged, int Skipped, int Failed, int Pending);

/// <summary>
/// Writes the queued watches to each person's Letterboxd diary: finds the film, reads the diary's
/// dates, skips a date already there, marks a rewatch, and posts. Runs one at a time, whoever asks
/// (the watcher shortly after a film finishes, the daily task, or a person pressing Log now).
/// </summary>
/// <remarks>
/// Fails soft and says so once per kind of failure, like the notification centre. A film Letterboxd
/// can't match is skipped for good, because retrying it would hold up every later watch behind it.
/// A refused sign-in stops that person's run and asks them to link again; any other error stops it
/// too, leaving the rest for the next run rather than hammering a failing API.
/// </remarks>
public sealed class LetterboxdSync(LetterboxdStore store, ServerHealth health)
{
    /// <summary>What a link's error says when Letterboxd no longer accepts its refresh token.</summary>
    public const string SignInAgain = "Sign in to Letterboxd again";

    /// <summary>The most watches one run settles, so a long backlog is spread over several runs.</summary>
    public const int RunCap = 50;

    private readonly SemaphoreSlim running = new(1, 1);

    /// <summary>
    /// Processes the queue: one person's, or everyone's when <paramref name="userId"/> is null. Failed
    /// watches are retried only when asked for.
    /// </summary>
    public async Task<SyncResult> RunAsync(string? userId, bool includeFailed, int cap, CancellationToken ct)
    {
        var settings = IntegrationSettings.Current;
        if (!settings.LetterboxdEnabled)
        {
            return Tally(userId, 0, 0, 0);
        }

        // Nothing a run settles would be kept, so every run would write the same diary entries again. The store has already said why.
        if (store.IsReadOnly)
        {
            return Tally(userId, 0, 0, 0);
        }

        await running.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            int logged = 0, skipped = 0, failed = 0;
            foreach (var group in store.Due(userId, includeFailed).GroupBy(w => w.UserId))
            {
                ct.ThrowIfCancellationRequested();
                if (logged + skipped >= cap)
                {
                    break;
                }

                var (l, s, f) = await ProcessUser(settings, group.Key, group.ToList(), cap - logged - skipped, ct).ConfigureAwait(false);
                logged += l;
                skipped += s;
                failed += f;
            }

            if (logged + skipped > 0)
            {
                health.Recovered(FeatureOf("reach Letterboxd"));
                health.Recovered(FeatureOf("write the diary"));
            }

            return Tally(userId, logged, skipped, failed);
        }
        finally
        {
            running.Release();
        }
    }

    private SyncResult Tally(string? userId, int logged, int skipped, int failed)
        => new(logged, skipped, failed, store.Count(userId, WatchState.Pending));

    private async Task<(int Logged, int Skipped, int Failed)> ProcessUser(IntegrationSettings settings, string userId, List<WatchRow> rows, int cap, CancellationToken ct)
    {
        var link = store.GetLink(userId);
        if (link is null)
        {
            Settle(rows, WatchState.Skipped, "Letterboxd isn't linked");
            return (0, rows.Count, 0);
        }

        if (!link.LogFinished)
        {
            Settle(rows, WatchState.Skipped, "Logging was turned off");
            return (0, rows.Count, 0);
        }

        // Nothing can be written until they sign in again; their films wait.
        if (link.LastError == SignInAgain)
        {
            return (0, 0, 0);
        }

        var client = new LetterboxdClient(settings.LetterboxdApiKey!, settings.LetterboxdApiSecret!) { MemberId = link.MemberId };
        try
        {
            var token = await client.RefreshAsync(link.RefreshToken, ct).ConfigureAwait(false);
            if (token != link.RefreshToken)
            {
                store.SetRefreshToken(userId, token);
            }
        }
        catch (LetterboxdException ex) when (ex.Failure == LetterboxdFailure.KeyRejected)
        {
            // The server's key, not this person's account: don't ask them to sign in again.
            Fault("check the Letterboxd API key", ex);
            return (0, 0, 0);
        }
        catch (LetterboxdException ex) when (ex.NeedsSignIn)
        {
            store.SetError(userId, SignInAgain);
            Fault($"sign in to Letterboxd for {link.Username}", ex);
            return (0, 0, 0);
        }
        catch (LetterboxdException ex)
        {
            Fault("reach Letterboxd", ex);
            return (0, 0, 1);
        }

        int logged = 0, skipped = 0;
        // Diary reads can lag a write just made, so a film watched twice in one batch is tracked here as well.
        var loggedThisRun = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
        foreach (var row in rows)
        {
            if (logged + skipped >= cap)
            {
                break;
            }

            ct.ThrowIfCancellationRequested();
            try
            {
                var film = await client.FindFilmAsync(row.Tmdb, row.Imdb, row.Name, row.Year, ct).ConfigureAwait(false);
                if (film is null)
                {
                    store.Settle(row.Id, WatchState.Skipped, "No matching film on Letterboxd", DateTime.UtcNow);
                    skipped++;
                    continue;
                }

                var dates = await client.DiaryDatesAsync(film.Id, ct).ConfigureAwait(false);
                if (loggedThisRun.TryGetValue(film.Id, out var earlier))
                {
                    dates.UnionWith(earlier);
                }

                if (dates.Contains(row.WatchedOn))
                {
                    store.Settle(row.Id, WatchState.Skipped, "Already in your diary", DateTime.UtcNow);
                    skipped++;
                    continue;
                }

                var rewatch = dates.Any(d => string.CompareOrdinal(d, row.WatchedOn) < 0);
                await client.LogAsync(film.Id, row.WatchedOn, rewatch, ct).ConfigureAwait(false);
                var now = DateTime.UtcNow;
                store.Settle(row.Id, WatchState.Logged, rewatch ? "Rewatch" : null, now);
                store.MarkLogged(userId, now);
                if (!loggedThisRun.TryGetValue(film.Id, out var set))
                {
                    loggedThisRun[film.Id] = set = new HashSet<string>(StringComparer.Ordinal);
                }

                set.Add(row.WatchedOn);
                logged++;
            }
            catch (LetterboxdException ex) when (ex.NeedsSignIn)
            {
                store.SetError(userId, SignInAgain);
                Fault($"write to {link.Username}'s Letterboxd diary", ex);
                return (logged, skipped, 0);
            }
            catch (LetterboxdException ex)
            {
                // Stop here: the rest of this person's films wait for the next run.
                store.Settle(row.Id, WatchState.Failed, ex.Message, DateTime.UtcNow);
                Fault("write the diary", ex);
                return (logged, skipped, 1);
            }
        }

        return (logged, skipped, 0);
    }

    private void Settle(List<WatchRow> rows, string state, string detail)
        => store.SettleMany([.. rows.Select(r => r.Id)], state, detail, DateTime.UtcNow);

    /// <summary>Notes a failure: a warning the first time, then debug level until a run goes clean again.</summary>
    private void Fault(string what, Exception ex) => health.Fault(FeatureOf(what), what, ex);

    private static string FeatureOf(string what) => "Letterboxd: " + what;
}
