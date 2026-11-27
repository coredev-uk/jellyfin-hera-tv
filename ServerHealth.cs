using MediaBrowser.Controller;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>One server-side feature that isn't working, as the dashboard shows it.</summary>
/// <param name="Feature">What it is, in words an administrator can read ("Stream sampling").</param>
/// <param name="Status"><c>degraded</c> (it failed and will try again) or <c>stopped</c> (it has given up until the server restarts).</param>
/// <param name="Since">When it first failed in this run of the fault.</param>
/// <param name="Count">How many times it has failed since.</param>
/// <param name="Message">The latest failure's message.</param>
public sealed record ServerFault(string Feature, string Status, DateTimeOffset Since, int Count, string Message);

/// <summary>When the web client's page was last rewritten, and the latest time it wasn't, with why.</summary>
public sealed record InjectionState(DateTimeOffset? LastInjected, InjectionDecline? LastDecline);

/// <summary>One time the page went out as Jellyfin made it.</summary>
public sealed record InjectionDecline(DateTimeOffset At, string Reason);

/// <summary>
/// What has gone wrong on the server side, kept for the dashboard and logged once. Every feature
/// that fails soft reports here instead of keeping its own "warned already" flag: the first failure
/// of a fault is a warning, repeats are debug, and a clean run clears it, so a feature that breaks
/// again later is heard about again. It lives in memory only and starts empty after a restart.
/// </summary>
public sealed class ServerHealth(ILogger<ServerHealth> logger)
{
    private readonly Lock gate = new();
    private readonly Dictionary<string, Entry> faults = new(StringComparer.Ordinal);
    private DateTimeOffset? lastInjected;
    private InjectionDecline? lastDecline;

    /// <summary>
    /// Notes that a feature failed and will try again. The first failure logs a warning; later ones, until
    /// <see cref="Recovered"/>, log at debug level.
    /// </summary>
    /// <param name="feature">A stable name for the feature, shown on the dashboard.</param>
    /// <param name="what">What it was doing, as a verb phrase ("sample the playing streams").</param>
    /// <param name="ex">The failure, if there is one.</param>
    public void Fault(string feature, string what, Exception? ex = null)
    {
        var message = ex?.Message ?? what;
        bool first;
        lock (gate)
        {
            first = !faults.TryGetValue(feature, out var entry);
            faults[feature] = first
                ? new Entry("degraded", DateTimeOffset.UtcNow, 1, message)
                : entry! with { Count = entry!.Count + 1, Message = message };
        }

        if (first)
        {
            logger.LogWarning(ex, "Hera TV couldn't {What}; it will try again. Further failures are logged at debug level", what);
        }
        else
        {
            logger.LogDebug(ex, "Hera TV couldn't {What}", what);
        }
    }

    /// <summary>Notes that a feature ran clean, which ends its fault: the next failure is a warning again.</summary>
    public void Recovered(string feature)
    {
        lock (gate)
        {
            faults.Remove(feature);
        }
    }

    /// <summary>Notes that a feature has stopped for good until the server restarts. Everything else carries on.</summary>
    public void Stopped(string feature, Exception ex)
    {
        lock (gate)
        {
            faults[feature] = new Entry("stopped", DateTimeOffset.UtcNow, 1, ex.Message);
        }

        logger.LogError(ex, "Hera TV's {Feature} has stopped and stays off until the server restarts. The rest of Hera TV and Jellyfin carry on", feature);
    }

    /// <summary>Gets what isn't working, oldest first.</summary>
    public IReadOnlyList<ServerFault> Snapshot()
    {
        lock (gate)
        {
            return [.. faults.Select(f => new ServerFault(f.Key, f.Value.Status, f.Value.Since, f.Value.Count, f.Value.Message)).OrderBy(f => f.Since)];
        }
    }

    /// <summary>Gets when the page was last rewritten, and the latest time it wasn't.</summary>
    public InjectionState Injection
    {
        get
        {
            lock (gate)
            {
                return new InjectionState(lastInjected, lastDecline);
            }
        }
    }

    /// <summary>Notes that a page went out with Hera TV in it.</summary>
    public void Injected()
    {
        lock (gate)
        {
            lastInjected = DateTimeOffset.UtcNow;
        }

        Recovered(InjectionFeature);
    }

    /// <summary>Notes that the page went out as Jellyfin made it, and why.</summary>
    public void Declined(string reason, Exception? ex = null)
    {
        lock (gate)
        {
            lastDecline = new InjectionDecline(DateTimeOffset.UtcNow, reason);
        }

        Fault(InjectionFeature, $"add itself to Jellyfin's web page ({reason}); serving Jellyfin's page unmodified", ex);
    }

    /// <summary>Logs which Hera TV is running on which Jellyfin, once, and warns when that Jellyfin is one it hasn't been checked on.</summary>
    public void LogStartup(IServerApplicationHost host)
    {
        var server = host.ApplicationVersion;
        // The version Hera was compiled against, from its own reference, not the server's loaded assembly.
        var builtAgainst = typeof(ServerHealth).Assembly.GetReferencedAssemblies()
            .FirstOrDefault(a => a.Name == "MediaBrowser.Controller")?.Version;
        var tested = string.Join(", ", Compatibility.Tested);
        logger.LogInformation(
            "Hera TV {Version} on Jellyfin {Server} (built against {Built}; tested with {Tested})",
            Compatibility.PluginVersion,
            Compatibility.Describe(server),
            builtAgainst is null ? "an unknown version" : Compatibility.Describe(builtAgainst),
            tested);
        if (!Compatibility.IsSupported(server))
        {
            logger.LogWarning(
                "Jellyfin {Server} is not a version Hera TV {Version} has been tested with ({Tested}). It keeps running and any part that no longer fits switches itself off, but pages may look or behave differently until a release for this version is out",
                Compatibility.Describe(server),
                Compatibility.PluginVersion,
                tested);
        }
    }

    private const string InjectionFeature = "Web page injection";

    private sealed record Entry(string Status, DateTimeOffset Since, int Count, string Message);
}
