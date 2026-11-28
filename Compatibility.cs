using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>What Hera TV has been checked against, and how to tell whether the running server is inside it.</summary>
public static class Compatibility
{
    /// <summary>
    /// The Jellyfin releases (major.minor) this build has been checked against in a real web client.
    /// Update it when a new Jellyfin release has been checked, and only then: the web client reads it
    /// through <c>/HeraTV/compat</c> and, on any other version, keeps running but reports itself as
    /// untested; CI reads this line too, so keep it a single array on a single line.
    /// </summary>
    public static readonly string[] Tested = ["12.4"];

    /// <summary>Gets the plugin's assembly version, as <c>1.5.0.0</c>.</summary>
    public static string PluginVersion { get; } = typeof(Compatibility).Assembly.GetName().Version?.ToString() ?? "0.0.0.0";

    /// <summary>Formats a server version as <c>12.4.0</c>; an unset build number reads as 0.</summary>
    public static string Describe(Version version) => $"{version.Major}.{version.Minor}.{Math.Max(version.Build, 0)}";

    /// <summary>Returns true when the server's major.minor is one of <see cref="Tested"/>.</summary>
    public static bool IsSupported(Version version)
        => Tested.Contains($"{version.Major}.{version.Minor}", StringComparer.Ordinal);
}

/// <summary>
/// What web clients have said about Hera TV's own health: the latest report for each module from
/// each browser (a reporter), and the newest few times a whole client stood down or ran on an
/// untested Jellyfin. A browser's healthy report replaces only that browser's own earlier problem,
/// so a desktop that never opened the player can't hide a TV whose player has broken. It lives in
/// memory only and starts empty after a restart; that's deliberate, a report is a hint to look at
/// the Dashboard, not a record to keep, and a Jellyfin update is usually followed by a restart anyway.
/// </summary>
public sealed class HealthStore
{
    /// <summary>The most distinct module names kept, so a signed-in user can't grow the store by inventing names.</summary>
    private const int MaxModules = 64;

    /// <summary>The most browsers kept; the one that reported longest ago makes room for a new one.</summary>
    private const int MaxReporters = 128;

    private const int MaxBootProblems = 20;

    private readonly Lock gate = new();
    private readonly Dictionary<(string Module, string Reporter), ModuleReport> modules = [];
    private readonly Dictionary<string, DateTimeOffset> reporters = new(StringComparer.Ordinal);
    private readonly List<BootReport> boot = []; // Newest first.

    /// <summary>Notes one browser's snapshot.</summary>
    /// <param name="reporter">The browser: Jellyfin's device id.</param>
    /// <param name="bootState">The client's boot state: starting, ok, untested or safe.</param>
    /// <param name="reason">Why the client went to safe mode, if it did.</param>
    /// <param name="jellyfin">The server's version, as the server sees it.</param>
    /// <param name="page">The page the client was on.</param>
    /// <param name="user">Who reported.</param>
    /// <param name="reported">Each module that ran or reported in the snapshot.</param>
    /// <param name="now">When it arrived.</param>
    public void Record(string reporter, string bootState, string? reason, string jellyfin, string? page, string user, IReadOnlyList<ModuleState> reported, DateTimeOffset now)
    {
        lock (gate)
        {
            if (!reporters.ContainsKey(reporter) && reporters.Count >= MaxReporters)
            {
                Forget(reporters.MinBy(r => r.Value).Key);
            }

            reporters[reporter] = now;

            foreach (var state in reported)
            {
                var key = (state.Name, reporter);
                var found = modules.TryGetValue(key, out var previous);
                if (!found && !modules.Keys.Any(k => k.Module == state.Name) && modules.Keys.Select(k => k.Module).Distinct().Count() >= MaxModules)
                {
                    continue;
                }

                // The count is how many reports have said the same thing in a row, so a module that
                // recovers and fails again starts from one instead of looking like a long-running fault.
                var count = found && previous!.Same(state) ? previous.Count + 1 : 1;
                modules[key] = new ModuleReport(state, reporter, user, count, now);
            }

            if (bootState is "untested" or "safe")
            {
                var index = boot.FindIndex(b => b.Reporter == reporter && b.Boot == bootState && b.Reason == reason && b.Jellyfin == jellyfin);
                var count = 1;
                if (index >= 0)
                {
                    count = boot[index].Count + 1;
                    boot.RemoveAt(index);
                }

                boot.Insert(0, new BootReport(bootState, reason, jellyfin, page, reporter, user, count, now));
                if (boot.Count > MaxBootProblems)
                {
                    boot.RemoveRange(MaxBootProblems, boot.Count - MaxBootProblems);
                }
            }
            else
            {
                // A healthy boot from this browser ends its own earlier boot problems, and only those.
                boot.RemoveAll(b => b.Reporter == reporter);
            }
        }
    }

