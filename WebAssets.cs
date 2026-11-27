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

    // The one list of what the page is made of, in run order for the scripts and cascade order for
    // the stylesheets (the dashboard sheet undoes rules of the core one, so it comes after it and the
    // modules' before it). A file that is not listed is embedded but never served, and shows in
    // /HeraTV/health as "unlisted". The module is the name the file's script registers with
    // (HeraTV.register({ name })): its stylesheet applies only while that module runs, and a null
    // module is the core, whose stylesheets apply while Hera is on at all. CI checks the names here
    // against the scripts', so a module and its styling can't drift apart.
    private static readonly Unit[] Manifest =
    [
        new("hera-tv.js", "hera-tv.css", null),
        new("hera-home.js", "hera-home.css", "home"),
        new("hera-discover.js", "hera-discover.css", "discover"),
        new("hera-player.js", "hera-player.css", "player"),
        new(null, "hera-pause.css", "pause"),
        new(null, "hera-postplay.css", "postplay"),
        new(null, "hera-trailer.css", "trailer"),
        new("hera-settings.js", "hera-settings.css", "settings"),
        new("hera-login.js", "hera-login.css", "login"),
        new("hera-search.js", "hera-search.css", "search"),
        new("hera-seerr.js", "hera-seerr.css", "seerr"),
        new("hera-extras.js", "hera-extras.css", "extras"),
        new(null, "hera-extras-detail.css", "extras-detail"),
        new("hera-activity.js", "hera-activity.css", "activity"),
        new(null, "hera-dashboard.css", null),
        new("hera-stats.js", "hera-stats.css", "stats"),
        new("hera-notify.js", "hera-notify.css", "notify"),
        new(null, "hera-notify-detail.css", "notify-detail"),
        new("hera-collections.js", "hera-collections.css", "collections-browse"),
    ];

    private static readonly string[] Scripts = [.. Manifest.Where(u => u.Script is not null).Select(u => u.Script!)];

    private static readonly string[] Stylesheets = [.. Manifest.Where(u => u.Style is not null).Select(u => u.Style!)];

    /// <summary>Gets the modules the stylesheets are gated on, in manifest order: what the page's head script switches on before first paint.</summary>
    public static IReadOnlyList<string> Modules { get; } = [.. Manifest.Where(u => u.Module is not null).Select(u => u.Module!).Distinct(StringComparer.Ordinal)];

    // A script that throws as it loads no longer stops the ones after it: each file runs in its own
    // try, and a failure is handed to the core (HeraTV.loadFailed), which shows the module as
    // degraded with the error. If the core itself didn't load there is nobody to tell, so the
    // stylesheets come off, as safe mode would do. The error is rethrown from a timer so the browser
    // still reports it, with its own stack, as uncaught. HeraBundle.files says where each file
    // starts in the bundle, for reading a stack frame back as a file and line.
    private const string ModuleStart = "try {\n";
    private const string PrologueHead = "window.HeraBundle = {\n  version: \"";
    private const string PrologueMiddle = "\",\n  files: ";
    private const string PrologueTail = ",\n  failed(file, error) {\n    if (window.HeraTV?.loadFailed) {\n      window.HeraTV.loadFailed(file, error);\n    } else {\n      document.querySelectorAll(\"link[data-hera-tv]\").forEach((node) => node.remove());\n      document.documentElement.classList.remove(\"hera-on\");\n    }\n    setTimeout(() => {\n      throw error;\n    });\n  },\n};\n";

    private static string ModuleEnd(string file) => $"}} catch (error) {{\n  window.HeraBundle.failed(\"{file}\", error);\n}}\n";

    private static readonly FrozenDictionary<string, byte[]> Embedded = Load();

    // Each stylesheet behind the class that switches it on (see CssGate), before the font URL is touched.
    private static readonly Dictionary<string, string> GatedStyles = GateStyles();

    /// <summary>Gets the fingerprint of every asset together, used to bust caches.</summary>
    public static string Version { get; } = Fingerprint();

    // Set by Build, which must therefore come after this declaration.
    private static List<ScriptStart> scriptStarts = [];

    // What is served: the embedded assets, with the stylesheet's font URL carrying the same ?v= the page
    // puts on every other asset, so the font is cached for a year like them rather than for a day; and
    // the two bundles, built from those.
    private static readonly FrozenDictionary<string, Asset> Assets = Build();

    /// <summary>Gets where each script starts in <c>hera-bundle.js</c> (1-based line of its first line).</summary>
    public static IReadOnlyList<ScriptStart> ScriptMap => scriptStarts;

    /// <summary>Gets the embedded web files (<c>hera-*.js</c>, <c>hera-*.css</c>) the manifest above doesn't list, which would otherwise be silently left out.</summary>
    public static IReadOnlyList<string> Unlisted { get; } = FindUnlisted();

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

    private static Dictionary<string, string> GateStyles()
    {
        var gated = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var unit in Manifest.Where(u => u.Style is not null))
        {
            var gate = unit.Module is null ? "hera-on" : $"hera-m-{unit.Module}";
            gated[unit.Style!] = CssGate.Apply(Encoding.UTF8.GetString(Embedded[unit.Style!]), gate);
        }

        return gated;
    }

    private static string Fingerprint()
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var name in Stylesheets)
        {
            hash.AppendData(Encoding.UTF8.GetBytes(GatedStyles[name]));
        }

        foreach (var name in Scripts)
        {
            hash.AppendData(Embedded[name]);
        }

        hash.AppendData(Embedded[FontName]);

        // The script bundle is these files and the wrapping around them, so a change to either must
        // change the URL.
        hash.AppendData(Encoding.UTF8.GetBytes(ModuleStart + PrologueHead + PrologueMiddle + PrologueTail + ModuleEnd("*")));
        return Convert.ToHexStringLower(hash.GetHashAndReset())[..12];
    }

    private static FrozenDictionary<string, Asset> Build()
    {
        const string Font = $"url(\"{FontName}\")";
        var versioned = $"url(\"{FontName}?v={Version}\")";

        var styles = Stylesheets.ToDictionary(
            name => name,
            name => GatedStyles[name].Replace(Font, versioned, StringComparison.Ordinal));
        var scripts = Scripts.ToDictionary(name => name, name => Encoding.UTF8.GetString(Embedded[name]));

        var assets = new Dictionary<string, Asset>
        {
            [FontName] = new(new Payload(Embedded[FontName]), "font/woff2", Compressible: false),
            [StylesheetBundle] = StyleBundle(styles),
            [ScriptBundle] = ScriptBundleOf(scripts),
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

    /// <summary>The stylesheets joined in cascade order, each under a comment naming it so a line in the bundle can be traced back.</summary>
    private static Asset StyleBundle(Dictionary<string, string> sources)
    {
        var joined = new StringBuilder(sources.Values.Sum(s => s.Length) + sources.Count * 64);
        foreach (var name in Stylesheets)
        {
            joined.Append("/* ").Append(name).Append(" */\n").Append(sources[name]);
            if (sources[name].Length > 0 && sources[name][^1] != '\n')
            {
                joined.Append('\n');
            }
        }

        return new Asset(new Payload(Encoding.UTF8.GetBytes(joined.ToString())), StylesheetType, Compressible: true);
    }

    /// <summary>
    /// The scripts joined in run order, each in its own try under a comment naming it, behind the
    /// <c>HeraBundle</c> prologue. The prologue carries the line each file's own first line lands on
    /// (also <see cref="ScriptMap"/>), for reading a stack frame back as a file and line.
    /// </summary>
    private static Asset ScriptBundleOf(Dictionary<string, string> sources)
    {
        // The prologue's size in lines doesn't depend on the map it carries (one line of JSON), so
        // the lines can be counted before it is written.
        var line = CountLines(Prologue("[]")) + 1;
        var map = new List<ScriptStart>(Scripts.Length);
        scriptStarts = map;
        var bodies = new List<string>(Scripts.Length);
        foreach (var name in Scripts)
        {
            var text = sources[name];
            if (text.Length > 0 && text[^1] != '\n')
            {
                text += "\n";
            }

            line += 2; // The naming comment and "try {".
            map.Add(new ScriptStart(name, line));
            line += CountLines(text) + CountLines(ModuleEnd(name));
            bodies.Add(text);
        }

        var joined = new StringBuilder(bodies.Sum(b => b.Length) + Scripts.Length * 160 + 1024);
        joined.Append(Prologue("[" + string.Join(",", map.Select(f => $"[\"{f.File}\",{f.Line}]")) + "]"));
        for (var i = 0; i < Scripts.Length; i++)
        {
            joined.Append("/* ").Append(Scripts[i]).Append(" */\n").Append(ModuleStart).Append(bodies[i]).Append(ModuleEnd(Scripts[i]));
        }

        return new Asset(new Payload(Encoding.UTF8.GetBytes(joined.ToString())), ScriptType, Compressible: true);
    }

    private static string Prologue(string filesJson) => PrologueHead + Version + PrologueMiddle + filesJson + PrologueTail;

    private static int CountLines(string text)
    {
        var count = 0;
        foreach (var c in text)
        {
            if (c == '\n')
            {
                count++;
            }
        }

        return count;
    }

    private static FrozenDictionary<string, byte[]> Load()
    {
        var assembly = typeof(WebAssets).Assembly;
        return Manifest.SelectMany(u => new[] { u.Script, u.Style }).OfType<string>().Append(FontName).ToFrozenDictionary(
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

    private static string[] FindUnlisted()
        => [.. typeof(WebAssets).Assembly.GetManifestResourceNames()
            .Where(name => name.StartsWith("hera-", StringComparison.Ordinal)
                && (name.EndsWith(".js", StringComparison.Ordinal) || name.EndsWith(".css", StringComparison.Ordinal))
                && !Embedded.ContainsKey(name))
            .Order(StringComparer.Ordinal)];

    /// <summary>The parts of the web client, in order: a script, its stylesheet, and the module that stylesheet follows.</summary>
    private sealed record Unit(string? Script, string? Style, string? Module);

    /// <summary>Where one script's own first line sits in the script bundle.</summary>
    /// <param name="File">The script's file name.</param>
    /// <param name="Line">Its first line's number in <c>hera-bundle.js</c>, counting from 1.</param>
    public sealed record ScriptStart(string File, int Line);

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

        /// <summary>
        /// Gets the validator of one form of the body: each is different bytes, so each is its own.
        /// Weak, because a compressing proxy (Envoy's compressor among them) drops a strong ETag from
        /// the responses it compresses, which would leave browsers nothing to revalidate with; a weak
        /// one passes through, and If-None-Match compares weakly anyway.
        /// </summary>
        public string ETag(string? coding) => coding is null ? $"W/\"{tag}\"" : $"W/\"{tag}-{coding}\"";

        public byte[] Encoded(string? coding) => coding switch
        {
            null => Content,
            "br" => brotli.Value,
            "gzip" => gzip.Value,
            _ => throw new ArgumentOutOfRangeException(nameof(coding), coding, "Only br and gzip are produced."),
        };
    }
}
