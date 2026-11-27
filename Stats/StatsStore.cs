using System.Globalization;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.HeraTv.Stats;

/// <summary>One stream, seen at one tick of the recorder.</summary>
internal sealed record Sample(
    string UserId,
    string ItemId,
    string PlayMethod,
    int? SourceWidth,
    int? SourceHeight,
    long? SourceBitrate,
    int? OutputWidth,
    int? OutputHeight,
    long? OutputBitrate,
    bool Hardware,
    string Reasons);

/// <summary>What the recorder has seen over a range, before it is shaped for the page.</summary>
internal sealed record Recorded(
    DateTime Since,
    IReadOnlyDictionary<string, int> Peaks,
    IReadOnlyDictionary<string, (long Direct, long Transcode)> Transcodes,
    long[] Resolution,
    long[] Bitrate);

/// <summary>
/// Hera's own record of how streams were delivered: one row per playing stream per minute, in
/// <c>stats.db</c> in the plugin's data folder. Jellyfin keeps none of this once a stream ends, and
/// Playback Reporting never kept it, so it exists from the day the recorder first ran.
/// </summary>
/// <remarks>
/// Like the Playback Reporting source, it fails soft: a database that can't be opened is logged once
/// and reads as "no samples".
/// </remarks>
internal sealed class StatsStore : SqliteStore
{
    /// <summary>How often the recorder samples, and so how many seconds each sample stands for.</summary>
    public const int SampleSeconds = 60;

    /// <summary>How long samples are kept.</summary>
    public const int KeepDays = 400;

    public static readonly string[] ResolutionLabels = ["4K", "1080p", "720p", "SD"];

    public static readonly string[] BitrateLabels = ["Under 5 Mbps", "5\u201310 Mbps", "10\u201320 Mbps", "20\u201340 Mbps", "Over 40 Mbps"];

    /// <summary>The smallest picture height of each resolution bucket but the last. <see cref="DayQuery"/> is built from these too, so the two can't disagree.</summary>
    private static readonly int[] ResolutionFloors = [1600, 900, 600];

    /// <summary>The bit rate each bitrate bucket but the last stays under.</summary>
    private static readonly long[] BitrateCeilings = [5_000_000, 10_000_000, 20_000_000, 40_000_000];

    /// <summary>
    /// How long after a local day ends before its totals are kept for good: a tick that began just
    /// before midnight may be written just after it.
    /// </summary>
    private static readonly TimeSpan SettleAfter = TimeSpan.FromMinutes(10);

    private const string Schema = """
        CREATE TABLE IF NOT EXISTS samples (
            time TEXT NOT NULL,
            userId TEXT NOT NULL,
            itemId TEXT NOT NULL,
            playMethod TEXT NOT NULL,
            srcWidth INTEGER,
            srcHeight INTEGER,
            srcBitrate INTEGER,
            outWidth INTEGER,
            outHeight INTEGER,
            outBitrate INTEGER,
            hw INTEGER NOT NULL,
            reasons TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS samples_time ON samples (time);
        """;

    /// <summary>The one-day-per-row query behind <see cref="Read"/>; see <see cref="BuildDayQuery"/>.</summary>
    private static readonly string DayQuery = BuildDayQuery();

    // Version 1 is the schema as it stood before versions were kept.
    private static readonly Migration[] Migrations = [new(1, Schema)];

    public StatsStore(ServerHealth health)
        : base(health, "Stream statistics", "use its stats database, so streams aren't being recorded", "stats.db", Migrations)
    {
    }

    /// <summary>Totals of local days that have ended and settled, by date. Only touched under <see cref="SqliteStore.Gate"/>.</summary>
    private readonly Dictionary<string, DayTotals> settled = new(StringComparer.Ordinal);

    /// <summary>The oldest sample time seen when <see cref="settled"/> was last used.</summary>
    private string? firstSeen;

    /// <summary>Formats a sample time. One value per tick, so rows that share it were concurrent.</summary>
    public static string Stamp(DateTime utc) => utc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    /// <summary>Gets the resolution bucket (an index into <see cref="ResolutionLabels"/>) for a picture height.</summary>
    public static int ResolutionBucket(int height)
    {
        for (var i = 0; i < ResolutionFloors.Length; i++)
        {
            if (height >= ResolutionFloors[i])
            {
                return i;
            }
        }

        return ResolutionFloors.Length;
    }