    /// <summary>Gets what has been reported: each module as each browser last said it, boot problems newest first, and who has checked in.</summary>
    public (IReadOnlyList<ModuleReport> Modules, IReadOnlyList<BootReport> Boot, ReporterSummary Reporters) Snapshot()
    {
        lock (gate)
        {
            var summary = new ReporterSummary(reporters.Count, reporters.Count == 0 ? null : reporters.Values.Max());
            return (
                [.. modules.Values.OrderBy(m => m.State.Name, StringComparer.Ordinal).ThenBy(m => m.Reporter, StringComparer.Ordinal)],
                [.. boot],
                summary);
        }
    }

    private void Forget(string reporter)
    {
        reporters.Remove(reporter);
        foreach (var key in modules.Keys.Where(k => k.Reporter == reporter).ToList())
        {
            modules.Remove(key);
        }

        boot.RemoveAll(b => b.Reporter == reporter);
    }

    /// <summary>One module's state in a snapshot, already validated.</summary>
    /// <param name="Name">The module's name.</param>
    /// <param name="Status">idle, ok, partial, degraded or disabled.</param>
    /// <param name="Missing">The <c>jf</c> names of the pieces of Jellyfin it couldn't find.</param>
    /// <param name="Page">The page id it last stood aside on, if any.</param>
    /// <param name="Errors">How many times it has thrown.</param>
    /// <param name="LastError">The last thing it threw, with the file and line it came from.</param>
    public sealed record ModuleState(string Name, string Status, string[] Missing, string? Page, int Errors, string? LastError);

    /// <summary>The latest report about one module from one browser.</summary>
    /// <param name="State">What it said.</param>
    /// <param name="Reporter">The browser (Jellyfin's device id).</param>
    /// <param name="User">Who said it.</param>
    /// <param name="Count">How many reports in a row said the same.</param>
    /// <param name="LastSeen">When the latest arrived.</param>
    public sealed record ModuleReport(ModuleState State, string Reporter, string User, int Count, DateTimeOffset LastSeen)
    {
        /// <summary>Returns true when <paramref name="other"/> describes the same situation (the error count aside).</summary>
        public bool Same(ModuleState other)
            => State.Status == other.Status && State.Page == other.Page && State.Missing.SequenceEqual(other.Missing);
    }

    /// <summary>One time a whole client stood down, or ran on an untested Jellyfin.</summary>
    /// <param name="Boot">untested or safe.</param>
    /// <param name="Reason">Why, in the client's words.</param>
    /// <param name="Jellyfin">The server's version at the time.</param>
    /// <param name="Page">The page the client was on.</param>
    /// <param name="Reporter">The browser.</param>
    /// <param name="User">Who reported.</param>
    /// <param name="Count">How many times the same report has come.</param>
    /// <param name="LastSeen">When the latest arrived.</param>
    public sealed record BootReport(string Boot, string? Reason, string Jellyfin, string? Page, string Reporter, string User, int Count, DateTimeOffset LastSeen);

    /// <summary>How many browsers have checked in since the server started, and when the latest did.</summary>
    /// <param name="Count">The browsers.</param>
    /// <param name="LastSeen">When any of them last reported.</param>
    public sealed record ReporterSummary(int Count, DateTimeOffset? LastSeen);
}

