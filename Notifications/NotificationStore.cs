using System.Globalization;
using System.Text.Json;
using Jellyfin.Plugin.HeraTv.Stats;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.HeraTv.Notifications;

/// <summary>
/// Everyone's notices, their choices about which to receive and where each request stood last time
/// it was looked at, in <c>notifications.db</c> in the plugin's data folder.
/// </summary>
/// <remarks>
/// Like the stats store, it fails soft: a database that can't be opened is logged once, reads as
/// "no notices" and writes report false, so a broken file costs the bell and never a page.
/// </remarks>
public sealed class NotificationStore : SqliteStore
{
    /// <summary>How long a notice is kept, counted from when it was last written.</summary>
    public const int KeepDays = 60;

    /// <summary>How long a request's recorded state is kept after it last changed; a request that old is long settled and Seerr's own history holds it.</summary>
    public const int RequestKeepDays = 180;

    // The bell lists a screenful; this keeps "New" badges bounded however much has gone unread.
    private const int MaxNewItems = 500;

    private const string Schema = """
        CREATE TABLE IF NOT EXISTS notices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId TEXT NOT NULL,
            dedupeKey TEXT NOT NULL,
            kind TEXT NOT NULL,
            title TEXT NOT NULL,
            body TEXT,
            itemId TEXT,
            imageId TEXT,
            url TEXT,
            items TEXT,
            refIds TEXT NOT NULL,
            data TEXT,
            createdAt TEXT NOT NULL,
            read INTEGER NOT NULL DEFAULT 0,
            UNIQUE (userId, dedupeKey)
        );
        CREATE INDEX IF NOT EXISTS notices_user ON notices (userId, createdAt);
        CREATE INDEX IF NOT EXISTS notices_unread ON notices (userId, read, createdAt);
        CREATE TABLE IF NOT EXISTS prefs (
            userId TEXT PRIMARY KEY,
            requests INTEGER NOT NULL,
            episodes INTEGER NOT NULL,
            arrivals INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS request_states (
            userId TEXT NOT NULL,
            key TEXT NOT NULL,
            state TEXT NOT NULL,
            requestedAt TEXT,
            updatedAt TEXT,
            PRIMARY KEY (userId, key)
        );
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """;

    private const string InsertNotice =
        "INSERT INTO notices (userId, dedupeKey, kind, title, body, itemId, imageId, url, items, refIds, data, createdAt, read) " +
        "VALUES ($user, $key, $kind, $title, $body, $item, $image, $url, $items, $refs, $data, $created, 0) ";

    // Same key, same notice: left alone, unless the producer says a later arrival changes it (more episodes today), when it is rewritten and unread again.
    private const string KeepExisting = "ON CONFLICT (userId, dedupeKey) DO NOTHING";

    private const string RewriteExisting =
        "ON CONFLICT (userId, dedupeKey) DO UPDATE SET title = excluded.title, body = excluded.body, itemId = excluded.itemId, " +
        "imageId = excluded.imageId, url = excluded.url, items = excluded.items, refIds = excluded.refIds, data = excluded.data, " +
        "createdAt = excluded.createdAt, read = 0";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    // Version 1 is the schema as it stood before versions were kept, and repairs a file from before request_states had its clock.
    private static readonly Migration[] Migrations =
    [
        new(1, (connection, transaction) =>
        {
            Migration.Execute(connection, transaction, Schema);
            AddMissingColumns(connection, transaction);
        }),
    ];

    public NotificationStore(ServerHealth health)
        : base(health, "Notifications", "use its notifications database, so notices aren't being kept", "notifications.db", Migrations)
    {
    }

    /// <summary>
    /// Writes a notice for a user. Returns true when something was written: a new notice, or an
    /// existing one rewritten because <paramref name="rewrite"/> is set.
    /// </summary>
    public bool Add(string userId, NoticeDraft draft, bool rewrite, DateTime nowUtc)
        => Writing(connection => Insert(connection, null, userId, draft, rewrite, nowUtc) > 0, false);

