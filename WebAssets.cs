using System.Buffers;
using System.Collections.Frozen;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>
/// The stylesheets, scripts and font, read once from the assembly and fingerprinted. The page loads
/// them as two bundles (every stylesheet, every script) rather than as 27 files, so a cold load is
/// two requests, each precompressed; the files stay available one by one.
/// </summary>
public static class WebAssets
{
    /// <summary>The URL name of every stylesheet, in cascade order, joined.</summary>
    public const string StylesheetBundle = "hera-bundle.css";

    /// <summary>The URL name of every script, in run order, joined.</summary>
    public const string ScriptBundle = "hera-bundle.js";

    private const string StylesheetType = "text/css; charset=utf-8";
    private const string ScriptType = "text/javascript; charset=utf-8";
    private const string FontName = "InterVariable.woff2";

    // Each script is one self-contained function, so in the bundle it runs as it did in its own file
    // except that a script that throws as it loads no longer stops the ones after it (it used to
    // stop only itself). The error is rethrown from a timer so the browser still reports it, with
    // its own stack, as uncaught.
    private const string ModuleStart = "try {\n";
    private const string ModuleEnd = "\n} catch (error) {\n  setTimeout(() => { throw error; });\n}\n";

    /// <summary>Stylesheets in cascade order: the core theme first, modules after it.</summary>
    private static readonly string[] Stylesheets = ["hera-tv.css", "hera-home.css", "hera-discover.css", "hera-player.css", "hera-settings.css", "hera-login.css", "hera-search.css", "hera-seerr.css", "hera-extras.css", "hera-activity.css", "hera-dashboard.css", "hera-stats.css", "hera-notify.css", "hera-collections.css"];

    /// <summary>Scripts in run order: modules register with the core, so it loads first.</summary>
    private static readonly string[] Scripts = ["hera-tv.js", "hera-home.js", "hera-discover.js", "hera-player.js", "hera-settings.js", "hera-login.js", "hera-search.js", "hera-seerr.js", "hera-extras.js", "hera-activity.js", "hera-stats.js", "hera-notify.js", "hera-collections.js"];

    private static readonly FrozenDictionary<string, byte[]> Embedded = Load();

    /// <summary>Gets the fingerprint of every asset together, used to bust caches.</summary>
    public static string Version { get; } = Fingerprint();

    // What is served: the embedded assets, with the stylesheet's font URL carrying the same ?v= the page
    // puts on every other asset, so the font is cached for a year like them rather than for a day; and
    // the two bundles, built from those.
    private static readonly FrozenDictionary<string, Asset> Assets = Build();

    public static Asset? Get(string name) => Assets.GetValueOrDefault(name);

    /// <summary>
    /// Compresses the bundles now. Brotli at its best setting takes about a second for them, which
    /// would otherwise land on whoever loads the first page after a restart.
    /// </summary>
    public static void Warm()
    {
        var styles = Assets[StylesheetBundle].Payload;
        var script = Assets[ScriptBundle].Payload;
        Parallel.Invoke(
            () => styles.Encoded("br"),
            () => styles.Encoded("gzip"),
            () => script.Encoded("br"),
            () => script.Encoded("gzip"));
    }

    /// <summary>
    /// The encoding to answer a request in: Brotli, else gzip, else null for as it is. The server's
    /// own compression would do this too, but at a quick setting and again on every request.
    /// </summary>
    public static string? ChooseEncoding(HttpRequest request)
    {
        if (!request.Headers.ContainsKey(HeaderNames.AcceptEncoding))
        {
            return null;
        }

        var accepted = request.GetTypedHeaders().AcceptEncoding;
        return Accepts(accepted, "br") ? "br" : Accepts(accepted, "gzip") ? "gzip" : null;
    }

    internal static byte[] Brotli(byte[] source)
    {
        var buffer = new byte[BrotliEncoder.GetMaxCompressedLength(source.Length)];
        if (!BrotliEncoder.TryCompress(source, buffer, out var written, 11, 22))
        {
            throw new InvalidOperationException("Brotli could not compress the response.");
        }

        return buffer.AsSpan(0, written).ToArray();
    }

    internal static byte[] Gzip(byte[] source)
    {
        using var output = new MemoryStream();
        using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
        {
            gzip.Write(source);
        }

        return output.ToArray();
    }