    /// <summary>Gets the bitrate bucket (an index into <see cref="BitrateLabels"/>) for bits per second.</summary>
    public static int BitrateBucket(long bitsPerSecond)
    {
        for (var i = 0; i < BitrateCeilings.Length; i++)
        {
            if (bitsPerSecond < BitrateCeilings[i])
            {
                return i;
            }
        }

        return BitrateCeilings.Length;
    }

    /// <summary>Gets a string that changes whenever the database does, or empty when it isn't there. For callers that keep what they built from it.</summary>
    internal static string FileSignature(string file)
    {
        // The write-ahead log is where a commit lands first, so it is part of "has this changed".
        var main = new FileInfo(file);
        var log = new FileInfo(file + "-wal");
        return string.Create(CultureInfo.InvariantCulture, $"{(main.Exists ? main.LastWriteTimeUtc.Ticks : 0)}:{(main.Exists ? main.Length : 0)}:{(log.Exists ? log.LastWriteTimeUtc.Ticks : 0)}:{(log.Exists ? log.Length : 0)}");
    }

    /// <summary>Gets <see cref="FileSignature"/> of this store's database; empty before the plugin has loaded.</summary>
    internal string Signature() => FilePath is { } file ? FileSignature(file) : string.Empty;

    /// <summary>Adds one tick's samples; returns false when they couldn't be saved.</summary>
    public bool Add(DateTime utc, IReadOnlyList<Sample> samples)
    {
        if (samples.Count == 0)
        {
            return true;
        }

        return Writing(connection =>
        {
            using var transaction = connection.BeginTransaction();
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText =
                "INSERT INTO samples (time, userId, itemId, playMethod, srcWidth, srcHeight, srcBitrate, outWidth, outHeight, outBitrate, hw, reasons) " +
                "VALUES ($time, $user, $item, $method, $sw, $sh, $sb, $ow, $oh, $ob, $hw, $reasons)";
            var time = command.Parameters.Add("$time", SqliteType.Text);
            var user = command.Parameters.Add("$user", SqliteType.Text);
            var item = command.Parameters.Add("$item", SqliteType.Text);
            var method = command.Parameters.Add("$method", SqliteType.Text);
            var sw = command.Parameters.Add("$sw", SqliteType.Integer);
            var sh = command.Parameters.Add("$sh", SqliteType.Integer);
            var sb = command.Parameters.Add("$sb", SqliteType.Integer);
            var ow = command.Parameters.Add("$ow", SqliteType.Integer);
            var oh = command.Parameters.Add("$oh", SqliteType.Integer);
            var ob = command.Parameters.Add("$ob", SqliteType.Integer);
            var hw = command.Parameters.Add("$hw", SqliteType.Integer);
            var reasons = command.Parameters.Add("$reasons", SqliteType.Text);

            var stamp = Stamp(utc);
            foreach (var sample in samples)
            {
                time.Value = stamp;
                user.Value = sample.UserId;
                item.Value = sample.ItemId;
                method.Value = sample.PlayMethod;
                sw.Value = Db(sample.SourceWidth);
                sh.Value = Db(sample.SourceHeight);
                sb.Value = Db(sample.SourceBitrate);
                ow.Value = Db(sample.OutputWidth);
                oh.Value = Db(sample.OutputHeight);
                ob.Value = Db(sample.OutputBitrate);
                hw.Value = sample.Hardware ? 1 : 0;
                reasons.Value = sample.Reasons;
                command.ExecuteNonQuery();
            }

            transaction.Commit();
        });
    }

    /// <summary>Deletes samples older than <see cref="KeepDays"/>.</summary>
    public bool Prune(DateTime utc) => Writing(connection =>
    {
        using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM samples WHERE time < $cutoff";
        command.Parameters.AddWithValue("$cutoff", Stamp(utc.Date.AddDays(-KeepDays)));
        command.ExecuteNonQuery();
    });

