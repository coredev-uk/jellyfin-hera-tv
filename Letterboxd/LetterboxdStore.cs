using System.Globalization;
using Jellyfin.Plugin.HeraTv.Stats;
using Microsoft.Data.Sqlite;

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
public sealed class LetterboxdStore : SqliteStore
{
    /// <summary>How many times a failing watch is retried before it is left alone.</summary>
    public const int MaxAttempts = 10;

    private const int KeepDays = 365;

    // Far more than a run ever settles (see LetterboxdSync.RunCap), so the queue is never read whole.
    private const int DueLimit = 500;

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

    // Version 1 is the schema as it stood before versions were kept.
    private static readonly Migration[] Migrations = [new(1, Schema)];

    public LetterboxdStore(ServerHealth health)
        : base(health, "Letterboxd", "use its Letterboxd database, so films aren't being queued or logged", "letterboxd.db", Migrations)
    {
    }

    /// <summary>Gets a user's link, or null when they haven't linked an account.</summary>
    public LetterboxdLink? GetLink(string userId) => Reading(
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
    public IReadOnlyList<LetterboxdLink> Links() => Reading(
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
    public bool SaveLink(string userId, string username, string memberId, string refreshToken, DateTime nowUtc) => Writing(
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
    public bool Unlink(string userId) => Writing(
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

    public bool SetLogFinished(string userId, bool on) => Writing(
        connection => Update(connection, "UPDATE links SET logFinished = $value WHERE userId = $user", userId, on ? 1 : 0),
        false);

    /// <summary>Records (or, with null, clears) what is wrong with a link.</summary>
    public bool SetError(string userId, string? error) => Writing(
        connection => Update(connection, "UPDATE links SET lastError = $value WHERE userId = $user", userId, Db(error)),
        false);

    /// <summary>Saves the refresh token Letterboxd rotated to.</summary>
    public bool SetRefreshToken(string userId, string token) => Writing(
        connection => Update(connection, "UPDATE links SET refreshToken = $value WHERE userId = $user", userId, token),
        false);

    /// <summary>Notes that a diary entry was written: the time, and no error any more.</summary>
    public bool MarkLogged(string userId, DateTime nowUtc) => Writing(
        connection => Update(connection, "UPDATE links SET lastLoggedAt = $value, lastError = NULL WHERE userId = $user", userId, Clock.UtcString(nowUtc)),
        false);

    /// <summary>Queues a watch. False when it was already known (the same film on the same day) or couldn't be saved.</summary>
    public bool Enqueue(WatchDraft draft, DateTime nowUtc) => Writing(
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
    /// Queues many watches in one step. Returns how many were new: the rest were already known (the
    /// same film on the same day). Nothing is queued when the database can't be written.
    /// </summary>
    public int EnqueueMany(IReadOnlyList<WatchDraft> drafts, DateTime nowUtc) => drafts.Count == 0 ? 0 : Writing(
        connection =>
        {
            using var transaction = connection.BeginTransaction();
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText =
                "INSERT INTO watches (userId, itemId, tmdb, imdb, name, year, watchedOn, state, detail, attempts, updatedAt) " +
                "VALUES ($user, $item, $tmdb, $imdb, $name, $year, $on, 'pending', NULL, 0, $at) " +
                "ON CONFLICT (userId, itemId, watchedOn) DO NOTHING";
            var user = command.Parameters.Add("$user", SqliteType.Text);
            var item = command.Parameters.Add("$item", SqliteType.Text);
            var tmdb = command.Parameters.Add("$tmdb", SqliteType.Text);
            var imdb = command.Parameters.Add("$imdb", SqliteType.Text);
            var name = command.Parameters.Add("$name", SqliteType.Text);
            var year = command.Parameters.Add("$year", SqliteType.Integer);
            var on = command.Parameters.Add("$on", SqliteType.Text);
            var at = command.Parameters.Add("$at", SqliteType.Text);
            at.Value = Clock.UtcString(nowUtc);
            var added = 0;
            foreach (var draft in drafts)
            {
                user.Value = draft.UserId;
                item.Value = draft.ItemId;
                tmdb.Value = Db(draft.Tmdb);
                imdb.Value = Db(draft.Imdb);
                name.Value = draft.Name;
                year.Value = draft.Year is { } y ? y : DBNull.Value;
                on.Value = draft.WatchedOn;
                if (command.ExecuteNonQuery() > 0)
                {
                    added++;
                }
            }

            transaction.Commit();
            return added;
        },
        0);

    /// <summary>
    /// Gets what is waiting, oldest watch first so a first watch is logged before its rewatch. Failed
    /// watches are included on request, until they have been tried <see cref="MaxAttempts"/> times.
    /// At most <paramref name="limit"/> rows per person come back, so one person's long queue never
    /// keeps everyone else's from the run; a run settles a few dozen, and the rest wait for the next.
    /// </summary>
    public IReadOnlyList<WatchRow> Due(string? userId, bool includeFailed, int limit = DueLimit) => Reading(
        connection =>
        {
            var rows = new List<WatchRow>();
            using var command = connection.CreateCommand();
            command.CommandText =
                $"SELECT {WatchColumns} FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY userId ORDER BY watchedOn, id) AS place FROM watches WHERE (state = 'pending'" +
                (includeFailed ? $" OR (state = 'failed' AND attempts < {MaxAttempts.ToString(CultureInfo.InvariantCulture)})" : string.Empty) +
                ") AND ($user IS NULL OR userId = $user)) WHERE place <= $limit ORDER BY userId, watchedOn, id";
            command.Parameters.AddWithValue("$user", Db(userId));
            command.Parameters.AddWithValue("$limit", limit);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                rows.Add(ReadWatch(reader));
            }

            return rows;
        },
        []);

    /// <summary>Settles a watch. A failure counts as an attempt.</summary>
    public bool Settle(long id, string state, string? detail, DateTime nowUtc) => Writing(
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

    /// <summary>Settles many watches to one state in one step. A failure counts as an attempt.</summary>
    public bool SettleMany(IReadOnlyList<long> ids, string state, string? detail, DateTime nowUtc) => ids.Count == 0 || Writing(
        connection =>
        {
            using var transaction = connection.BeginTransaction();
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText =
                "UPDATE watches SET state = $state, detail = $detail, updatedAt = $at, " +
                "attempts = attempts + CASE WHEN $state = 'failed' THEN 1 ELSE 0 END WHERE id = $id";
            var id = command.Parameters.Add("$id", SqliteType.Integer);
            command.Parameters.AddWithValue("$state", state);
            command.Parameters.AddWithValue("$detail", Db(detail));
            command.Parameters.AddWithValue("$at", Clock.UtcString(nowUtc));
            foreach (var one in ids)
            {
                id.Value = one;
                command.ExecuteNonQuery();
            }

            transaction.Commit();
            return true;
        },
        false);

    /// <summary>Gets how many of a user's (or everyone's) watches are in a state.</summary>
    public int Count(string? userId, string state) => Reading(
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
    public IReadOnlyList<WatchRow> Recent(string userId, int limit) => Reading(
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
    public bool Prune(DateTime nowUtc) => Writing(
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
}
