using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Collections;

/// <summary>
/// The collections the web client shows: the Collections page's groups and the home page's rows.
/// Any signed-in person may ask, and what they get back is only what they can see.
/// </summary>
[ApiController]
[Authorize]
[Route("HeraTV/collections")]
public class CollectionsController(ICollectionsView view, IUserManager userManager) : ControllerBase
{
    /// <summary>Gets the groups of collections this person can see, each with its collections and their visible counts.</summary>
    [HttpGet("groups")]
    public IActionResult GetGroups()
        => CurrentUser() is { } user ? Ok(view.Groups(user)) : Unauthorized();

    /// <summary>Gets today's home rows for this person.</summary>
    [HttpGet("rows")]
    public IActionResult GetRows()
        => CurrentUser() is { } user ? Ok(view.Rows(user)) : Unauthorized();

    private User? CurrentUser()
    {
        var claim = User.FindFirst("Jellyfin-UserId")?.Value;
        return Guid.TryParse(claim, out var id) ? userManager.GetUserById(id) : null;
    }
}

/// <summary>
/// Builds Hera TV's collections (BoxSets) every morning, and whenever an administrator asks from
/// the dashboard or Scheduled Tasks. The work is in <see cref="ICollectionBuilder"/>.
/// </summary>
public sealed class BuildCollectionsTask(ICollectionBuilder builder) : IScheduledTask
{
    public string Name => "Build Hera TV collections";

    public string Key => "HeraTvBuildCollections";

    public string Description => "Creates and updates the collections Hera TV builds (genres, decades, awards, universes, streaming services, seasons and more), so every Jellyfin app shows them.";

    public string Category => "Hera TV";

    public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        => builder.RunAsync(progress, cancellationToken);

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        yield return new TaskTriggerInfo
        {
            Type = TaskTriggerInfoType.DailyTrigger,
            TimeOfDayTicks = TimeSpan.FromHours(4).Ticks,
        };
    }
}
