using System.Collections.Concurrent;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>
/// Keeps one built value per key for a while, and builds it once however many callers ask at the
/// same moment: the rest wait for the first build rather than repeating it.
/// </summary>
/// <remarks>
/// A build that throws is forgotten, so the next caller tries again instead of being handed the same
/// failure for the whole lifetime. The keys are people (or one fixed key), so the table stays small
/// and needs no eviction.
/// </remarks>
/// <typeparam name="T">What is built.</typeparam>
internal sealed class UserCache<T>(TimeSpan lifetime)
    where T : class
{
    private readonly ConcurrentDictionary<Guid, Entry> _entries = new();
    private readonly long _lifetimeMs = (long)lifetime.TotalMilliseconds;

    /// <summary>Gets the value for <paramref name="key"/>, running <paramref name="build"/> only when there isn't a live one.</summary>
    public T Get(Guid key, Func<T> build)
    {
        var now = Environment.TickCount64;
        if (!_entries.TryGetValue(key, out var entry) || entry.Expires <= now)
        {
            var fresh = new Entry(now + _lifetimeMs, build);
            // Two callers racing past the expired entry settle on one winner; only that one's build runs.
            entry = _entries.AddOrUpdate(key, fresh, (_, old) => old.Expires > now ? old : fresh);
        }

        try
        {
            return entry.Value.Value;
        }
        catch
        {
            _entries.TryRemove(new KeyValuePair<Guid, Entry>(key, entry));
            throw;
        }
    }

    /// <summary>Forgets everything built, so the next read builds again.</summary>
    public void Clear() => _entries.Clear();

    private sealed class Entry(long expires, Func<T> build)
    {
        public long Expires { get; } = expires;

        public Lazy<T> Value { get; } = new(build);
    }
}
