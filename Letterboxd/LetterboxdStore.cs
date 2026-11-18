using System.Globalization;
using Jellyfin.Plugin.HeraTv.Stats;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.HeraTv.Letterboxd;

/// <summary>A Jellyfin user's linked Letterboxd account. The refresh token, never the password, is what is kept.</summary>
public sealed record LetterboxdLink(
    string UserId,
    string Username,
    string MemberId,
    string RefreshToken,
    bool LogFinished,
    string LinkedAt,
    string? LastLoggedAt,
    string? LastError);

/// <summary>A film finished in Jellyfin, captured when it happened so a file deleted later still logs.</summary>
public sealed record WatchDraft(string UserId, string ItemId, string? Tmdb, string? Imdb, string Name, int? Year, string WatchedOn);

/// <summary>One queued or settled watch.</summary>
public sealed record WatchRow(
    long Id,
    string UserId,
    string ItemId,
    string? Tmdb,
    string? Imdb,
    string Name,
    int? Year,
    string WatchedOn,
    string State,
    string? Detail,
    int Attempts,
    string UpdatedAt);

/// <summary>Where a watch stands. <c>pending</c> and <c>failed</c> are retried; <c>logged</c> and <c>skipped</c> are final.</summary>
public static class WatchState
{
    public const string Pending = "pending";
    public const string Logged = "logged";
    public const string Skipped = "skipped";
    public const string Failed = "failed";
}

/// <summary>
/// Who has linked Letterboxd and the queue and history of films to log, in <c>letterboxd.db</c> in the
/// plugin's data folder.
/// </summary>
/// <remarks>
/// Like the notifications store, it fails soft: a database that can't be opened is logged once, reads
/// as "nobody linked, nothing queued" and writes report false, so a broken file costs the Letterboxd
/// diary and never a page or a playback.
/// </remarks>
public sealed class LetterboxdStore
{
    /// <summary>How many times a failing watch is retried before it is left alone.</summary>
    public const int MaxAttempts = 10;

    private const int KeepDays = 365;

    private const string Schema = """
        CREATE TABLE IF NOT EXISTS links (
            userId TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            memberId TEXT NOT NULL,
            refreshToken TEXT NOT NULL,
            logFinished INTEGER NOT NULL DEFAULT 1,
            linkedAt TEXT NOT NULL,
            lastLoggedAt TEXT,
            lastError TEXT
        );
        CREATE TABLE IF NOT EXISTS watches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId TEXT NOT NULL,
            itemId TEXT NOT NULL,
            tmdb TEXT,
            imdb TEXT,
            name TEXT NOT NULL,
            year INTEGER,
            watchedOn TEXT NOT NULL,
            state TEXT NOT NULL,
            detail TEXT,
            attempts INTEGER NOT NULL DEFAULT 0,
            updatedAt TEXT NOT NULL,
            UNIQUE (userId, itemId, watchedOn)
        );
        CREATE INDEX IF NOT EXISTS watches_state ON watches (state, userId);
        """;

    private const string LinkColumns = "userId, username, memberId, refreshToken, logFinished, linkedAt, lastLoggedAt, lastError";

    private const string WatchColumns = "id, userId, itemId, tmdb, imdb, name, year, watchedOn, state, detail, attempts, updatedAt";

    private readonly ILogger<LetterboxdStore> logger;
    private readonly Lock gate = new();
    private string? path;
    private int faulted;

    public LetterboxdStore(ILogger<LetterboxdStore> logger) => this.logger = logger;

