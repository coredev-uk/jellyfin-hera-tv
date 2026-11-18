using System.Text;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Dto;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Session;

namespace Jellyfin.Plugin.HeraTv.Stats;

/// <summary>What a stream is made of at the source.</summary>
internal sealed record SourceInfo(string? Container, string? VideoCodec, string? AudioCodec, int? Width, int? Height, long? Bitrate, string? Hdr);

/// <summary>What the server is sending when it is converting the stream.</summary>
internal sealed record TranscodeInfo(string? VideoCodec, string? AudioCodec, int? Width, int? Height, long? Bitrate, bool Hardware, IReadOnlyList<string> Reasons);

/// <summary>
/// One session's stream as the Statistics page and the recorder both read it, so the two can't
/// disagree about what counts as a transcode.
/// </summary>
internal sealed record StreamInfo(string PlayMethod, SourceInfo Source, TranscodeInfo? Transcode)
{
    public const string MethodDirectPlay = "DirectPlay";
    public const string MethodDirectStream = "DirectStream";
    public const string MethodTranscode = "Transcode";

    /// <summary>Gets a value indicating whether the video itself is being re-encoded.</summary>
    public bool IsTranscode => PlayMethod == MethodTranscode;

    /// <summary>Gets what the stream costs the network, in bits per second.</summary>
    public long? Bandwidth => Transcode?.Bitrate ?? Source.Bitrate;

    /// <summary>
    /// Reads a session that is playing something, or returns null when it isn't.
    /// </summary>
    public static StreamInfo? From(SessionInfo session)
    {
        var item = session.NowPlayingItem;
        if (item is null)
        {
            return null;
        }

        var transcoding = session.TranscodingInfo;
        var source = ReadSource(session, item);

        // Jellyfin reports "Transcode" whenever anything is converted. With the video copied and only
        // the audio re-encoded the server is doing a remux, which is what Tautulli (and a person
        // reading the page) calls Direct Stream. Playback Reporting's history is mapped the same way.
        var method = session.PlayState?.PlayMethod switch
        {
            MediaBrowser.Model.Session.PlayMethod.DirectPlay => MethodDirectPlay,
            MediaBrowser.Model.Session.PlayMethod.DirectStream => MethodDirectStream,
            MediaBrowser.Model.Session.PlayMethod.Transcode => transcoding is { IsVideoDirect: true } ? MethodDirectStream : MethodTranscode,
            _ => transcoding is null ? MethodDirectPlay : transcoding.IsVideoDirect ? MethodDirectStream : MethodTranscode,
        };

        TranscodeInfo? transcode = null;
        if (transcoding is not null)
        {
            transcode = new TranscodeInfo(
                transcoding.VideoCodec,
                transcoding.AudioCodec,
                transcoding.Width,
                transcoding.Height,
                transcoding.Bitrate,
                transcoding.HardwareAccelerationType is { } hw && !string.Equals(hw.ToString(), "none", StringComparison.OrdinalIgnoreCase),
                [.. Enum.GetValues<TranscodeReason>().Where(r => (int)r != 0 && transcoding.TranscodeReasons.HasFlag(r)).Select(r => r.ToString())]);
        }

        return new StreamInfo(method, source, transcode);
    }

    /// <summary>Turns <c>VideoCodecNotSupported</c> into "Video codec not supported".</summary>
    public static string Humanise(string reason)
    {
        var text = new StringBuilder(reason.Length + 8);
        for (var i = 0; i < reason.Length; i++)
        {
            if (i > 0 && char.IsUpper(reason[i]) && !char.IsUpper(reason[i - 1]))
            {
                text.Append(' ');
            }

            text.Append(i == 0 ? reason[i] : char.ToLowerInvariant(reason[i]));
        }

        return text.ToString();
    }

    private static SourceInfo ReadSource(SessionInfo session, BaseItemDto item)
    {
        // The session's item carries the streams of the media source being played; fall back to the
        // matching source, then the first, in case a server build leaves them on the sources instead.
        var sources = item.MediaSources;
        var chosen = sources?.FirstOrDefault(s => string.Equals(s.Id, session.PlayState?.MediaSourceId, StringComparison.Ordinal))
            ?? sources?.FirstOrDefault();
        IEnumerable<MediaStream> streams = item.MediaStreams is { Length: > 0 } own ? own : chosen?.MediaStreams ?? Enumerable.Empty<MediaStream>();

        var video = streams.FirstOrDefault(s => s.Type == MediaStreamType.Video);
        var audioIndex = session.PlayState?.AudioStreamIndex;
        var audio = streams.FirstOrDefault(s => s.Type == MediaStreamType.Audio && s.Index == audioIndex)
            ?? streams.FirstOrDefault(s => s.Type == MediaStreamType.Audio && s.IsDefault)
            ?? streams.FirstOrDefault(s => s.Type == MediaStreamType.Audio);

        long? bitrate = chosen?.Bitrate;
        if (bitrate is null or <= 0)
        {
            var sum = (long)(video?.BitRate ?? 0) + (audio?.BitRate ?? 0);
            bitrate = sum > 0 ? sum : null;
        }

        return new SourceInfo(
            item.Container ?? chosen?.Container,
            video?.Codec,
            audio?.Codec,
            video?.Width,
            video?.Height,
            bitrate,
            HdrLabel(video?.VideoRangeType.ToString()));
    }

    private static string? HdrLabel(string? range) => range switch
    {
        null or "" or "Unknown" or "SDR" => null,
        _ when range.StartsWith("DOVI", StringComparison.Ordinal) => "Dolby Vision",
        "HDR10Plus" => "HDR10+",
        "HDR10" => "HDR10",
        "HLG" => "HLG",
        _ => "HDR",
    };
}
