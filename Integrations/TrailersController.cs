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
    // Ids come from the library's own trailer links, so this is bounded by the library; the cap only stops a runaway.
    private const int MaxKept = 2000;

    private const int MaxChecked = 6;

    private static readonly TimeSpan Known = TimeSpan.FromDays(1);
    private static readonly TimeSpan Unsure = TimeSpan.FromMinutes(10);

    private static readonly HttpClient Http = new(new SocketsHttpHandler { PooledConnectionLifetime = TimeSpan.FromMinutes(5) })
    {
        Timeout = TimeSpan.FromSeconds(6),
    };

    private static readonly ConcurrentDictionary<string, Verdict> Checked = new();

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

        // However many pages ask while the first answer is out, only the entry that wins the slot asks YouTube.
        var created = new Verdict(id, now + Known);
        var entry = Checked.AddOrUpdate(id, created, (_, old) => old.Expires > now ? old : created);
        if (ReferenceEquals(entry, created))
        {
            CachePruning.Prune(Checked, MaxKept, e => e.Expires, id);
        }

        return entry.Embeddable;
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

    /// <summary>One video's answer: asked for by whoever reads it first, shared by everyone after, and kept for less time when YouTube gave none.</summary>
    private sealed class Verdict
    {
        private readonly Lazy<Task<bool?>> _ask;
        private long _expires;

        public Verdict(string id, DateTime expires)
        {
            _expires = expires.Ticks;
            _ask = new Lazy<Task<bool?>>(() => AskAndStampAsync(id));
        }

        public Task<bool?> Embeddable => _ask.Value;

        public DateTime Expires => new(Volatile.Read(ref _expires), DateTimeKind.Utc);

        private async Task<bool?> AskAndStampAsync(string id)
        {
            bool? answer = null;
            try
            {
                answer = await AskAsync(id).ConfigureAwait(false);
                return answer;
            }
            finally
            {
                // No answer, or a failure, is worth asking again soon, not tomorrow.
                if (answer is null)
                {
                    Volatile.Write(ref _expires, (DateTime.UtcNow + Unsure).Ticks);
                }
            }
        }
    }
}
