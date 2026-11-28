using System.Buffers;
using System.Collections.Frozen;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>Which build of the web assets a page gets: the one for current browsers, or the one lowered for Chromium before 85.</summary>
public enum Variant
{
    Modern,
    Legacy,
}

/// <summary>
/// The stylesheets, scripts and font, read once from the assembly and fingerprinted. The page loads
/// them as two bundles (every stylesheet, every script) rather than as 27 files, so a cold load is
/// two requests, each precompressed; the files stay available one by one.
/// </summary>
/// <remarks>
/// A build that had Node also carries the same files rewritten for older TV browsers (tools/legacy,
/// embedded from web-legacy/), served as two bundles of their own, <c>hera-bundle-legacy.js</c> and
/// <c>hera-bundle-legacy.css</c>, under a version of their own. The current bundles and their version
/// are not touched by them.
/// </remarks>
public static class WebAssets
{
    /// <summary>The URL name of every stylesheet, in cascade order, joined.</summary>
    public const string StylesheetBundle = "hera-bundle.css";

    /// <summary>The URL name of every script, in run order, joined.</summary>
    public const string ScriptBundle = "hera-bundle.js";

    /// <summary>The URL name of the stylesheets for older browsers.</summary>
    public const string LegacyStylesheetBundle = "hera-bundle-legacy.css";

    /// <summary>The URL name of the scripts for older browsers, behind the polyfills they need.</summary>
    public const string LegacyScriptBundle = "hera-bundle-legacy.js";

    private const string StylesheetType = "text/css; charset=utf-8";
    private const string ScriptType = "text/javascript; charset=utf-8";
    private const string FontName = "InterVariable.woff2";

    // Where the legacy build's files are embedded, and the script that goes in front of the others.
    private const string LegacyFolder = "legacy/";
    private const string LegacyPrelude = "legacy/hera-polyfills.js";

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

    // The same wrapper written in ES5 for the legacy bundle: Chromium 53 reads neither `?.` nor method
    // shorthand. `variant` says which bundle a page was given.
    private const string LegacyPrologueHead = "window.HeraBundle = {\n  variant: \"legacy\",\n  version: \"";
    private const string LegacyPrologueTail = ",\n  failed: function (file, error) {\n    if (window.HeraTV && window.HeraTV.loadFailed) {\n      window.HeraTV.loadFailed(file, error);\n    } else {\n      Array.prototype.forEach.call(document.querySelectorAll(\"link[data-hera-tv]\"), function (node) {\n        node.parentNode.removeChild(node);\n      });\n      document.documentElement.classList.remove(\"hera-on\");\n    }\n    setTimeout(function () {\n      throw error;\n    });\n  }\n};\n";

    private static readonly FrozenDictionary<string, byte[]> Embedded = Load();

    // Each stylesheet behind the class that switches it on (see CssGate), before the font URL is touched.
    private static readonly Dictionary<string, string> GatedStyles = GateStyles(Embedded);

    /// <summary>Gets the fingerprint of every asset together, used to bust caches.</summary>
    public static string Version { get; } = Fingerprint();

    // Set by Build, which must therefore come after this declaration.
    private static List<ScriptStart> scriptStarts = [];
    private static List<ScriptStart> legacyScriptStarts = [];
    private static string? legacyProblem;

    // The scripts of the legacy bundle: the polyfills, then the same ones in the same order.
    private static readonly string[] LegacyScripts = [LegacyPrelude[LegacyFolder.Length..], .. Scripts];

    // The legacy files, or null where this build has none (it was built without Node) or they don't
    // match the manifest; LegacyProblem says which.
    private static readonly LegacySet? LegacySources = LoadLegacy();

    // What is served: the embedded assets, with the stylesheet's font URL carrying the same ?v= the page
    // puts on every other asset, so the font is cached for a year like them rather than for a day; and
    // the two bundles, built from those.
    private static readonly FrozenDictionary<string, Asset> Assets = Build();

    /// <summary>Gets where each script starts in <c>hera-bundle.js</c> (1-based line of its first line).</summary>
    public static IReadOnlyList<ScriptStart> ScriptMap => scriptStarts;

    /// <summary>Gets a value indicating whether this build carries the assets for older browsers.</summary>
    public static bool LegacyAvailable => LegacySources is not null;

    /// <summary>Gets why the assets for older browsers aren't served, when files for them are embedded but don't fit the manifest; null when there are none or they do.</summary>
    public static string? LegacyProblem => legacyProblem;

    /// <summary>Gets the fingerprint of the legacy assets, or null where there are none.</summary>
    public static string? LegacyVersion => LegacySources?.Version;

    /// <summary>Gets where each script starts in <c>hera-bundle-legacy.js</c>, the polyfills first.</summary>
    public static IReadOnlyList<ScriptStart> LegacyScriptMap => legacyScriptStarts;

    /// <summary>The variant to send a browser with this User-Agent: the legacy one when it is that old and this build has it.</summary>
    public static Variant Choose(string? userAgent) => LegacyAvailable && LegacyBrowsers.IsLegacy(userAgent) ? Variant.Legacy : Variant.Modern;

    public static string VersionOf(Variant variant) => variant == Variant.Legacy ? LegacyVersion ?? Version : Version;

    public static string StylesheetOf(Variant variant) => variant == Variant.Legacy ? LegacyStylesheetBundle : StylesheetBundle;

    public static string ScriptOf(Variant variant) => variant == Variant.Legacy ? LegacyScriptBundle : ScriptBundle;

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

