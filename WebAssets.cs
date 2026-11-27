using System.Collections.Frozen;
using System.Security.Cryptography;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>The stylesheets, scripts and font, read once from the assembly and fingerprinted.</summary>
public static class WebAssets
{
    /// <summary>Stylesheets in cascade order: the core theme first, modules after it.</summary>
    public static readonly string[] Stylesheets = ["hera-tv.css", "hera-home.css", "hera-discover.css", "hera-player.css", "hera-settings.css", "hera-login.css", "hera-search.css", "hera-seerr.css", "hera-extras.css", "hera-activity.css", "hera-dashboard.css", "hera-stats.css", "hera-notify.css", "hera-collections.css"];

    /// <summary>Scripts in run order: modules register with the core, so it loads first.</summary>
    public static readonly string[] Scripts = ["hera-tv.js", "hera-home.js", "hera-discover.js", "hera-player.js", "hera-settings.js", "hera-login.js", "hera-search.js", "hera-seerr.js", "hera-extras.js", "hera-activity.js", "hera-stats.js", "hera-notify.js", "hera-collections.js"];

    private static readonly FrozenDictionary<string, Asset> Embedded = Load();

    /// <summary>Gets the fingerprint of every asset together, used to bust caches.</summary>
    public static string Version { get; } = Convert.ToHexStringLower(
        SHA256.HashData(Embedded.Values.SelectMany(a => a.Content).ToArray()))[..12];

    // What is served: the embedded assets, with the stylesheet's font URL carrying the same ?v= the page
    // puts on every other asset, so the font is cached for a year like them rather than for a day.
    private static readonly FrozenDictionary<string, Asset> Assets = Fingerprinted();

    public static Asset? Get(string name) => Assets.GetValueOrDefault(name);

    private static FrozenDictionary<string, Asset> Fingerprinted()
    {
        const string Font = "url(\"InterVariable.woff2\")";
        var versioned = $"url(\"InterVariable.woff2?v={Version}\")";
        return Embedded.ToFrozenDictionary(
            a => a.Key,
            a =>
            {
                if (!a.Value.ContentType.StartsWith("text/css", StringComparison.Ordinal))
                {
                    return a.Value;
                }

                var css = System.Text.Encoding.UTF8.GetString(a.Value.Content);
                return css.Contains(Font, StringComparison.Ordinal)
                    ? a.Value with { Content = System.Text.Encoding.UTF8.GetBytes(css.Replace(Font, versioned, StringComparison.Ordinal)) }
                    : a.Value;
            });
    }

    private static FrozenDictionary<string, Asset> Load()
    {
        var assembly = typeof(WebAssets).Assembly;
        var types = Stylesheets.Select(name => (name, "text/css; charset=utf-8"))
            .Concat(Scripts.Select(name => (name, "text/javascript; charset=utf-8")))
            .Append(("InterVariable.woff2", "font/woff2"));

        return types.ToFrozenDictionary(
            t => t.Item1,
            t =>
            {
                using var stream = assembly.GetManifestResourceStream(t.Item1)
                    ?? throw new InvalidOperationException($"Embedded resource {t.Item1} is missing.");
                using var memory = new MemoryStream();
                stream.CopyTo(memory);
                return new Asset(memory.ToArray(), t.Item2);
            });
    }

    public sealed record Asset(byte[] Content, string ContentType);
}
