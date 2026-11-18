using System.Collections.Concurrent;
using System.Text.RegularExpressions;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// A title's YouTube trailers that will play inside the web client. A video's owner can turn off
/// playback on other sites, and YouTube then draws its own "Video unavailable" page in the frame;
/// its oEmbed endpoint says so beforehand (401 or 403; 404 for a private or removed video). The
/// answer is kept per video for a day, so a page asks YouTube at most once.
/// </summary>
[ApiController]
[Authorize]
[Route("HeraTV")]
public partial class TrailersController(ILibraryManager libraryManager, IUserManager userManager) : ControllerBase
{
    private const int MaxChecked = 6;

    private static readonly TimeSpan Known = TimeSpan.FromDays(1);
    private static readonly TimeSpan Unsure = TimeSpan.FromMinutes(10);

    private static readonly HttpClient Http = new(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) })
    {
        Timeout = TimeSpan.FromSeconds(6),
    };

    private static readonly ConcurrentDictionary<string, (DateTime Expires, Task<bool?> Embeddable)> Checked = new();

    [GeneratedRegex(@"(?:v=|youtu\.be/|embed/)([\w-]{11})")]
    private static partial Regex YouTubeId();

    /// <summary>The YouTube ids of the title's trailers that may be embedded, in the library's order.</summary>
    [HttpGet("trailers/{itemId:guid}")]
    public async Task<IActionResult> GetTrailers([FromRoute] Guid itemId)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        var item = libraryManager.GetItemById(itemId);
        if (item is null || !item.IsVisible(user))
        {
            return NotFound();
        }

        var ids = item.RemoteTrailers
            .Select(trailer => YouTubeId().Match(trailer.Url ?? string.Empty))
            .Where(match => match.Success)
            .Select(match => match.Groups[1].Value)
            .Distinct(StringComparer.Ordinal)
            .Take(MaxChecked)
            .ToArray();
        var verdicts = await Task.WhenAll(ids.Select(Embeddable)).ConfigureAwait(false);
        // A video YouTube couldn't be asked about is offered: the player still steps past it if it fails.
        return Ok(new { youtube = ids.Where((_, index) => verdicts[index] != false).ToArray() });
    }

    private static Task<bool?> Embeddable(string id)
    {
        var now = DateTime.UtcNow;
        if (Checked.TryGetValue(id, out var held) && held.Expires > now)
        {
            return held.Embeddable;
        }

        var task = AskAsync(id);
        Checked[id] = (now + Known, task);
        _ = task.ContinueWith(
            done =>
            {
                if (done.Result is null)
                {
                    Checked[id] = (DateTime.UtcNow + Unsure, done);
                }
            },
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnRanToCompletion,
            TaskScheduler.Default);
        return task;
    }

    private static async Task<bool?> AskAsync(string id)
    {
        try
        {
            using var response = await Http.GetAsync(
                new Uri($"https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D{id}"),
                HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
            var status = (int)response.StatusCode;
            if (response.IsSuccessStatusCode)
            {
                return true;
            }

            return status is 401 or 403 or 404 or 400 ? false : null;
        }
        catch (HttpRequestException)
        {
            return null;
        }
        catch (TaskCanceledException)
        {
            return null;
        }
    }

    private User? CurrentUser()
    {
        var claim = User.FindFirst("Jellyfin-UserId")?.Value;
        return Guid.TryParse(claim, out var id) ? userManager.GetUserById(id) : null;
    }
}