    /// <summary>
    /// Reads what was recorded from the start of <paramref name="from"/> to the end of <paramref name="today"/>
    /// (local days), with each sample counted on its local day. Null when the recorder has never saved
    /// a sample, or the database can't be read.
    /// </summary>
    /// <remarks>
    /// The sums are made by SQLite, a local day being the range of stored UTC instants between its
    /// start and the next day's. A day that has ended is only ever added to for the few seconds a tick
    /// takes to write, so once it has settled its totals are kept, and a year's history costs the
    /// rows of today, not the ~130k of the year.
    /// </remarks>
    internal Recorded? Read(DateTime from, DateTime today)
    {
        Recorded? result = null;
        var ok = Reading(connection =>
        {
            DateTime since;
            string? first;
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT MIN(time) FROM samples";
                first = command.ExecuteScalar() as string;
                if (first is null || !DateTime.TryParse(first, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out since))
                {
                    settled.Clear();
                    return;
                }
            }

            // Older samples than any seen before mean the file was replaced; what was kept is of another database.
            if (firstSeen is not null && string.CompareOrdinal(first, firstSeen) < 0)
            {
                settled.Clear();
            }

            firstSeen = first;
            var oldest = Clock.DateString(today.AddDays(-KeepDays));
            foreach (var stale in settled.Keys.Where(key => string.CompareOrdinal(key, oldest) < 0).ToList())
            {
                settled.Remove(stale);
            }

            var days = new Dictionary<string, DayTotals>(StringComparer.Ordinal);
            var missing = new List<DateTime>();
            for (var day = from.Date; day <= today; day = day.AddDays(1))
            {
                var key = Clock.DateString(day);
                if (settled.TryGetValue(key, out var kept))
                {
                    days[key] = kept;
                }
                else
                {
                    missing.Add(day);
                }
            }

            if (missing.Count > 0)
            {
                var counted = Count(connection, missing);
                var now = DateTime.UtcNow;
                foreach (var day in missing)
                {
                    var key = Clock.DateString(day);
                    var totals = counted.GetValueOrDefault(key) ?? DayTotals.Empty;
                    days[key] = totals;
                    if (day < today && now >= Clock.StartOfDay(day.AddDays(1)) + SettleAfter)
                    {
                        settled[key] = totals;
                    }
                }
            }

            var peaks = new Dictionary<string, int>(StringComparer.Ordinal);
            var transcodes = new Dictionary<string, (long, long)>(StringComparer.Ordinal);
            var resolution = new long[ResolutionLabels.Length];
            var bitrate = new long[BitrateLabels.Length];
            foreach (var (key, totals) in days)
            {
                if (totals.Peak > 0)
                {
                    peaks[key] = totals.Peak;
                    transcodes[key] = (totals.Direct, totals.Transcode);
                }

                for (var i = 0; i < resolution.Length; i++)
                {
                    resolution[i] += totals.Resolution[i];
                }

                for (var i = 0; i < bitrate.Length; i++)
                {
                    bitrate[i] += totals.Bitrate[i];
                }
            }

            result = new Recorded(since, peaks, transcodes, resolution, bitrate);
        });

