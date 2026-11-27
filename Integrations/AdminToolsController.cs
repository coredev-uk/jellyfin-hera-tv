using Jellyfin.Plugin.HeraTv.Collections;
using Jellyfin.Plugin.HeraTv.Letterboxd;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>What an administrator can see and start from the dashboard besides the settings: who has linked Letterboxd, and the collections build. Admin only.</summary>
[ApiController]
[Authorize(Policy = HeraUser.Elevated)]
[Route("HeraTV/settings")]
public class AdminToolsController(
    ICollectionBuilder collectionBuilder,
    ITaskManager taskManager,
    LetterboxdStore letterboxd,
    IUserManager userManager) : ControllerBase
{
    /// <summary>Which Jellyfin users have linked Letterboxd, and how each diary is going. Tokens never leave the server.</summary>
    [HttpGet("letterboxd/links")]
    public IActionResult LetterboxdLinks()
    {
        var links = letterboxd.Links().Select(link => new
        {
            user = Guid.TryParse(link.UserId, out var id) ? userManager.GetUserById(id)?.Username : null,
            username = link.Username,
            logFinished = link.LogFinished,
            linkedAt = link.LinkedAt,
            lastLoggedAt = link.LastLoggedAt,
            lastError = link.LastError,
            pending = letterboxd.Count(link.UserId, WatchState.Pending),
            failed = letterboxd.Count(link.UserId, WatchState.Failed),
        });
        return Ok(new { links });
    }

    /// <summary>Starts the Build Hera TV collections task now, unless it is already running.</summary>
    [HttpPost("collections/build")]
    public IActionResult BuildCollections()
    {
        if (collectionBuilder.Status.Running)
        {
            return Ok(new { ok = true, message = "A build is already running." });
        }

        taskManager.QueueIfNotRunning<BuildCollectionsTask>();
        return Ok(new { ok = true, message = "Building collections. This takes a minute or two for a larger library." });
    }

    /// <summary>Whether the collections build is running, and how the last one went.</summary>
    [HttpGet("collections/status")]
    public IActionResult CollectionsStatus() => Ok(DescribeBuild(collectionBuilder));

    /// <summary>Gets whether the collections build is running and how the last one went; the settings page shows it too.</summary>
    internal static object DescribeBuild(ICollectionBuilder builder)
    {
        var status = builder.Status;
        return new
        {
            running = status.Running,
            last = status.Last is { } last
                ? new { at = last.At, created = last.Created, updated = last.Updated, removed = last.Removed, unchanged = last.Unchanged, failed = last.Failed, seconds = last.Seconds, note = last.Note }
                : null,
        };
    }
}
