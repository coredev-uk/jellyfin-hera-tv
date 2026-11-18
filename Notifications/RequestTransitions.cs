using System.Globalization;
using Jellyfin.Plugin.HeraTv.Integrations;

namespace Jellyfin.Plugin.HeraTv.Notifications;

/// <summary>
/// Decides which changes in a request are worth a notice. Pure, so the rules can be checked
/// without Seerr.
/// </summary>
public static class RequestTransitions
{
    /// <summary>
    /// A request found for the first time is only news while it is fresh. Beyond this it is old
    /// history the store hasn't met yet (a title whose record couldn't be read on an earlier pass),
    /// and telling someone their year-old request is "ready to watch" would be wrong.
    /// </summary>
    public static readonly TimeSpan FreshFor = TimeSpan.FromDays(2);

    /// <summary>
    /// Gets where a request stands, in the order a request normally moves: pending, approved,
    /// downloading, available. Downloading means the download stack reports progress, which Seerr
    /// doesn't say; declined and failed are the ways out.
    /// </summary>
    /// <remarks>
    /// Seerr leaves an approved request approved until its own sync notices the title, which can be
    /// minutes behind. "Ready to watch" is only true once the user's library has the title, so an
    /// approved film that is in the library is available, and so is a series Sonarr holds every
    /// requested season of when the library has it. <paramref name="inLibrary"/> is asked only then.
    /// </remarks>
    public static string StateOf(string seerrStatus, ArrActivity.Activity? activity, string type, Func<bool> inLibrary) => seerrStatus switch
    {
        "available" => "available",
        "declined" => "declined",
        "failed" => "failed",
        "approved" => (type != "tv" || activity?.State == "available") && inLibrary()
            ? "available"
            : activity is { Percent: > 0 } ? "downloading" : "approved",
        _ => "pending",
    };

    /// <summary>Gets how far along a state is. Declined and failed rank lowest, so approving a declined request reads as progress.</summary>
    public static int Rank(string state) => state switch
    {
        "approved" => 1,
        "downloading" => 2,
        "available" => 3,
        _ => 0,
    };

    /// <summary>
    /// Gets whether moving from <paramref name="previous"/> (null when never seen) to
    /// <paramref name="state"/> deserves a notice.
    /// </summary>
    /// <remarks>
    /// Only the four things the person asked to hear about do: approved, downloading, available
    /// and declined. A request seen for the first time, or a title requested again (a later series,
    /// which moves its requested date), counts as new and is announced at whatever it has reached.
    /// Anything else must move forward, or be declined: a download that blips out of the queue
    /// before importing steps back to approved, and must not announce the way forward twice.
    /// </remarks>
    public static bool ShouldNotify(RequestState? previous, string state, string? requestedAt, DateTime nowUtc)
    {
        if (state is not ("approved" or "downloading" or "available" or "declined"))
        {
            return false;
        }

        if (previous is null || previous.RequestedAt != requestedAt)
        {
            return IsFresh(requestedAt, nowUtc);
        }

        return state != previous.State && (state == "declined" || Rank(state) > Rank(previous.State));
    }

    /// <summary>Parses the time Seerr wrote for a request, as UTC; null when it isn't a time.</summary>
    public static DateTime? ParseUtc(string? requestedAt)
        => DateTimeOffset.TryParse(requestedAt, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var when)
            ? when.UtcDateTime
            : null;

    private static bool IsFresh(string? requestedAt, DateTime nowUtc)
        => ParseUtc(requestedAt) is { } when && nowUtc - when <= FreshFor;
}
