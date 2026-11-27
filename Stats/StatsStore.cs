using System.Globalization;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

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
internal sealed class StatsStore(ILogger<StatsStore> logger)
{
    /// <summary>How often the recorder samples, and so how many seconds each sample stands for.</summary>
    public const int SampleSeconds = 60;

    /// <summary>How long samples are kept.</summary>
    public const int KeepDays = 400;

    public static readonly string[] ResolutionLabels = ["4K", "1080p", "720p", "SD"];

    public static readonly string[] BitrateLabels = ["Under 5 Mbps", "5\u201310 Mbps", "10\u201320 Mbps", "20\u201340 Mbps", "Over 40 Mbps"];

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

    private readonly Lock gate = new();
    private string? path;
    private int faulted;
    private bool ready;

    /// <summary>Formats a sample time. One value per tick, so rows that share it were concurrent.</summary>
    public static string Stamp(DateTime utc) => utc.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture);

    /// <summary>Gets the resolution bucket (an index into <see cref="ResolutionLabels"/>) for a picture height.</summary>
    public static int ResolutionBucket(int height) => height >= 1600 ? 0 : height >= 900 ? 1 : height >= 600 ? 2 : 3;

    /// <summary>Gets the bitrate bucket (an index into <see cref="BitrateLabels"/>) for bits per second.</summary>
    public static int BitrateBucket(long bitsPerSecond) => bitsPerSecond switch
    {
        < 5_000_000 => 0,
        < 10_000_000 => 1,
        < 20_000_000 => 2,
        < 40_000_000 => 3,
        _ => 4,
    };

    /// <summary>Adds one tick's samples; returns false when they couldn't be saved.</summary>
    public bool Add(DateTime utc, IReadOnlyList<Sample> samples)
    {
        if (samples.Count == 0)
        {
            return true;
        }

        return Run(connection =>
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
    public bool Prune(DateTime utc) => Run(connection =>
    {
        using var command = connection.CreateCommand();
        command.CommandText = "DELETE FROM samples WHERE time < $cutoff";
        command.Parameters.AddWithValue("$cutoff", Stamp(utc.Date.AddDays(-KeepDays)));
        command.ExecuteNonQuery();
    });

    /// <summary>
    /// Reads what was recorded from the start of <paramref name="from"/> (a local day) on, with each
    /// sample counted on its local day. Null when the recorder has never saved a sample, or the
    /// database can't be read.
    /// </summary>
    internal Recorded? Read(DateTime from)
    {
        Recorded? result = null;
        var ok = Run(connection =>
        {
            DateTime since;
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT MIN(time) FROM samples";
                if (command.ExecuteScalar() is not string first
                    || !DateTime.TryParse(first, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out since))
                {
                    return;
                }
            }

            // Samples are stored as UTC instants, which sort and never repeat; they are put on a local day as they are read.
            var floor = Stamp(Clock.ToUtc(from.Date));
            var peaks = new Dictionary<string, int>(StringComparer.Ordinal);
            using (var command = connection.CreateCommand())
            {
                // Rows sharing a time were playing together, so the largest group of a day is its peak.
                command.CommandText = "SELECT time, COUNT(*) FROM samples WHERE time >= $from GROUP BY time";
                command.Parameters.AddWithValue("$from", floor);
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    if (LocalDay(reader.GetString(0)) is { } day)
                    {
                        peaks[day] = Math.Max(peaks.GetValueOrDefault(day), reader.GetInt32(1));
                    }
                }
            }

            var transcodes = new Dictionary<string, (long, long)>(StringComparer.Ordinal);
            var resolution = new long[ResolutionLabels.Length];
            var bitrate = new long[BitrateLabels.Length];
            using (var command = connection.CreateCommand())
            {
                command.CommandText =
                    "SELECT time, playMethod, srcHeight, outHeight, srcBitrate, outBitrate FROM samples WHERE time >= $from";
                command.Parameters.AddWithValue("$from", floor);
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    if (LocalDay(reader.GetString(0)) is not { } day)
                    {
                        continue;
                    }

                    var (direct, transcode) = transcodes.GetValueOrDefault(day);
                    transcodes[day] = reader.GetString(1) == StreamInfo.MethodTranscode
                        ? (direct, transcode + SampleSeconds)
                        : (direct + SampleSeconds, transcode);

                    // What the viewer received: the converted picture and rate when there is one, else the source's.
                    var height = Positive(reader, 3) ?? Positive(reader, 2);
                    if (height is { } h)
                    {
                        resolution[ResolutionBucket((int)h)] += SampleSeconds;
                    }

                    var rate = Positive(reader, 5) ?? Positive(reader, 4);
                    if (rate is { } r)
                    {
                        bitrate[BitrateBucket(r)] += SampleSeconds;
                    }
                }
            }

            result = new Recorded(since, peaks, transcodes.ToDictionary(p => p.Key, p => p.Value), resolution, bitrate);
        });

        return ok ? result : null;
    }

    /// <summary>Gets the local date (<c>yyyy-MM-dd</c>) a stored sample time falls on, or null if it can't be read.</summary>
    private static string? LocalDay(string stamp)
        => DateTime.TryParse(stamp, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var utc)
            ? Clock.DateString(Clock.FromUtc(utc))
            : null;

    private static object Db(long? value) => value is > 0 ? value.Value : DBNull.Value;

    private static long? Positive(SqliteDataReader reader, int column)
        => reader.IsDBNull(column) || reader.GetInt64(column) <= 0 ? null : reader.GetInt64(column);

    /// <summary>Runs one unit of work on a fresh connection, creating the database first if need be.</summary>
    private bool Run(Action<SqliteConnection> work)
    {
        try
        {
            lock (gate)
            {
                var file = path ??= Locate();
                var builder = new SqliteConnectionStringBuilder
                {
                    DataSource = file,
                    Mode = SqliteOpenMode.ReadWriteCreate,
                    DefaultTimeout = 5,
                    Pooling = false,
                };
                using var connection = new SqliteConnection(builder.ConnectionString);
                connection.Open();
                // The tables are made once per process, not on every call.
                if (!ready)
                {
                    using var schema = connection.CreateCommand();
                    schema.CommandText = Schema;
                    schema.ExecuteNonQuery();
                    ready = true;
                }

                work(connection);
            }

            Interlocked.Exchange(ref faulted, 0);
            return true;
        }
        catch (Exception ex) when (ex is SqliteException or IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            // A database that went wrong may be gone or replaced: make the tables again next time.
            ready = false;
            if (Interlocked.Exchange(ref faulted, 1) == 0)
            {
                logger.LogWarning(ex, "Hera TV couldn't use its stats database; streams aren't being recorded until it can. Further failures are logged at debug level");
            }
            else
            {
                logger.LogDebug(ex, "Hera TV couldn't use its stats database");
            }

            return false;
        }
    }

    private static string Locate()
    {
        var folder = Plugin.Instance?.DataFolderPath ?? throw new InvalidOperationException("The plugin hasn't loaded yet.");
        Directory.CreateDirectory(folder);
        return Path.Combine(folder, "stats.db");
    }
}
