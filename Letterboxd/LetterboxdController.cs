using System.Globalization;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using Jellyfin.Plugin.HeraTv.Integrations;
using Jellyfin.Plugin.HeraTv.Stats;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.HeraTv.Letterboxd;

/// <summary>
/// Each person's own Letterboxd link: connect, switch logging on or off, import past watches, log now,
/// disconnect. Everything runs as the signed-in Jellyfin user and touches only their own link. The
/// password is used once to sign in and is never kept or logged; what is stored is the refresh token.
/// </summary>
[ApiController]
[Authorize]
[Route("HeraTV/letterboxd")]
public class LetterboxdController(
    LetterboxdStore store,
    LetterboxdSync sync,
    LetterboxdWatcher watcher,
    ILibraryManager libraryManager,
    IUserManager userManager,
    IUserDataManager userData,
    ILogger<LetterboxdController> logger) : ControllerBase
{
    // A person waiting on "Log now" gets a shorter run than the background's.
    private const int InteractiveCap = 20;

    private const int RecentCount = 5;

    /// <summary>Gets this person's link, how their diary is going and the last few films it logged or skipped.</summary>
    [HttpGet]
    public IActionResult Get()
        => CurrentUser() is { } user ? Ok(Describe(user)) : Unauthorized();

    /// <summary>Signs in to Letterboxd with the person's own username (or email) and password, once, and keeps the link.</summary>
    [HttpPost("link")]
    public async Task<IActionResult> Link([FromBody] LinkBody? body, CancellationToken ct)
    {
        if (CurrentUser() is not { } user)
        {
            return Unauthorized();
        }

        var settings = IntegrationSettings.Current;
        if (!settings.LetterboxdEnabled)
        {
            return BadRequest(new { message = "Letterboxd isn't set up on this server. Ask an administrator to add its API key." });
        }

        var name = body?.Username?.Trim();
        var password = body?.Password;
        if (string.IsNullOrEmpty(name) || string.IsNullOrEmpty(password))
        {
            return BadRequest(new { message = "Enter your Letterboxd username and password." });
        }

        try
        {
            var client = new LetterboxdClient(settings.LetterboxdApiKey!, settings.LetterboxdApiSecret!);
            var (refresh, memberId, username) = await client.SignInAsync(name, password, ct).ConfigureAwait(false);
            if (!store.SaveLink(user.Id.ToString("N"), username, memberId, refresh, DateTime.UtcNow))
            {
                return BadRequest(new { message = "Couldn't save the link. Try again in a moment." });
            }
        }
        catch (LetterboxdException ex)
        {
            // The sign-in's own reply is never in the message; the password never is either.
            logger.LogWarning("Letterboxd sign-in for {User} failed: {Reason}", user.Username, ex.Message);
            return BadRequest(new
            {
                message = ex.Failure switch
                {
                    LetterboxdFailure.BadCredentials => "Letterboxd didn't accept that username or password.",
                    LetterboxdFailure.KeyRejected => "Letterboxd refused this server's API key. Ask an administrator to check it.",
                    LetterboxdFailure.Unreachable or LetterboxdFailure.RateLimited => "Couldn't reach Letterboxd. Try again in a minute.",
                    _ => "Letterboxd gave an unexpected reply. Try again in a minute.",
                },
            });
        }

        // Films queued while the link needed signing in again can go now.
        if (store.Count(user.Id.ToString("N"), WatchState.Pending) > 0)
        {
            watcher.Schedule();
        }

        return Ok(Describe(user));
    }

    /// <summary>Forgets the link and everything queued or recorded for it. Nothing on Letterboxd is touched.</summary>
    [HttpDelete("link")]
    public IActionResult Unlink()
    {
        if (CurrentUser() is not { } user)
        {
            return Unauthorized();
        }

        store.Unlink(user.Id.ToString("N"));
        return Ok(Describe(user));
    }

    /// <summary>Switches "Log films you finish" on or off.</summary>
    [HttpPost("prefs")]
    public IActionResult SetPrefs([FromBody] PrefsBody? body)
    {
        if (CurrentUser() is not { } user)
        {
            return Unauthorized();
        }

        if (store.GetLink(user.Id.ToString("N")) is null)
        {
            return BadRequest(new { message = "Connect Letterboxd first." });
        }

        if (body?.LogFinished is not { } on)
        {
            return BadRequest(new { message = "Say whether to log the films you finish." });
        }

        store.SetLogFinished(user.Id.ToString("N"), on);
        return Ok(Describe(user));
    }

    /// <summary>
    /// A one-off backfill: this person's films played since a date, queued on the local date they were last
    /// played. The diary's own dates stop a film already logged from going in twice.
    /// </summary>
    [HttpPost("import")]
    public IActionResult Import([FromBody] ImportBody? body)
    {
        if (CurrentUser() is not { } user)
        {
            return Unauthorized();
        }

        var userId = user.Id.ToString("N");
        if (store.GetLink(userId) is null)
        {
            return BadRequest(new { message = "Connect Letterboxd first." });
        }

        if (!DateTime.TryParseExact(body?.Since, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var since))
        {
            return BadRequest(new { message = "Choose a date to import from." });
        }

        var cutoff = Clock.ToUtc(since.Date);
        var movies = libraryManager.GetItemList(new InternalItemsQuery(user)
        {
            IncludeItemTypes = [BaseItemKind.Movie],
            Recursive = true,
            IsPlayed = true,
            IsVirtualItem = false,
        });
        var data = userData.GetUserDataBatch(movies, user);

        // One transaction for the lot, not a connection per film.
        var drafts = new List<WatchDraft>();
        foreach (var movie in movies)
        {
            if (data.TryGetValue(movie.Id, out var played) && played.LastPlayedDate is { } last && last >= cutoff)
            {
                drafts.Add(LetterboxdWatcher.Draft(userId, movie, Clock.FromUtc(last)));
            }
        }

        var found = drafts.Count;
        var queued = watcher.EnqueueMany(drafts);
        if (queued > 0)
        {
            watcher.Schedule();
        }

        return Ok(new { found, queued });
    }

    /// <summary>Logs this person's waiting films now, a few at a time, and says how it went.</summary>
    [HttpPost("sync")]
    public async Task<IActionResult> Sync(CancellationToken ct)
    {
        if (CurrentUser() is not { } user)
        {
            return Unauthorized();
        }

        var userId = user.Id.ToString("N");
        if (store.GetLink(userId) is null)
        {
            return BadRequest(new { message = "Connect Letterboxd first." });
        }

        var result = await sync.RunAsync(userId, true, InteractiveCap, ct).ConfigureAwait(false);
        if (result.Pending > 0 && result.Logged + result.Skipped > 0)
        {
            watcher.Schedule();
        }

        return Ok(new { logged = result.Logged, skipped = result.Skipped, failed = result.Failed, pending = result.Pending });
    }

    private object Describe(User user)
    {
        var userId = user.Id.ToString("N");
        var enabled = IntegrationSettings.Current.LetterboxdEnabled;
        if (store.GetLink(userId) is not { } link)
        {
            return new { enabled, linked = false };
        }

        return new
        {
            enabled,
            linked = true,
            username = link.Username,
            logFinished = link.LogFinished,
            linkedAt = link.LinkedAt,
            lastLoggedAt = link.LastLoggedAt,
            lastError = link.LastError,
            pending = store.Count(userId, WatchState.Pending),
            failed = store.Count(userId, WatchState.Failed),
            recent = store.Recent(userId, RecentCount).Select(w => new { name = w.Name, year = w.Year, watchedOn = w.WatchedOn, state = w.State, detail = w.Detail }),
        };
    }

    private User? CurrentUser()
    {
        var claim = User.FindFirst("Jellyfin-UserId")?.Value;
        return Guid.TryParse(claim, out var id) ? userManager.GetUserById(id) : null;
    }

    public sealed class LinkBody
    {
        public string? Username { get; set; }

        public string? Password { get; set; }
    }

    public sealed class PrefsBody
    {
        public bool? LogFinished { get; set; }
    }

    public sealed class ImportBody
    {
        public string? Since { get; set; }
    }
}
