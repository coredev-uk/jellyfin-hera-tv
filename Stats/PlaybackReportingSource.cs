using System.Globalization;
using MediaBrowser.Common.Configuration;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.HeraTv.Stats;

/// <summary>One row of Playback Reporting's history: a stretch of playback of one item. <paramref name="Start"/> is local wall-clock time.</summary>
internal sealed record Play(DateTime Start, string User, string ItemId, string Type, string Name, string Method, string Client, string Device, long Seconds);

/// <summary>Why Playback Reporting's history can't be shown; the words the Statistics page is sent.</summary>
internal static class Unavailable
{
    /// <summary>There is no Playback Reporting database: the plugin isn't installed, or hasn't recorded anything yet.</summary>
    public const string NotInstalled = "notInstalled";

    /// <summary>The database is there but its tables or columns aren't the ones Hera TV reads: Playback Reporting has changed.</summary>
    public const string SchemaChanged = "schemaChanged";

    /// <summary>The database is there and looks right but couldn't be read (locked, damaged, no permission).</summary>
    public const string Unreadable = "unreadable";
}

/// <summary>What was read from Playback Reporting: the plays, or null with the reason there are none to show (<see cref="Unavailable"/>).</summary>
internal sealed record PlayHistory(IReadOnlyList<Play>? Plays, string? Reason);

/// <summary>
/// Reads what people watched from the Playback Reporting plugin's database. Hera TV never writes to
/// it, and the file is opened afresh (read-only) for each query so nothing is held between them.
/// </summary>
/// <remarks>
/// It fails soft: a missing file, or any SQLite error, reads as "unavailable" with the reason (not
/// installed, schema changed, unreadable) and is reported once, never as an error the Statistics page has to handle.
/// <para>
/// SQLitePCLRaw isn't initialised here: Jellyfin's own <c>Microsoft.Data.Sqlite</c> (the one loaded in
/// place of the package this builds against) finds and initialises its bundled e_sqlite3 the first time
/// a connection opens, as it does for the server's database.
/// </para>
/// <para>
/// Playback Reporting stamps <c>DateCreated</c> with <c>DateTime.Now</c> and writes it without an
/// offset, so the stored text is already the server's local time (the plugin itself reads it back as
/// local). It is used as it is, which is what the Statistics pages bucket by; the <c>$from</c> bound
/// is a local time too.
/// </para>
/// </remarks>
internal sealed class PlaybackReportingSource(IApplicationPaths paths, ServerHealth health)
{
    /// <summary>Plays shorter than this are skips and previews, not watching.</summary>
    public const int MinimumSeconds = 60;

    private const string Query =
        "SELECT DateCreated, UserId, ItemId, ItemType, ItemName, PlaybackMethod, ClientName, DeviceName, PlayDuration " +
        "FROM PlaybackActivity " +
        "WHERE DateCreated >= $from AND PlayDuration >= $minimum " +
        "AND ($user IS NULL OR lower(replace(UserId, '-', '')) = $user) " +
        "ORDER BY DateCreated";

    private const string Feature = "Playback Reporting history";

    // A few unreadable rows are noise; a tenth of them, and at least this many, is a format that has changed.
    private const int ConcerningRows = 5;

    private string DatabaseFile => Path.Combine(paths.DataPath, "playback_reporting.db");

    /// <summary>Gets a string that changes whenever Playback Reporting's database does, for keeping what was built from it.</summary>
    public string Signature() => StatsStore.FileSignature(DatabaseFile);

    /// <summary>Maps a recorded playback method to Direct Play, Direct Stream or Transcode.</summary>
    /// <remarks>
    /// Playback Reporting writes "Transcode (v:h264 a:aac)". When the video is "direct" only the audio
    /// was converted, which is a Direct Stream everywhere else on the page.
    /// </remarks>
    public static string MethodLabel(string? method)
    {
        if (string.IsNullOrEmpty(method))
        {
            return "Direct Play";
        }

        if (method.StartsWith("Transcode", StringComparison.OrdinalIgnoreCase))
        {
            return method.Contains("v:direct", StringComparison.OrdinalIgnoreCase) ? "Direct Stream" : "Transcode";
        }

        return method.StartsWith("DirectStream", StringComparison.OrdinalIgnoreCase) ? "Direct Stream" : "Direct Play";
    }