    private static Dictionary<string, string> GateStyles(IReadOnlyDictionary<string, byte[]> source)
    {
        var gated = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var unit in Manifest.Where(u => u.Style is not null))
        {
            var gate = unit.Module is null ? "hera-on" : $"hera-m-{unit.Module}";
            gated[unit.Style!] = CssGate.Apply(Encoding.UTF8.GetString(source[unit.Style!]), gate);
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

    /// <summary>The legacy bundles' own fingerprint: its stylesheets, scripts (the polyfills among them), the font and the wrapping.</summary>
    private static string LegacyFingerprint(Dictionary<string, string> gated, IReadOnlyDictionary<string, byte[]> files)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var name in Stylesheets)
        {
            hash.AppendData(Encoding.UTF8.GetBytes(gated[name]));
        }

        foreach (var name in LegacyScripts)
        {
            hash.AppendData(files[name]);
        }

        hash.AppendData(Embedded[FontName]);
        hash.AppendData(Encoding.UTF8.GetBytes(ModuleStart + LegacyPrologueHead + PrologueMiddle + LegacyPrologueTail + ModuleEnd("*")));
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
        scriptStarts = [];

        var assets = new Dictionary<string, Asset>
        {
            [FontName] = new(new Payload(Embedded[FontName]), "font/woff2", Compressible: false),
            [StylesheetBundle] = StyleBundle(styles),
            [ScriptBundle] = BuildScriptBundle(Scripts, scripts, Prologue, scriptStarts),
        };
        foreach (var (name, css) in styles)
        {
            assets[name] = new(new Payload(Encoding.UTF8.GetBytes(css)), StylesheetType, Compressible: true);
        }

        foreach (var (name, js) in scripts)
        {
            assets[name] = new(new Payload(Encoding.UTF8.GetBytes(js)), ScriptType, Compressible: true);
        }

        // The legacy build is the same files lowered for older browsers: served only as its two bundles,
        // each with the font URL of its own version.
        if (LegacySources is { } legacy)
        {
            var legacyFont = $"url(\"{FontName}?v={legacy.Version}\")";
            var legacyStyles = Stylesheets.ToDictionary(
                name => name,
                name => legacy.GatedStyles[name].Replace(Font, legacyFont, StringComparison.Ordinal));
            var legacyScripts = LegacyScripts.ToDictionary(name => name, name => Encoding.UTF8.GetString(legacy.Files[name]));
            legacyScriptStarts = [];
            assets[LegacyStylesheetBundle] = StyleBundle(legacyStyles);
            assets[LegacyScriptBundle] = BuildScriptBundle(LegacyScripts, legacyScripts, files => LegacyPrologue(legacy.Version, files), legacyScriptStarts);
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
    private static Asset BuildScriptBundle(IReadOnlyList<string> names, Dictionary<string, string> sources, Func<string, string> prologue, List<ScriptStart> map)
    {
        // The prologue's size in lines doesn't depend on the map it carries (one line of JSON), so
        // the lines can be counted before it is written.
        var line = CountLines(prologue("[]")) + 1;
        var bodies = new List<string>(names.Count);
        foreach (var name in names)
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

        var joined = new StringBuilder(bodies.Sum(b => b.Length) + names.Count * 160 + 1024);
        joined.Append(prologue("[" + string.Join(",", map.Select(f => $"[\"{f.File}\",{f.Line}]")) + "]"));
        for (var i = 0; i < names.Count; i++)
        {
            joined.Append("/* ").Append(names[i]).Append(" */\n").Append(ModuleStart).Append(bodies[i]).Append(ModuleEnd(names[i]));
        }

        return new Asset(new Payload(Encoding.UTF8.GetBytes(joined.ToString())), ScriptType, Compressible: true);
    }

    private static string Prologue(string filesJson) => PrologueHead + Version + PrologueMiddle + filesJson + PrologueTail;

    private static string LegacyPrologue(string version, string filesJson) => LegacyPrologueHead + version + PrologueMiddle + filesJson + LegacyPrologueTail;

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

    /// <summary>
    /// Reads the files of the legacy build. Null when there are none (a build without Node: older browsers
    /// then get the current assets, and the page's own check leaves them with Jellyfin's page), or when they
    /// don't match the manifest, which <see cref="LegacyProblem"/> then says.
    /// </summary>
    private static LegacySet? LoadLegacy()
    {
        var assembly = typeof(WebAssets).Assembly;
        if (assembly.GetManifestResourceInfo(LegacyPrelude) is null)
        {
            return null;
        }

        var names = Scripts.Concat(Stylesheets).Append(LegacyPrelude[LegacyFolder.Length..]).ToArray();
        var missing = names.Where(name => assembly.GetManifestResourceInfo(LegacyFolder + name) is null).ToArray();
        if (missing.Length > 0)
        {
            legacyProblem = $"the legacy assets lack {string.Join(", ", missing)}, which the manifest lists";
            return null;
        }

        var files = names.ToFrozenDictionary(
            name => name,
            name =>
            {
                using var stream = assembly.GetManifestResourceStream(LegacyFolder + name)!;
                using var memory = new MemoryStream();
                stream.CopyTo(memory);
                return memory.ToArray();
            });
        var gated = GateStyles(files);
        return new LegacySet(files, gated, LegacyFingerprint(gated, files));
    }

    /// <summary>The legacy build's files by name (the prelude among them), its stylesheets behind their gate classes, and its fingerprint.</summary>
    private sealed record LegacySet(FrozenDictionary<string, byte[]> Files, Dictionary<string, string> GatedStyles, string Version);

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

        public Payload(byte[] content, string tagPrefix = "")
        {
            Content = content;
            tag = tagPrefix + Convert.ToHexStringLower(SHA256.HashData(content))[..16];
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
