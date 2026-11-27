using System.Globalization;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>One step in a database's history: what to run to take it from the version before this one to this one.</summary>
/// <param name="Version">The <c>user_version</c> the database has once this has run. Steps count up from 1 with no gaps.</param>
/// <param name="Apply">Makes the change. It runs in a transaction that also records the new version, so it is all or nothing.</param>
public sealed record Migration(int Version, Action<SqliteConnection, SqliteTransaction> Apply)
{
    /// <summary>A step that is only SQL.</summary>
    public Migration(int version, string sql)
        : this(version, (connection, transaction) => Execute(connection, transaction, sql))
    {
    }

    /// <summary>Runs one statement (or several, separated by semicolons) inside a migration's transaction.</summary>
    public static void Execute(SqliteConnection connection, SqliteTransaction transaction, string sql)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }
}

/// <summary>
/// What every Hera database shares: where the file lives, a fresh short-lived connection per piece of
/// work, the tables made and brought up to date once per process, and failing soft. A database that
/// can't be used is reported once (<see cref="ServerHealth"/>), reads as "nothing" and writes report
/// false, so a broken file costs its feature and never a page.
/// </summary>
/// <remarks>
/// <para>
/// The file's <c>user_version</c> says which of the <see cref="Migration"/>s have run. Version 1 is
/// the schema as it stood before versions were kept (and brings an older file up to it), so every
/// database from an earlier release starts at 0 and is upgraded in place, in one transaction per step.
/// </para>
/// <para>
/// A file whose version is higher than this build knows was written by a newer Hera TV (the plugin
/// was downgraded). It is still read, but nothing is written to it: an older build can't know what a
/// newer schema means, and writing would damage what the newer one expects. It says so once, and the
/// file is left exactly as it was for the newer build to find.
/// </para>
/// </remarks>
public abstract class SqliteStore
{
    private readonly Lock gate = new();
    private readonly ServerHealth health;
    private readonly string feature;
    private readonly string failure;
    private readonly string fileName;
    private readonly IReadOnlyList<Migration> migrations;
    private string? path;
    private int faulted;
    private bool ready;
    private bool newer;

    /// <summary>Initialises the store.</summary>
    /// <param name="health">Where a failure is reported.</param>
    /// <param name="feature">The feature's name on the dashboard ("Notifications").</param>
    /// <param name="failure">What was being done when it failed, as a verb phrase ("use its notifications database, so notices aren't being kept").</param>
    /// <param name="fileName">The file's name in the plugin's data folder.</param>
    /// <param name="migrations">The database's whole history, in order.</param>
    protected SqliteStore(ServerHealth health, string feature, string failure, string fileName, IReadOnlyList<Migration> migrations)
    {
        for (var i = 0; i < migrations.Count; i++)
        {
            if (migrations[i].Version != i + 1)
            {
                throw new ArgumentException($"{fileName}: migration {i + 1} is numbered {migrations[i].Version}.", nameof(migrations));
            }
        }

        this.health = health;
        this.feature = feature;
        this.failure = failure;
        this.fileName = fileName;
        this.migrations = migrations;
    }

    /// <summary>Gets the lock every piece of work runs under; what a subclass keeps beside the file is guarded by it.</summary>
    protected Lock Gate => gate;

    /// <summary>Gets the file's path, or null before the plugin has loaded.</summary>
    protected string? FilePath => path ?? (Plugin.Instance?.DataFolderPath is { } folder ? Path.Combine(folder, fileName) : null);

    /// <summary>Gets the highest version this build understands.</summary>
    internal int LatestVersion => migrations.Count;

    /// <summary>
    /// Gets whether the file was made by a newer Hera TV and so is read but never written (see the remarks).
    /// Anything that does outside work and then records it in the store (a diary entry, a message) must not
    /// start while this is true, or it would repeat that work every run, since nothing it records is kept.
    /// </summary>
    public bool IsReadOnly
    {
        get
        {
            // Opens the file if it hasn't been yet, which is what finds out.
            Reading(_ => true, false);
            lock (gate)
            {
                return newer;
            }
        }
    }