/// <summary>
/// The web client's compatibility handshake and its health reports. <c>compat</c> is anonymous
/// (the login page asks it before anyone is signed in); reports need a signed-in user; reading them
/// is for administrators.
/// </summary>
[ApiController]
[Route("HeraTV")]
public class CompatibilityController(IServerApplicationHost applicationHost, IUserManager userManager, HealthStore store, ServerHealth serverHealth) : ControllerBase
{
    private const int MaxBodyBytes = 64 * 1024;
    private const int MaxModules = 64;
    private const int MaxMissing = 16;
    private const int MaxName = 48;
    private const int MaxReporter = 512; // read this far of the id, which is hashed: jellyfin-web's device ids are base64 of the user agent and a timestamp, well over 100 characters
    private const int MaxPage = 64;
    private const int MaxVersion = 32;
    private const int MaxReason = 300;
    private const int MaxLastError = 500;

    private static readonly string[] BootStates = ["starting", "ok", "untested", "safe"];
    private static readonly string[] ModuleStatuses = ["idle", "ok", "partial", "degraded", "disabled"];

    [HttpGet("compat")]
    [AllowAnonymous]
    public IActionResult GetCompat()
    {
        var version = applicationHost.ApplicationVersion;
        Response.Headers.CacheControl = "no-cache";
        return Ok(new
        {
            plugin = Compatibility.PluginVersion,
            jellyfin = Compatibility.Describe(version),
            tested = Compatibility.Tested,
            supported = Compatibility.IsSupported(version),
        });
    }