    // A named coding's own quality wins over the wildcard's; a quality of 0 refuses it.
    private static bool Accepts(IList<StringWithQualityHeaderValue> accepted, string coding)
    {
        var wildcard = false;
        foreach (var item in accepted)
        {
            if (item.Value.Equals(coding, StringComparison.OrdinalIgnoreCase))
            {
                return item.Quality != 0;
            }

            if (item.Value.Equals("*", StringComparison.Ordinal) && item.Quality != 0)
            {
                wildcard = true;
            }
        }

        return wildcard;
    }

    private static string Fingerprint()
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var name in Stylesheets.Concat(Scripts).Append(FontName))
        {
            hash.AppendData(Embedded[name]);
        }

        // The bundles are these files and the wrapping around them, so a change to either must
        // change the URL.
        hash.AppendData(Encoding.UTF8.GetBytes(ModuleStart + ModuleEnd));
        return Convert.ToHexStringLower(hash.GetHashAndReset())[..12];
    }

    private static FrozenDictionary<string, Asset> Build()
    {
        const string Font = $"url(\"{FontName}\")";
        var versioned = $"url(\"{FontName}?v={Version}\")";

        var styles = Stylesheets.ToDictionary(
            name => name,
            name => Encoding.UTF8.GetString(Embedded[name]).Replace(Font, versioned, StringComparison.Ordinal));
        var scripts = Scripts.ToDictionary(name => name, name => Encoding.UTF8.GetString(Embedded[name]));

        var assets = new Dictionary<string, Asset>
        {
            [FontName] = new(new Payload(Embedded[FontName]), "font/woff2", Compressible: false),
            [StylesheetBundle] = Bundle(Stylesheets, styles, StylesheetType, string.Empty, string.Empty),
            [ScriptBundle] = Bundle(Scripts, scripts, ScriptType, ModuleStart, ModuleEnd),
        };
        foreach (var (name, css) in styles)
        {
            assets[name] = new(new Payload(Encoding.UTF8.GetBytes(css)), StylesheetType, Compressible: true);
        }

        foreach (var (name, js) in scripts)
        {
            assets[name] = new(new Payload(Encoding.UTF8.GetBytes(js)), ScriptType, Compressible: true);
        }

        return assets.ToFrozenDictionary();
    }

    /// <summary>The files joined in order, each under a comment naming it so a line in the bundle can be traced back.</summary>
    private static Asset Bundle(string[] order, Dictionary<string, string> sources, string contentType, string start, string end)
    {
        var joined = new StringBuilder(sources.Values.Sum(s => s.Length) + order.Length * 64);
        foreach (var name in order)
        {
            joined.Append("/* ").Append(name).Append(" */\n").Append(start).Append(sources[name]);
            if (sources[name].Length > 0 && sources[name][^1] != '\n')
            {
                joined.Append('\n');
            }

            joined.Append(end);
        }

        return new Asset(new Payload(Encoding.UTF8.GetBytes(joined.ToString())), contentType, Compressible: true);
    }

    private static FrozenDictionary<string, byte[]> Load()
    {
        var assembly = typeof(WebAssets).Assembly;
        return Stylesheets.Concat(Scripts).Append(FontName).ToFrozenDictionary(
            name => name,
            name =>
            {
                using var stream = assembly.GetManifestResourceStream(name)
                    ?? throw new InvalidOperationException($"Embedded resource {name} is missing.");
                using var memory = new MemoryStream();
                stream.CopyTo(memory);
                return memory.ToArray();
            });
    }

    public sealed record Asset(Payload Payload, string ContentType, bool Compressible);

    /// <summary>A body with a content hash for its validator and its compressed forms, each made once on first use.</summary>
    public sealed class Payload
    {
        private readonly Lazy<byte[]> brotli;
        private readonly Lazy<byte[]> gzip;
        private readonly string tag;

        public Payload(byte[] content)
        {
            Content = content;
            tag = Convert.ToHexStringLower(SHA256.HashData(content))[..16];
            brotli = new Lazy<byte[]>(() => Brotli(content));
            gzip = new Lazy<byte[]>(() => Gzip(content));
        }

        public byte[] Content { get; }

        /// <summary>Gets the validator of one form of the body: each is different bytes, so each is its own.</summary>
        public string ETag(string? coding) => coding is null ? $"\"{tag}\"" : $"\"{tag}-{coding}\"";

        public byte[] Encoded(string? coding) => coding switch
        {
            null => Content,
            "br" => brotli.Value,
            "gzip" => gzip.Value,
            _ => throw new ArgumentOutOfRangeException(nameof(coding), coding, "Only br and gzip are produced."),
        };
    }
}