    /// <summary>Gets a user's link, or null when they haven't linked an account.</summary>
    public LetterboxdLink? GetLink(string userId) => Run(
        connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = $"SELECT {LinkColumns} FROM links WHERE userId = $user";
            command.Parameters.AddWithValue("$user", userId);
            using var reader = command.ExecuteReader();
            return reader.Read() ? ReadLink(reader) : null;
        },
        null);

    /// <summary>Gets every link, oldest first.</summary>
    public IReadOnlyList<LetterboxdLink> Links() => Run(
        connection =>
        {
            var links = new List<LetterboxdLink>();
            using var command = connection.CreateCommand();
            command.CommandText = $"SELECT {LinkColumns} FROM links ORDER BY linkedAt";
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                links.Add(ReadLink(reader));
            }

            return links;
        },
        []);

    /// <summary>
    /// Saves a link after a sign-in. Signing in again as the same member keeps the person's choice and
    /// link date and clears any error; a different account starts afresh.
    /// </summary>
    public bool SaveLink(string userId, string username, string memberId, string refreshToken, DateTime nowUtc) => Run(
        connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText =
                "INSERT INTO links (userId, username, memberId, refreshToken, logFinished, linkedAt, lastLoggedAt, lastError) " +
                "VALUES ($user, $username, $member, $token, 1, $at, NULL, NULL) " +
                "ON CONFLICT (userId) DO UPDATE SET username = excluded.username, refreshToken = excluded.refreshToken, lastError = NULL, " +
                "logFinished = CASE WHEN links.memberId = excluded.memberId THEN links.logFinished ELSE 1 END, " +
                "linkedAt = CASE WHEN links.memberId = excluded.memberId THEN links.linkedAt ELSE excluded.linkedAt END, " +
                "lastLoggedAt = CASE WHEN links.memberId = excluded.memberId THEN links.lastLoggedAt ELSE NULL END, " +
                "memberId = excluded.memberId";
            command.Parameters.AddWithValue("$user", userId);
            command.Parameters.AddWithValue("$username", username);
            command.Parameters.AddWithValue("$member", memberId);
            command.Parameters.AddWithValue("$token", refreshToken);
            command.Parameters.AddWithValue("$at", Clock.UtcString(nowUtc));
            command.ExecuteNonQuery();
            return true;
        },
        false);

    /// <summary>Removes a user's link and everything queued or recorded for them.</summary>
    public bool Unlink(string userId) => Run(
        connection =>
        {
            using var transaction = connection.BeginTransaction();
            foreach (var table in new[] { "links", "watches" })
            {
                using var command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = $"DELETE FROM {table} WHERE userId = $user";
                command.Parameters.AddWithValue("$user", userId);
                command.ExecuteNonQuery();
            }

            transaction.Commit();
            return true;
        },
        false);

    public bool SetLogFinished(string userId, bool on) => Run(
        connection => Update(connection, "UPDATE links SET logFinished = $value WHERE userId = $user", userId, on ? 1 : 0),
        false);

    /// <summary>Records (or, with null, clears) what is wrong with a link.</summary>
    public bool SetError(string userId, string? error) => Run(
        connection => Update(connection, "UPDATE links SET lastError = $value WHERE userId = $user", userId, Db(error)),
        false);

    /// <summary>Saves the refresh token Letterboxd rotated to.</summary>
    public bool SetRefreshToken(string userId, string token) => Run(
        connection => Update(connection, "UPDATE links SET refreshToken = $value WHERE userId = $user", userId, token),
        false);

    /// <summary>Notes that a diary entry was written: the time, and no error any more.</summary>
    public bool MarkLogged(string userId, DateTime nowUtc) => Run(
        connection => Update(connection, "UPDATE links SET lastLoggedAt = $value, lastError = NULL WHERE userId = $user", userId, Clock.UtcString(nowUtc)),
        false);

    /// <summary>Queues a watch. False when it was already known (the same film on the same day) or couldn't be saved.</summary>
    public bool Enqueue(WatchDraft draft, DateTime nowUtc) => Run(
        connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText =
                "INSERT INTO watches (userId, itemId, tmdb, imdb, name, year, watchedOn, state, detail, attempts, updatedAt) " +
                "VALUES ($user, $item, $tmdb, $imdb, $name, $year, $on, 'pending', NULL, 0, $at) " +
                "ON CONFLICT (userId, itemId, watchedOn) DO NOTHING";
            command.Parameters.AddWithValue("$user", draft.UserId);
            command.Parameters.AddWithValue("$item", draft.ItemId);
            command.Parameters.AddWithValue("$tmdb", Db(draft.Tmdb));
            command.Parameters.AddWithValue("$imdb", Db(draft.Imdb));
            command.Parameters.AddWithValue("$name", draft.Name);
            command.Parameters.AddWithValue("$year", draft.Year is { } year ? year : DBNull.Value);
            command.Parameters.AddWithValue("$on", draft.WatchedOn);
            command.Parameters.AddWithValue("$at", Clock.UtcString(nowUtc));
            return command.ExecuteNonQuery() > 0;
        },
        false);

    /// <summary>
    /// Gets what is waiting, oldest watch first so a first watch is logged before its rewatch. Failed
    /// watches are included on request, until they have been tried <see cref="MaxAttempts"/> times.
    /// </summary>
    public IReadOnlyList<WatchRow> Due(string? userId, bool includeFailed) => Run(
        connection =>
        {
            var rows = new List<WatchRow>();
            using var command = connection.CreateCommand();
            command.CommandText =
                $"SELECT {WatchColumns} FROM watches WHERE (state = 'pending'" +
                (includeFailed ? $" OR (state = 'failed' AND attempts < {MaxAttempts.ToString(CultureInfo.InvariantCulture)})" : string.Empty) +
                ") AND ($user IS NULL OR userId = $user) ORDER BY userId, watchedOn, id";
            command.Parameters.AddWithValue("$user", Db(userId));
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                rows.Add(ReadWatch(reader));
            }

            return rows;
        },
        []);

    /// <summary>Settles a watch. A failure counts as an attempt.</summary>
    public bool Settle(long id, string state, string? detail, DateTime nowUtc) => Run(
        connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText =
                "UPDATE watches SET state = $state, detail = $detail, updatedAt = $at, " +
                "attempts = attempts + CASE WHEN $state = 'failed' THEN 1 ELSE 0 END WHERE id = $id";
            command.Parameters.AddWithValue("$id", id);
            command.Parameters.AddWithValue("$state", state);
            command.Parameters.AddWithValue("$detail", Db(detail));
            command.Parameters.AddWithValue("$at", Clock.UtcString(nowUtc));
            return command.ExecuteNonQuery() > 0;
        },
        false);

    /// <summary>Gets how many of a user's (or everyone's) watches are in a state.</summary>
    public int Count(string? userId, string state) => Run(
        connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT COUNT(*) FROM watches WHERE state = $state AND ($user IS NULL OR userId = $user)";
            command.Parameters.AddWithValue("$state", state);
            command.Parameters.AddWithValue("$user", Db(userId));
            return Convert.ToInt32(command.ExecuteScalar(), CultureInfo.InvariantCulture);
        },
        0);

    /// <summary>Gets a user's latest settled watches (logged or skipped), newest first.</summary>
    public IReadOnlyList<WatchRow> Recent(string userId, int limit) => Run(
        connection =>
        {
            var rows = new List<WatchRow>();
            using var command = connection.CreateCommand();
            command.CommandText =
                $"SELECT {WatchColumns} FROM watches WHERE userId = $user AND state IN ('logged', 'skipped') " +
                "ORDER BY updatedAt DESC, id DESC LIMIT $limit";
            command.Parameters.AddWithValue("$user", userId);
            command.Parameters.AddWithValue("$limit", limit);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                rows.Add(ReadWatch(reader));
            }

            return rows;
        },
        []);

    /// <summary>Forgets settled watches older than a year; the diary on Letterboxd is the real record.</summary>
    public bool Prune(DateTime nowUtc) => Run(
        connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "DELETE FROM watches WHERE state IN ('logged', 'skipped') AND updatedAt < $cutoff";
            command.Parameters.AddWithValue("$cutoff", Clock.UtcString(nowUtc.AddDays(-KeepDays)));
            command.ExecuteNonQuery();
            return true;
        },
        false);

    private static bool Update(SqliteConnection connection, string sql, string userId, object value)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.Parameters.AddWithValue("$user", userId);
        command.Parameters.AddWithValue("$value", value);
        return command.ExecuteNonQuery() > 0;
    }

    private static LetterboxdLink ReadLink(SqliteDataReader reader) => new(
        reader.GetString(0),
        reader.GetString(1),
        reader.GetString(2),
        reader.GetString(3),
        reader.GetInt32(4) != 0,
        reader.GetString(5),
        Text(reader, 6),
        Text(reader, 7));

    private static WatchRow ReadWatch(SqliteDataReader reader) => new(
        reader.GetInt64(0),
        reader.GetString(1),
        reader.GetString(2),
        Text(reader, 3),
        Text(reader, 4),
        reader.GetString(5),
        reader.IsDBNull(6) ? null : reader.GetInt32(6),
        reader.GetString(7),
        reader.GetString(8),
        Text(reader, 9),
        reader.GetInt32(10),
        reader.GetString(11));

    private static object Db(string? value) => value is null ? DBNull.Value : value;

    private static string? Text(SqliteDataReader reader, int column) => reader.IsDBNull(column) ? null : reader.GetString(column);

    /// <summary>Runs one unit of work on a fresh connection, creating the database first if need be. The fallback stands in when it fails.</summary>
    private T Run<T>(Func<SqliteConnection, T> work, T fallback)
    {
        try
        {
            T result;
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
                using (var schema = connection.CreateCommand())
                {
                    schema.CommandText = Schema;
                    schema.ExecuteNonQuery();
                }

                result = work(connection);
            }

            Interlocked.Exchange(ref faulted, 0);
            return result;
        }
        catch (Exception ex) when (ex is SqliteException or IOException or UnauthorizedAccessException or InvalidOperationException)
        {
            if (Interlocked.Exchange(ref faulted, 1) == 0)
            {
                logger.LogWarning(ex, "Hera TV couldn't use its Letterboxd database; films aren't being queued or logged until it can. Further failures are logged at debug level");
            }
            else
            {
                logger.LogDebug(ex, "Hera TV couldn't use its Letterboxd database");
            }

            return fallback;
        }
    }

    private static string Locate()
    {
        var folder = Plugin.Instance?.DataFolderPath ?? throw new InvalidOperationException("The plugin hasn't loaded yet.");
        Directory.CreateDirectory(folder);
        return Path.Combine(folder, "letterboxd.db");
    }
}