    [HttpPost("health")]
    [Authorize]
    [RequestSizeLimit(MaxBodyBytes)]
    public IActionResult PostHealth([FromBody] HealthBody body)
    {
        if (!BootStates.Contains(body.Boot, StringComparer.Ordinal))
        {
            return BadRequest(new { message = "boot must be starting, ok, untested or safe." });
        }

        if (Oversize(body.Jellyfin, MaxVersion) || Oversize(body.Page, MaxPage) || body.Tested is { Count: > 8 } || body.Tested?.Any(v => Oversize(v, 16)) == true)
        {
            return BadRequest(new { message = "A field is too long." });
        }

        var modules = body.Modules ?? [];
        if (modules.Count > MaxModules)
        {
            return BadRequest(new { message = $"At most {MaxModules} modules can be reported." });
        }

        var states = new List<HealthStore.ModuleState>(modules.Count);
        foreach (var module in modules)
        {
            if (module is null)
            {
                return BadRequest(new { message = "A module entry is not valid." });
            }

            var missing = module.Missing ?? [];
            if (!Identifier(module.Name, MaxName)
                || !ModuleStatuses.Contains(module.Status, StringComparer.Ordinal)
                || Oversize(module.Page, MaxPage)
                || missing.Count > MaxMissing
                || !missing.TrueForAll(m => Identifier(m, MaxName)))
            {
                return BadRequest(new { message = "A module entry is not valid." });
            }

            // Any well-formed name is kept (the store's own cap bounds how many), so a new module
            // reports without this list being edited with it.
            states.Add(new HealthStore.ModuleState(
                module.Name!,
                module.Status!,
                [.. missing],
                module.Page,
                Math.Clamp(module.Errors ?? 0, 0, 1_000_000),
                Clean(module.LastError, MaxLastError)));
        }

        var user = UserName();
        // The store keys on a hash of the id: a stock browser's id is long, and the Dashboard only needs it to tell browsers apart.
        var reporter = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(Clean(body.Reporter, MaxReporter) ?? $"user:{user}")))[..16];
        store.Record(reporter, body.Boot!, Clean(body.Reason, MaxReason), Compatibility.Describe(applicationHost.ApplicationVersion), body.Page, user, states, DateTimeOffset.UtcNow);
        return Ok(new { ok = true });
    }

    [HttpGet("health")]
    [Authorize(Policy = HeraUser.Elevated)]
    public IActionResult GetHealth()
    {
        var version = applicationHost.ApplicationVersion;
        var (modules, boot, reporters) = store.Snapshot();
        Response.Headers.CacheControl = "no-cache";
        return Ok(new
        {
            jellyfin = Compatibility.Describe(version),
            tested = Compatibility.Tested,
            supported = Compatibility.IsSupported(version),
            plugin = Compatibility.PluginVersion,
            modules = modules.Select(m => new
            {
                name = m.State.Name,
                status = m.State.Status,
                missing = m.State.Missing,
                page = m.State.Page,
                errors = m.State.Errors,
                lastError = m.State.LastError,
                reporter = m.Reporter,
                user = m.User,
                count = m.Count,
                lastSeen = Stamp(m.LastSeen),
            }),
            boot = boot.Select(b => new
            {
                boot = b.Boot,
                reason = b.Reason,
                jellyfin = b.Jellyfin,
                page = b.Page,
                reporter = b.Reporter,
                user = b.User,
                count = b.Count,
                lastSeen = Stamp(b.LastSeen),
            }),
            reporters = new
            {
                count = reporters.Count,
                lastSeen = reporters.LastSeen is { } seen ? Stamp(seen) : null,
            },
            server = serverHealth.Snapshot().Select(f => new
            {
                feature = f.Feature,
                status = f.Status,
                since = Stamp(f.Since),
                count = f.Count,
                message = f.Message,
            }),
            injection = new
            {
                lastInjected = serverHealth.Injection.LastInjected is { } injected ? Stamp(injected) : null,
                // Which build of the assets the latest page was given, and how many pages each has had since the
                // server started: "legacy" is the one lowered for Chromium before 85 (Tizen 5, webOS 4).
                lastVariant = serverHealth.Injection.LastVariant?.ToString().ToLowerInvariant(),
                pages = new { modern = serverHealth.Injection.Modern, legacy = serverHealth.Injection.Legacy },
                lastDecline = serverHealth.Injection.LastDecline is { } decline ? new { at = Stamp(decline.At), reason = decline.Reason } : null,
            },
            // Where each script starts in hera-bundle.js, so a frame in an error ("hera-bundle.js:4210:9")
            // can be read as a file and line; and any web file missing from WebAssets's manifest. The legacy
            // build has its own bundle, fingerprint and map; "problem" says why one that is embedded isn't served.
            bundle = new
            {
                version = WebAssets.Version,
                files = WebAssets.ScriptMap.Select(f => new { file = f.File, line = f.Line }),
                unlisted = WebAssets.Unlisted,
                legacy = new
                {
                    available = WebAssets.LegacyAvailable,
                    version = WebAssets.LegacyVersion,
                    files = WebAssets.LegacyScriptMap.Select(f => new { file = f.File, line = f.Line }),
                    problem = WebAssets.LegacyProblem,
                },
            },
        });
    }

    private static string Stamp(DateTimeOffset when) => when.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    private static bool Oversize(string? value, int max) => value is not null && value.Length > max;

    /// <summary>Returns true for a short, non-empty name with no control characters.</summary>
    private static bool Identifier(string? value, int max)
        => !string.IsNullOrWhiteSpace(value) && value.Length <= max && !value.Any(char.IsControl);

    /// <summary>Free text from a client: control characters dropped, cut to <paramref name="max"/>. Error messages can be long; refusing the report over one would hide the fault.</summary>
    private static string? Clean(string? value, int max)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        var text = new StringBuilder(Math.Min(value.Length, max + 1));
        foreach (var c in value)
        {
            text.Append(char.IsControl(c) ? ' ' : c);
        }

        var clean = text.ToString().Trim();
        return clean.Length <= max ? clean : string.Concat(clean.AsSpan(0, max - 1), "…");
    }

    private string UserName()
    {
        return this.Current(userManager)?.Username ?? "unknown";
    }

    public sealed class HealthBody
    {
        public string? Reporter { get; set; }

        public string? Boot { get; set; }

        public string? Reason { get; set; }

        public string? Jellyfin { get; set; }

        public List<string>? Tested { get; set; }

        public string? Page { get; set; }

        public List<ModuleBody>? Modules { get; set; }
    }

    public sealed class ModuleBody
    {
        public string? Name { get; set; }

        public string? Status { get; set; }

        public List<string>? Missing { get; set; }

        public string? Page { get; set; }

        public int? Errors { get; set; }

        public string? LastError { get; set; }
    }
}
