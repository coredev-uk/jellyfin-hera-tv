using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

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

    /// <summary>Gets the next unwatched film after this one in its franchise, or 204 when there is none.</summary>
    [HttpGet("next/{itemId}")]
    public IActionResult GetNext([FromRoute] Guid itemId)
        => CurrentUser() is not { } user ? Unauthorized() : view.NextInCollection(user, itemId) is { } next ? Ok(next) : NoContent();

    private User? CurrentUser() => this.Current(userManager);
}

/// <summary>
/// Builds Hera TV's collections (BoxSets) every morning, and whenever an administrator asks from
/// the dashboard or Scheduled Tasks. The work is in <see cref="ICollectionBuilder"/>.
/// </summary>
/// <remarks>
/// Jellyfin builds tasks itself and marks the whole plugin as failed if one can't be built, so this takes only
/// the service provider and asks for the builder when it runs: a builder that can't be made is a failed run.
/// </remarks>
public sealed class BuildCollectionsTask(IServiceProvider services) : IScheduledTask
{
    public string Name => "Build Hera TV collections";

    public string Key => "HeraTvBuildCollections";

    public string Description => "Creates and updates the collections Hera TV builds (genres, decades, awards, universes, streaming services, seasons and more), so every Jellyfin app shows them.";

    public string Category => "Hera TV";

    public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        => services.GetRequiredService<ICollectionBuilder>().RunAsync(progress, cancellationToken);

    public IEnumerable<TaskTriggerInfo> GetDefaultTriggers()
    {
        yield return new TaskTriggerInfo
        {
            Type = TaskTriggerInfoType.DailyTrigger,
            TimeOfDayTicks = TimeSpan.FromHours(4).Ticks,
        };
    }
}
