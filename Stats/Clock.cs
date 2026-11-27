using System.Globalization;

namespace Jellyfin.Plugin.HeraTv.Stats;

/// <summary>
/// The server's own day. Statistics are bucketed in <see cref="TimeZoneInfo.Local"/> (the cluster sets
/// <c>TZ</c>), so a household sees its evenings on the day they happened. Times are carried as local
/// wall-clock values; the hour that repeats when clocks go back, and the one that is skipped when
/// they go forward, are approximated rather than modelled.
/// </summary>
internal static class Clock
{
    /// <summary>Gets the server's current local date.</summary>
    public static DateTime Today => DateTime.Now.Date;

    /// <summary>Converts a UTC instant to local wall-clock time.</summary>
    public static DateTime FromUtc(DateTime utc) => TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utc, DateTimeKind.Utc), TimeZoneInfo.Local);

    /// <summary>
    /// Gets the first UTC instant that falls on the local date <paramref name="day"/>. Samples are stored as
    /// UTC instants, so a local day is a range of them; this is where it starts, found against the same
    /// conversion <see cref="FromUtc"/> uses so a sample is on the day it would have been bucketed on.
    /// </summary>
    public static DateTime StartOfDay(DateTime day)
    {
        var date = day.Date;
        var origin = DateTime.SpecifyKind(date, DateTimeKind.Utc);

        // Nearly every day starts at its local midnight's UTC instant; the search is for the days that don't.
        var guess = ToUtc(date);
        if (!BeforeDay(guess, date) && BeforeDay(guess.AddSeconds(-1), date))
        {
            return guess;
        }

        // No offset is further than 14 hours, so a day starts within 15 hours of its UTC midnight.
        long before = -15 * 3600;
        long onOrAfter = 15 * 3600;
        while (onOrAfter - before > 1)
        {
            var middle = before + ((onOrAfter - before) / 2);
            if (BeforeDay(origin.AddSeconds(middle), date))
            {
                before = middle;
            }
            else
            {
                onOrAfter = middle;
            }
        }

        return origin.AddSeconds(onOrAfter);
    }

    private static bool BeforeDay(DateTime utc, DateTime date) => FromUtc(utc).Date < date;

    /// <summary>Converts local wall-clock time to a UTC instant. Never throws, even for a time the clocks skipped.</summary>
    public static DateTime ToUtc(DateTime local)
        => DateTime.SpecifyKind(DateTime.SpecifyKind(local, DateTimeKind.Unspecified) - TimeZoneInfo.Local.GetUtcOffset(DateTime.SpecifyKind(local, DateTimeKind.Unspecified)), DateTimeKind.Utc);

    /// <summary>Formats a local date as <c>yyyy-MM-dd</c>.</summary>
    public static string DateString(DateTime local) => local.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    /// <summary>Formats a UTC instant as <c>yyyy-MM-ddTHH:mm:ssZ</c>.</summary>
    public static string UtcString(DateTime utc) => utc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);
}