    /// <summary>Runs work that only reads. The fallback stands in when it fails.</summary>
    protected T Reading<T>(Func<SqliteConnection, T> work, T fallback) => Run(work, fallback, writes: false);

    /// <summary>Runs work that only reads, for callers with nothing to return. False when it failed.</summary>
    protected bool Reading(Action<SqliteConnection> work) => Run(
        connection =>
        {
            work(connection);
            return true;
        },
        false,
        writes: false);

    /// <summary>Runs work that writes. It doesn't run at all on a database a newer Hera TV made: the fallback stands in.</summary>
    protected T Writing<T>(Func<SqliteConnection, T> work, T fallback) => Run(work, fallback, writes: true);

    /// <summary>Runs work that writes, for callers with nothing to return. False when it failed or was held off.</summary>
    protected bool Writing(Action<SqliteConnection> work) => Run(
        connection =>
        {
            work(connection);
            return true;
        },
        false,
        writes: true);

    /// <summary>Called, under the lock, when a failure may mean the file was replaced: drop anything kept from the old one.</summary>
    protected virtual void Forget()
    {
    }

    protected static object Db(string? value) => value is null ? DBNull.Value : value;

    protected static string? Text(SqliteDataReader reader, int column) => reader.IsDBNull(column) ? null : reader.GetString(column);

    private T Run<T>(Func<SqliteConnection, T> work, T fallback, bool writes)
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

                // The tables are made once per process, not on every call: the bell polls constantly.
                if (!ready)
                {
                    newer = Prepare(connection);
                    ready = true;
                }

                if (writes && newer)
                {
                    return fallback;
                }

                result = work(connection);
            }

            if (Interlocked.Exchange(ref faulted, 0) == 1)
            {
                health.Recovered(feature);
            }

            return result;
        }
        catch (Exception ex) when (ex is SqliteException or IOException or UnauthorizedAccessException or InvalidOperationException or JsonException)
        {
            // A database that went wrong may be gone or replaced: make the tables again next time.
            lock (gate)
            {
                ready = false;
                Forget();
            }

            Interlocked.Exchange(ref faulted, 1);
            health.Fault(feature, failure, ex);
            return fallback;
        }
    }

    /// <summary>Brings the file up to date, and says whether it is from a newer Hera TV and so to be left alone.</summary>
    private bool Prepare(SqliteConnection connection)
    {
        var version = UserVersion(connection);
        if (version > migrations.Count)
        {
            // Not an error to retry: the file stays as it is until this build is replaced by one that knows it.
            Interlocked.Exchange(ref faulted, 0);
            health.Fault(
                feature,
                string.Create(CultureInfo.InvariantCulture, $"write to {fileName}, which was made by a newer Hera TV (schema {version}; this build knows {migrations.Count}). It is read but left unchanged until Hera TV is updated"));
            return true;
        }

        foreach (var migration in migrations.Skip(version))
        {
            using var transaction = connection.BeginTransaction();
            migration.Apply(connection, transaction);

            // The version is recorded in the same transaction: a step is never half-done and remembered as done.
            Migration.Execute(connection, transaction, string.Create(CultureInfo.InvariantCulture, $"PRAGMA user_version = {migration.Version}"));
            transaction.Commit();
        }

        return false;
    }

    /// <summary>Gets the version a file records for itself; 0 for one made before versions were kept, or a new one.</summary>
    internal static int UserVersion(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "PRAGMA user_version";
        return Convert.ToInt32(command.ExecuteScalar(), CultureInfo.InvariantCulture);
    }

    private string Locate()
    {
        var folder = Plugin.Instance?.DataFolderPath ?? throw new InvalidOperationException("The plugin hasn't loaded yet.");
        Directory.CreateDirectory(folder);
        return Path.Combine(folder, fileName);
    }
}
