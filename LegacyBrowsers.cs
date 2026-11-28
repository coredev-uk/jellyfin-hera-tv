using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>
/// Which browsers are given the assets rewritten for older engines (tools/legacy) rather than the
/// current ones: the Chromium before 85 that Samsung's Tizen 5 browser and LG's webOS 4 web app run,
/// and Safari before 14. Anything unrecognised gets the current assets.
/// </summary>
/// <remarks>
/// tests/legacy/browsers.test.mjs reads the patterns and floors below out of this file and runs real
/// User-Agent strings through them, so a change here that sends a current browser to the old
/// assets, or the reverse, fails CI.
/// </remarks>
internal static partial class LegacyBrowsers
{
    /// <summary>The first Chromium the current assets are written for: the one that reads <c>??=</c>, which the page's own check tries.</summary>
    internal const int ChromeFloor = 85;

    /// <summary>The first Safari the current assets are written for.</summary>
    internal const int SafariFloor = 14;

    // A browser's Chromium: the Chrome/<n> token that nearly all of them carry (Edge, Samsung Internet,
    // Electron, Android's WebView and QtWebEngine as well), or, on Samsung's newer TVs, which name the
    // engine by its bare version ("85.0.4183.93/6.0 TV Safari").
    [GeneratedRegex(@"\b(?:Chrome|Chromium)/(\d+)")]
    private static partial Regex ChromeToken();

    [GeneratedRegex(@"\b(\d+)(?:\.\d+){3}(?:\.\d+)?/\d+\.\d+ TV Safari/")]
    private static partial Regex SamsungEngineToken();

    // A television's browser, which says so in the string.
    [GeneratedRegex(@"\b(?:Tizen|Web0S|SMART-TV|NetCast)\b", RegexOptions.IgnoreCase)]
    private static partial Regex TvPlatform();

    // Safari's own version (Chrome on Android's WebView carries a Version/4.0 too, which is why this
    // counts only where there is no Chromium token).
    [GeneratedRegex(@"\bVersion/(\d+)\b.*\bSafari/")]
    private static partial Regex SafariVersion();

    /// <summary>Gets a value indicating whether a browser with this User-Agent needs the assets for older engines.</summary>
    public static bool IsLegacy(string? userAgent)
    {
        if (string.IsNullOrEmpty(userAgent))
        {
            return false;
        }

        // The Chromium wins where there is one: a TV on Chromium 94 says Tizen and is not old.
        var engine = ChromeToken().Match(userAgent);
        if (!engine.Success)
        {
            engine = SamsungEngineToken().Match(userAgent);
        }

        if (engine.Success)
        {
            return int.TryParse(engine.Groups[1].ValueSpan, out var major) && major < ChromeFloor;
        }

        if (TvPlatform().IsMatch(userAgent))
        {
            return true;
        }

        var safari = SafariVersion().Match(userAgent);
        return safari.Success && int.TryParse(safari.Groups[1].ValueSpan, out var version) && version < SafariFloor;
    }
}
