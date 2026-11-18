using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Session;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Stats;

/// <summary>
/// The numbers behind the Statistics pages: what is playing now and the history (admins), and the
/// signed-in person's own history (everyone, and only theirs).
/// </summary>
[ApiController]
[Authorize]
[Route("HeraTV/stats")]
public class StatsController(ISessionManager sessions, IStatsReports reports) : ControllerBase
{
    private static readonly int[] HistoryDays = [7, 30, 90, 365];
    private static readonly int[] MeDays = [30, 365, 0];

    /// <summary>Gets every stream in progress, and what they add up to.</summary>
    [HttpGet("now")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult GetNow()
    {
        var playing = new List<object>();
        long bandwidth = 0;
        var transcodes = 0;

        foreach (var session in sessions.Sessions.OrderBy(s => s.UserName, StringComparer.OrdinalIgnoreCase).ThenBy(s => s.DeviceName, StringComparer.OrdinalIgnoreCase))
        {
            if (session.NowPlayingItem is not { } item || StreamInfo.From(session) is not { } stream)
            {
                continue;
            }

            bandwidth += stream.Bandwidth ?? 0;
            transcodes += stream.IsTranscode ? 1 : 0;

            var episode = item.Type == BaseItemKind.Episode
                ? (item.ParentIndexNumber, item.IndexNumber) switch
                {
                    (int season, int number) => $"S{season}, E{number}",
                    (null, int number) => $"E{number}",
                    _ => null,
                }
                : null;

            playing.Add(new
            {
                id = session.Id,
                user = new { id = session.UserId.ToString("N"), name = session.UserName },
                client = session.Client,
                device = session.DeviceName,
                item = new
                {
                    id = item.Id.ToString("N"),
                    name = item.Name,
                    type = item.Type.ToString(),
                    seriesName = item.SeriesName,
                    episode,
                    year = item.ProductionYear,
                    // An episode has no art worth showing of its own; the series carries it.
                    imageId = (item.Type == BaseItemKind.Episode && item.SeriesId is { } series && series != Guid.Empty ? series : item.Id).ToString("N"),
                    runtimeTicks = item.RunTimeTicks,
                },
                positionTicks = session.PlayState?.PositionTicks ?? 0,
                paused = session.PlayState?.IsPaused ?? false,
                playMethod = stream.PlayMethod,
                source = new
                {
                    container = stream.Source.Container,
                    videoCodec = stream.Source.VideoCodec,
                    audioCodec = stream.Source.AudioCodec,
                    width = stream.Source.Width,
                    height = stream.Source.Height,
                    bitrate = stream.Source.Bitrate,
                    hdr = stream.Source.Hdr,
                },
                transcode = stream.Transcode is null
                    ? null
                    : new
                    {
                        videoCodec = stream.Transcode.VideoCodec,
                        audioCodec = stream.Transcode.AudioCodec,
                        width = stream.Transcode.Width,
                        height = stream.Transcode.Height,
                        bitrate = stream.Transcode.Bitrate,
                        hardware = stream.Transcode.Hardware,
                        reasons = stream.Transcode.Reasons.Select(StreamInfo.Humanise).ToArray(),
                    },
                bandwidth = stream.Bandwidth ?? 0,
            });
        }

        Response.Headers.CacheControl = "no-cache";
        return Ok(new
        {
            sessions = playing,
            totals = new { streams = playing.Count, transcodes, direct = playing.Count - transcodes, bandwidth },
        });
    }

    /// <summary>Gets the history of everyone's watching over the last 7, 30, 90 or 365 days.</summary>
    [HttpGet("history")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult GetHistory([FromQuery] int days = 30)
    {
        if (!HistoryDays.Contains(days))
        {
            return BadRequest("days must be 7, 30, 90 or 365.");
        }

        Response.Headers.CacheControl = "no-cache";
        return Ok(reports.History(days));
    }

    /// <summary>Gets the signed-in user's own history over the last 30 or 365 days, or all of it (0).</summary>
    [HttpGet("me")]
    public IActionResult GetMe([FromQuery] int days = 365)
    {
        if (!MeDays.Contains(days))
        {
            return BadRequest("days must be 30, 365 or 0.");
        }

        // Only ever the caller's own: there is no way to ask for anyone else's.
        if (!Guid.TryParse(User.FindFirst("Jellyfin-UserId")?.Value, out var user))
        {
            return Unauthorized();
        }

        Response.Headers.CacheControl = "no-cache";
        return Ok(reports.Me(user, days));
    }
}