    /// <summary>
    /// Reads the plays that started at or after <paramref name="from"/>, for everyone or for one user
    /// (a GUID in N format). The plays are null, with the reason, when Playback Reporting's database
    /// isn't there or can't be read.
    /// </summary>
    public PlayHistory Read(DateTime from, string? user)
    {
        var file = DatabaseFile;
        if (!File.Exists(file))
        {
            return new PlayHistory(null, Unavailable.NotInstalled);
        }

        try
        {
            var builder = new SqliteConnectionStringBuilder
            {
                DataSource = file,
                Mode = SqliteOpenMode.ReadOnly,
                Cache = SqliteCacheMode.Shared,
                DefaultTimeout = 3,
                Pooling = false,
            };
            using var connection = new SqliteConnection(builder.ConnectionString);
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = Query;
            command.CommandTimeout = 5;
            command.Parameters.AddWithValue("$from", from.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture));
            command.Parameters.AddWithValue("$minimum", MinimumSeconds);
            command.Parameters.AddWithValue("$user", user is null ? DBNull.Value : user);

            var plays = new List<Play>();
            var skipped = 0;
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                // Rows that can't be read as a play (no time, no user) are skipped rather than failing the page.
                if (ReadPlay(reader) is { } play)
                {
                    plays.Add(play);
                }
                else
                {
                    skipped++;
                }
            }

            if (skipped >= ConcerningRows && skipped * 10 >= skipped + plays.Count)
            {
                health.Fault(Feature, string.Create(CultureInfo.InvariantCulture, $"read {skipped} of {skipped + plays.Count} rows of Playback Reporting's history: the time or user in them isn't in the form Hera TV expects"));
            }
            else
            {
                health.Recovered(Feature);
            }

            return new PlayHistory(plays, null);
        }
        catch (SqliteException ex) when (ex.Message.Contains("no such", StringComparison.OrdinalIgnoreCase))
        {
            // "no such table" or "no such column": the file is Playback Reporting's, and no longer in the shape this reads.
            health.Fault(Feature, "read Playback Reporting's history: its tables or columns aren't what Hera TV expects, so the plugin's database has probably changed", ex);
            return new PlayHistory(null, Unavailable.SchemaChanged);
        }
        catch (Exception ex) when (ex is SqliteException or IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            health.Fault(Feature, "read Playback Reporting's database; the Statistics page shows it as unavailable", ex);
            return new PlayHistory(null, Unavailable.Unreadable);
        }
    }

    /// <summary>Reads one row as a play, or null when it has no usable time, user or length.</summary>
    private static Play? ReadPlay(SqliteDataReader reader)
    {
        try
        {
            if (reader.IsDBNull(0) || reader.IsDBNull(1) || reader.IsDBNull(8)
                || !DateTime.TryParse(reader.GetString(0), CultureInfo.InvariantCulture, DateTimeStyles.None, out var start))
            {
                return null;
            }

            return new Play(
                start,
                reader.GetString(1).Replace("-", string.Empty, StringComparison.Ordinal).ToLowerInvariant(),
                Text(reader, 2),
                Text(reader, 3),
                Text(reader, 4),
                MethodLabel(Text(reader, 5)),
                Text(reader, 6),
                Text(reader, 7),
                reader.GetInt64(8));
        }
        catch (Exception ex) when (ex is InvalidCastException or FormatException or OverflowException)
        {
            return null;
        }
    }

    private static string Text(SqliteDataReader reader, int column) => reader.IsDBNull(column) ? string.Empty : reader.GetString(column);
}
