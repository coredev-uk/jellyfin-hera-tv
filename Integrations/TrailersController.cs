using System.Globalization;
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
public partial class TrailersController(ILibraryManager libraryManager, IUserManager userManager, ServerHealth health) : ControllerBase
{
    // Ids come from the library's own trailer links, so this is bounded by the library; the cap only stops a runaway.
    private const int MaxKept = 2000;

    private const int MaxChecked = 6;

    private static readonly TimeSpan Known = TimeSpan.FromDays(1);
    private static readonly TimeSpan Unsure = TimeSpan.FromMinutes(10);

    private static readonly HttpClient Http = new(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) })
    {
        Timeout = TimeSpan.FromSeconds(6),
    };

    private const string Feature = "YouTube trailers";

    // YouTube answers "not embeddable" with a refusal per video, which is also what a refusal of the server looks
    // like. This many refusals running, with no video allowed in between, is more than a run of unlucky videos.
    private const int SuspiciousRefusals = 5;

    private static readonly AsyncTtlCache<string, bool?> Checked = new(MaxKept, Unsure);
    private static int refusals;

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
        var verdicts = await Task.WhenAll(ids.Select(id => Checked.GetAsync(id, Known, () => AskAsync(id)))).ConfigureAwait(false);
        // A video YouTube couldn't be asked about is offered: the player still steps past it if it fails.
        return Ok(new { youtube = ids.Where((_, index) => verdicts[index] != false).ToArray() });
    }

    /// <summary>Asks YouTube whether a video may be embedded: true or false, or null when it gave no answer (which is kept for less time).</summary>
    private async Task<bool?> AskAsync(string id)
    {
        try
        {
            using var response = await Http.GetAsync(
                new Uri($"https://www.youtube.com/oembed?format=json&url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D{id}"),
                HttpCompletionOption.ResponseHeadersRead).ConfigureAwait(false);
            var status = (int)response.StatusCode;
            if (response.IsSuccessStatusCode)
            {
                Interlocked.Exchange(ref refusals, 0);
                health.Recovered(Feature);
                return true;
            }

            if (status is 401 or 403 or 404 or 400)
            {
                if (Interlocked.Increment(ref refusals) == SuspiciousRefusals)
                {
                    health.Fault(Feature, string.Create(CultureInfo.InvariantCulture, $"check trailers with YouTube: its oEmbed endpoint has refused the last {SuspiciousRefusals} videos in a row (HTTP {status}), so it may be refusing this server, and trailers are being hidden"));
                }

                return false;
            }

            health.Fault(Feature, string.Create(CultureInfo.InvariantCulture, $"check a trailer with YouTube (its oEmbed endpoint answered HTTP {status})"));
            return null;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            health.Fault(Feature, "reach YouTube to check a trailer", ex);
            return null;
        }
    }

    private User? CurrentUser() => this.Current(userManager);
}