    /// <summary>Gets the producer's own record on a notice (<see cref="NoticeDraft.Data"/>), or null.</summary>
    public string? DataOf(string userId, string dedupeKey) => Reading(
        connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT data FROM notices WHERE userId = $user AND dedupeKey = $key";
            command.Parameters.AddWithValue("$user", userId);
            command.Parameters.AddWithValue("$key", dedupeKey);
            return command.ExecuteScalar() as string;
        },
        null);

    /// <summary>
    /// Records where a user's requests now stand and writes the notices those moves earned, in one
    /// step, so a state is never saved without its notice or the other way round. Setting
    /// <paramref name="baselineKey"/> marks the user as having had their first look. False when it couldn't be saved.
    /// </summary>
    public bool ApplyRequests(string userId, IReadOnlyList<(string Key, RequestState State)> states, IReadOnlyList<NoticeDraft> notices, string? baselineKey, DateTime nowUtc)
        => Writing(
            connection =>
            {
                using var transaction = connection.BeginTransaction();
                foreach (var (key, state) in states)
                {
                    using var command = connection.CreateCommand();
                    command.Transaction = transaction;
                    command.CommandText =
                        "INSERT INTO request_states (userId, key, state, requestedAt, updatedAt) VALUES ($user, $key, $state, $requested, $now) " +
                        "ON CONFLICT (userId, key) DO UPDATE SET state = excluded.state, requestedAt = excluded.requestedAt, updatedAt = excluded.updatedAt";
                    command.Parameters.AddWithValue("$user", userId);
                    command.Parameters.AddWithValue("$key", key);
                    command.Parameters.AddWithValue("$state", state.State);
                    command.Parameters.AddWithValue("$requested", Db(state.RequestedAt));
                    command.Parameters.AddWithValue("$now", Clock.UtcString(nowUtc));
                    command.ExecuteNonQuery();
                }

                foreach (var notice in notices)
                {
                    Insert(connection, transaction, userId, notice, false, nowUtc);
                }

                if (baselineKey is not null)
                {
                    SetMeta(connection, transaction, baselineKey, "1");
                }

                transaction.Commit();
                return true;
            },
            false);

    /// <summary>Gets what was last recorded for each of a user's requests, by <c>type:tmdbId</c>.</summary>
    public Dictionary<string, RequestState> RequestStates(string userId) => Reading(
        connection =>
        {
            var states = new Dictionary<string, RequestState>(StringComparer.Ordinal);
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT key, state, requestedAt FROM request_states WHERE userId = $user";
            command.Parameters.AddWithValue("$user", userId);
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                states[reader.GetString(0)] = new RequestState(reader.GetString(1), reader.IsDBNull(2) ? null : reader.GetString(2));
            }

            return states;
        },
        new Dictionary<string, RequestState>(StringComparer.Ordinal));

    /// <summary>Gets a small named value the producers keep (when the daily summary last ran, who has had a first look), or null.</summary>
    public string? Meta(string key) => Reading(
        connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT value FROM meta WHERE key = $key";
            command.Parameters.AddWithValue("$key", key);
            return command.ExecuteScalar() as string;
        },
        null);

    public bool SetMeta(string key, string value) => Writing(
        connection =>
        {
            SetMeta(connection, null, key, value);
            return true;
        },
        false);

    /// <summary>Gets a user's newest notices, how many they haven't read, and the library items those name.</summary>
    public Listing Read(string userId, int limit) => Reading(
        connection =>
        {
            var notices = new List<Notice>();
            using (var command = connection.CreateCommand())
            {
                command.CommandText =
                    "SELECT id, kind, title, body, itemId, imageId, url, items, createdAt, read FROM notices " +
                    "WHERE userId = $user ORDER BY createdAt DESC, id DESC LIMIT $limit";
                command.Parameters.AddWithValue("$user", userId);
                command.Parameters.AddWithValue("$limit", limit);
                using var reader = command.ExecuteReader();
                while (reader.Read())
                {
                    notices.Add(new Notice(
                        reader.GetInt64(0),
                        reader.GetString(1),
                        reader.GetString(2),
                        Text(reader, 3),
                        Text(reader, 4),
                        Text(reader, 5),
                        Text(reader, 6),
                        Text(reader, 7) is { } items ? JsonSerializer.Deserialize<List<NoticeItem>>(items, Json) : null,
                        reader.GetString(8),
                        reader.GetInt32(9) != 0));
                }
            }

            var newItems = new List<string>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            using (var command = connection.CreateCommand())
            {
                command.CommandText = "SELECT refIds FROM notices WHERE userId = $user AND read = 0 ORDER BY createdAt DESC, id DESC";
                command.Parameters.AddWithValue("$user", userId);
                using var reader = command.ExecuteReader();
                while (reader.Read() && newItems.Count < MaxNewItems)
                {
                    foreach (var id in JsonSerializer.Deserialize<List<string>>(reader.GetString(0), Json) ?? [])
                    {
                        if (seen.Add(id) && newItems.Count < MaxNewItems)
                        {
                            newItems.Add(id);
                        }
                    }
                }
            }

            return new Listing(Unread(connection, userId), notices, newItems);
        },
        new Listing(0, [], []));

    /// <summary>Marks a user's notices read: the given ones, or every one when <paramref name="ids"/> is null. Returns how many are still unread.</summary>
    public int MarkRead(string userId, IReadOnlyList<long>? ids) => Writing(
        connection =>
        {
            using (var command = connection.CreateCommand())
            {
                command.Parameters.AddWithValue("$user", userId);
                var sql = "UPDATE notices SET read = 1 WHERE userId = $user AND read = 0";
                if (ids is not null)
                {
                    // Bound, not spliced: the ids come from the request.
                    var names = ids.Select((id, i) =>
                    {
                        command.Parameters.AddWithValue($"$i{i.ToString(CultureInfo.InvariantCulture)}", id);
                        return $"$i{i.ToString(CultureInfo.InvariantCulture)}";
                    }).ToList();
                    sql += names.Count == 0 ? " AND 0" : $" AND id IN ({string.Join(", ", names)})";
                }

                command.CommandText = sql;
                command.ExecuteNonQuery();
            }

            return Unread(connection, userId);
        },
        0);

    /// <summary>Gets a user's choices, which are all on until they say otherwise.</summary>
    public NoticePrefs GetPrefs(string userId) => Reading(
        connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT requests, episodes, arrivals FROM prefs WHERE userId = $user";
            command.Parameters.AddWithValue("$user", userId);
            using var reader = command.ExecuteReader();
            return reader.Read()
                ? new NoticePrefs(reader.GetInt32(0) != 0, reader.GetInt32(1) != 0, reader.GetInt32(2) != 0)
                : NoticePrefs.Default;
        },
        NoticePrefs.Default);

    public bool SetPrefs(string userId, NoticePrefs prefs) => Writing(
        connection =>
        {
            using var command = connection.CreateCommand();
            command.CommandText =
                "INSERT INTO prefs (userId, requests, episodes, arrivals) VALUES ($user, $requests, $episodes, $arrivals) " +
                "ON CONFLICT (userId) DO UPDATE SET requests = excluded.requests, episodes = excluded.episodes, arrivals = excluded.arrivals";
            command.Parameters.AddWithValue("$user", userId);
            command.Parameters.AddWithValue("$requests", prefs.Requests ? 1 : 0);
            command.Parameters.AddWithValue("$episodes", prefs.Episodes ? 1 : 0);
            command.Parameters.AddWithValue("$arrivals", prefs.Arrivals ? 1 : 0);
            command.ExecuteNonQuery();
            return true;
        },
        false);

    /// <summary>
    /// Deletes notices not written for <see cref="KeepDays"/> days, and the recorded state of requests
    /// that haven't changed for <see cref="RequestKeepDays"/>. A request seen again after that is only
    /// announced if it is recent (<see cref="RequestTransitions.FreshFor"/>), so nothing old is replayed.
    /// </summary>
    public bool Prune(DateTime nowUtc) => Writing(
        connection =>
        {
            using var transaction = connection.BeginTransaction();
            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "DELETE FROM notices WHERE createdAt < $cutoff";
                command.Parameters.AddWithValue("$cutoff", Clock.UtcString(nowUtc.AddDays(-KeepDays)));
                command.ExecuteNonQuery();
            }

            using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                // Rows written before the column existed start their clock now, not at once.
                command.CommandText =
                    "UPDATE request_states SET updatedAt = $now WHERE updatedAt IS NULL; " +
                    "DELETE FROM request_states WHERE updatedAt < $cutoff";
                command.Parameters.AddWithValue("$now", Clock.UtcString(nowUtc));
                command.Parameters.AddWithValue("$cutoff", Clock.UtcString(nowUtc.AddDays(-RequestKeepDays)));
                command.ExecuteNonQuery();
            }

            transaction.Commit();
            return true;
        },
        false);

    private static int Insert(SqliteConnection connection, SqliteTransaction? transaction, string userId, NoticeDraft draft, bool rewrite, DateTime nowUtc)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = InsertNotice + (rewrite ? RewriteExisting : KeepExisting);
        command.Parameters.AddWithValue("$user", userId);
        command.Parameters.AddWithValue("$key", draft.DedupeKey);
        command.Parameters.AddWithValue("$kind", draft.Kind);
        command.Parameters.AddWithValue("$title", draft.Title);
        command.Parameters.AddWithValue("$body", Db(draft.Body));
        command.Parameters.AddWithValue("$item", Db(draft.ItemId));
        command.Parameters.AddWithValue("$image", Db(draft.ImageId));
        command.Parameters.AddWithValue("$url", Db(draft.Url));
        command.Parameters.AddWithValue("$items", Db(draft.Items is null ? null : JsonSerializer.Serialize(draft.Items, Json)));
        command.Parameters.AddWithValue("$refs", JsonSerializer.Serialize(draft.RefIds, Json));
        command.Parameters.AddWithValue("$data", Db(draft.Data));
        command.Parameters.AddWithValue("$created", Clock.UtcString(nowUtc));
        return command.ExecuteNonQuery();
    }

    private static void SetMeta(SqliteConnection connection, SqliteTransaction? transaction, string key, string value)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "INSERT INTO meta (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value";
        command.Parameters.AddWithValue("$key", key);
        command.Parameters.AddWithValue("$value", value);
        command.ExecuteNonQuery();
    }

    private static int Unread(SqliteConnection connection, string userId)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM notices WHERE userId = $user AND read = 0";
        command.Parameters.AddWithValue("$user", userId);
        return Convert.ToInt32(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    /// <summary>Brings a database made by an earlier version up to the current tables: <c>CREATE TABLE IF NOT EXISTS</c> leaves an old table as it was.</summary>
    private static void AddMissingColumns(SqliteConnection connection, SqliteTransaction transaction)
    {
        using var check = connection.CreateCommand();
        check.Transaction = transaction;
        check.CommandText = "SELECT COUNT(*) FROM pragma_table_info('request_states') WHERE name = 'updatedAt'";
        if (Convert.ToInt32(check.ExecuteScalar(), CultureInfo.InvariantCulture) == 0)
        {
            Migration.Execute(connection, transaction, "ALTER TABLE request_states ADD COLUMN updatedAt TEXT");
        }
    }
}