        return ok ? result : null;
    }

    /// <summary>Totals each of <paramref name="days"/> (local dates) from the samples; a day with none isn't in the result.</summary>
    private static Dictionary<string, DayTotals> Count(SqliteConnection connection, List<DateTime> days)
    {
        // The days go in a table so SQLite can walk them and seek each one's range in the time index.
        // Keyed by date, they come out in order, so the per-day sums need no sorting.
        using (var create = connection.CreateCommand())
        {
            create.CommandText = "CREATE TEMP TABLE days (day TEXT PRIMARY KEY, lo TEXT NOT NULL, hi TEXT NOT NULL) WITHOUT ROWID";
            create.ExecuteNonQuery();
        }

        using (var transaction = connection.BeginTransaction())
        {
            using var insert = connection.CreateCommand();
            insert.Transaction = transaction;
            insert.CommandText = "INSERT INTO days (day, lo, hi) VALUES ($day, $lo, $hi)";
            var day = insert.Parameters.Add("$day", SqliteType.Text);
            var lo = insert.Parameters.Add("$lo", SqliteType.Text);
            var hi = insert.Parameters.Add("$hi", SqliteType.Text);
            foreach (var date in days)
            {
                day.Value = Clock.DateString(date);
                lo.Value = Stamp(Clock.StartOfDay(date));
                hi.Value = Stamp(Clock.StartOfDay(date.AddDays(1)));
                insert.ExecuteNonQuery();
            }

            transaction.Commit();
        }

        var peaks = new Dictionary<string, int>(StringComparer.Ordinal);
        using (var command = connection.CreateCommand())
        {
            // Rows sharing a time were playing together, so the largest group of a day is its peak.
            command.CommandText =
                "SELECT day, MAX(n) FROM (SELECT d.day AS day, COUNT(*) AS n FROM days d CROSS JOIN samples s ON s.time >= d.lo AND s.time < d.hi GROUP BY d.day, s.time) GROUP BY day";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                peaks[reader.GetString(0)] = reader.GetInt32(1);
            }
        }

        var totals = new Dictionary<string, DayTotals>(StringComparer.Ordinal);
        using (var command = connection.CreateCommand())
        {
            command.CommandText = DayQuery;
            command.Parameters.AddWithValue("$transcode", StreamInfo.MethodTranscode);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var key = reader.GetString(0);
                var samples = reader.GetInt64(1);
                var transcode = Seconds(reader, 2);
                var resolution = new long[ResolutionLabels.Length];
                for (var i = 0; i < resolution.Length; i++)
                {
                    resolution[i] = Seconds(reader, 3 + i);
                }

                var bitrate = new long[BitrateLabels.Length];
                for (var i = 0; i < bitrate.Length; i++)
                {
                    bitrate[i] = Seconds(reader, 3 + resolution.Length + i);
                }

                totals[key] = new DayTotals(peaks.GetValueOrDefault(key), (samples * SampleSeconds) - transcode, transcode, resolution, bitrate);
            }
        }

        return totals;
    }

    /// <summary>Gets a column of per-sample counts as seconds; SQLite sums nothing to NULL.</summary>
    private static long Seconds(SqliteDataReader reader, int column) => reader.IsDBNull(column) ? 0 : reader.GetInt64(column) * SampleSeconds;

    /// <summary>
    /// One row per day: its samples, those that were transcodes, then how many were in each resolution
    /// and bitrate bucket. What the viewer received is the converted picture and rate when there is
    /// one, else the source's. Built from the bucket edges above so it can't disagree with them.
    /// </summary>
    private static string BuildDayQuery()
    {
        var sums = new System.Text.StringBuilder();
        for (var i = 0; i <= ResolutionFloors.Length; i++)
        {
            var lower = i < ResolutionFloors.Length ? ResolutionFloors[i] : 1;
            sums.Append(CultureInfo.InvariantCulture, $", SUM(s.h >= {lower}{(i > 0 ? $" AND s.h < {ResolutionFloors[i - 1]}" : string.Empty)})");
        }

        for (var i = 0; i <= BitrateCeilings.Length; i++)
        {
            var lower = i > 0 ? BitrateCeilings[i - 1] : 1;
            sums.Append(CultureInfo.InvariantCulture, $", SUM(s.r >= {lower}{(i < BitrateCeilings.Length ? $" AND s.r < {BitrateCeilings[i]}" : string.Empty)})");
        }

        return "SELECT d.day, COUNT(*), SUM(s.playMethod = $transcode)" + sums + " FROM days d CROSS JOIN (SELECT time, playMethod, " +
            "CASE WHEN outHeight > 0 THEN outHeight WHEN srcHeight > 0 THEN srcHeight END AS h, " +
            "CASE WHEN outBitrate > 0 THEN outBitrate WHEN srcBitrate > 0 THEN srcBitrate END AS r FROM samples) s " +
            "ON s.time >= d.lo AND s.time < d.hi GROUP BY d.day";
    }

    private static object Db(long? value) => value is > 0 ? value.Value : DBNull.Value;

    /// <summary>What the recorder saw on one local day, in seconds of streaming.</summary>
    private sealed record DayTotals(int Peak, long Direct, long Transcode, long[] Resolution, long[] Bitrate)
    {
        public static readonly DayTotals Empty = new(0, 0, 0, new long[ResolutionLabels.Length], new long[BitrateLabels.Length]);
    }

    /// <summary>A failure may mean the file was replaced, and what was kept of the old one is of another database.</summary>
    protected override void Forget() => settled.Clear();
}
