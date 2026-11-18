namespace Jellyfin.Plugin.HeraTv.Collections;

/// <summary>
/// When a seasonal set exists. <paramref name="Span"/> gives the window that begins in a given
/// year; one that crosses New Year ends in the next year, so a date is tested against this year's
/// window and last year's.
/// </summary>
internal sealed record Window(Func<int, (DateOnly Start, DateOnly End)> Span)
{
    public bool Contains(DateOnly day)
    {
        for (var year = day.Year - 1; year <= day.Year; year++)
        {
            var (start, end) = Span(year);
            if (day >= start && day <= end)
            {
                return true;
            }
        }

        return false;
    }

    /// <summary>A window on the same calendar dates every year (month/day to month/day, inclusive; the end may be in the next year).</summary>
    public static Window Fixed(int fromMonth, int fromDay, int toMonth, int toDay) => new(year =>
    {
        var start = new DateOnly(year, fromMonth, fromDay);
        var end = new DateOnly(toMonth < fromMonth ? year + 1 : year, toMonth, Math.Min(toDay, DateTime.DaysInMonth(toMonth < fromMonth ? year + 1 : year, toMonth)));
        return (start, end);
    });

    /// <summary>A window that moves with the church calendar: <paramref name="before"/> days before the feast, <paramref name="after"/> days after it.</summary>
    public static Window Around(Func<int, DateOnly> feast, int before, int after) => new(year =>
    {
        var day = feast(year);
        return (day.AddDays(-before), day.AddDays(after));
    });
}

/// <summary>The moving dates the UK calendar hangs on.</summary>
internal static class Calendar
{
    /// <summary>Easter Sunday in the Gregorian calendar (the Meeus/Jones/Butcher computus).</summary>
    public static DateOnly Easter(int year)
    {
        var a = year % 19;
        var b = year / 100;
        var c = year % 100;
        var d = b / 4;
        var e = b % 4;
        var f = (b + 8) / 25;
        var g = (b - f + 1) / 3;
        var h = ((19 * a) + b - d - g + 15) % 30;
        var i = c / 4;
        var k = c % 4;
        var l = (32 + (2 * e) + (2 * i) - h - k) % 7;
        var m = (a + (11 * h) + (22 * l)) / 451;
        var month = (h + l - (7 * m) + 114) / 31;
        var day = ((h + l - (7 * m) + 114) % 31) + 1;
        return new DateOnly(year, month, day);
    }

    /// <summary>Mothering Sunday is the fourth Sunday of Lent: the Sunday three weeks before Easter.</summary>
    public static DateOnly MotheringSunday(int year) => Easter(year).AddDays(-21);

    /// <summary>Father's Day in the UK is the third Sunday of June.</summary>
    public static DateOnly FathersDay(int year)
    {
        var first = new DateOnly(year, 6, 1);
        return first.AddDays(((int)DayOfWeek.Sunday - (int)first.DayOfWeek + 7) % 7 + 14);
    }
}
