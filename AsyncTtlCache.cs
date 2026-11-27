using System.Collections.Concurrent;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>
/// Keeps answers for a while, bounded in size, and works each one out once however many callers ask
/// at the same moment: the rest share the first caller's work. Used for everything that is keyed by
/// something a person can vary (a search, a video, a title) or that costs a call to another server.
/// </summary>
/// <remarks>
/// A load that throws is never kept: the next caller tries again. An answer that is <c>null</c> (the
/// other server didn't answer, or said it knew nothing) is kept only for <paramref name="unsureFor"/>,
/// so a blip heals quickly while a real answer lives for the full time. Expiry runs from when the
/// entry was made, so a slow load has that much less to live.
/// </remarks>
/// <param name="maxEntries">The most entries to hold; more drops the expired ones and then those closest to expiring.</param>
/// <param name="unsureFor">How long a <c>null</c> answer is kept at most; the longest it is ever kept is the caller's own time.</param>
/// <typeparam name="TKey">What the answers are keyed by.</typeparam>
/// <typeparam name="TValue">What is kept; <c>null</c> means "no answer".</typeparam>
internal sealed class AsyncTtlCache<TKey, TValue>(int maxEntries, TimeSpan? unsureFor = null)
    where TKey : notnull
{
    private readonly ConcurrentDictionary<TKey, Entry> entries = new();

    /// <summary>
    /// Gets the answer for <paramref name="key"/>, starting <paramref name="load"/> only when there isn't a
    /// live one. A <paramref name="ttl"/> of zero or less reads through the cache without adding to it, for a
    /// sweep that would otherwise push out what pages use.
    /// </summary>
    public Task<TValue> GetAsync(TKey key, TimeSpan ttl, Func<Task<TValue>> load)
    {
        var now = DateTime.UtcNow;
        if (entries.TryGetValue(key, out var hit) && hit.Usable(now))
        {
            return hit.Read;
        }

        if (ttl <= TimeSpan.Zero)
        {
            return load();
        }

        var created = new Entry(now + ttl, load);
        var entry = entries.AddOrUpdate(key, created, (_, old) => old.Usable(now) ? old : created);
        if (!ReferenceEquals(entry, created))
        {
            return entry.Read;
        }

        // Only the call that made the entry decides how long its answer is kept: an empty one only briefly.
        var task = created.Read;
        var empty = unsureFor is { } brief && brief < ttl ? brief : ttl;
        _ = task.ContinueWith(
            finished =>
            {
                if (finished.Status != TaskStatus.RanToCompletion || finished.Result is null)
                {
                    created.ExpireIn(empty);
                }
            },
            CancellationToken.None,
            TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
        Prune(key);
        return task;
    }

    /// <summary>The same for a value that is worked out without waiting.</summary>
    public TValue Get(TKey key, TimeSpan ttl, Func<TValue> build)
        => GetAsync(key, ttl, () => Task.FromResult(build())).GetAwaiter().GetResult();

    /// <summary>Forgets every entry whose key matches, so the next read of it loads again.</summary>
    public void Remove(Func<TKey, bool> matches)
    {
        foreach (var pair in entries)
        {
            if (matches(pair.Key))
            {
                entries.TryRemove(pair);
            }
        }
    }

    /// <summary>Forgets everything.</summary>
    public void Clear() => entries.Clear();

    /// <summary>
    /// Trims the cache once it holds more than its limit: the expired entries go first and then, if that
    /// isn't enough, those closest to expiring, down to nine tenths of the limit so the next insert
    /// doesn't prune again. The entry just written (<paramref name="keep"/>) is never dropped.
    /// </summary>
    private void Prune(TKey keep)
    {
        if (entries.Count <= maxEntries)
        {
            return;
        }

        var now = DateTime.UtcNow;
        foreach (var pair in entries)
        {
            if (pair.Value.Expires <= now && !EqualityComparer<TKey>.Default.Equals(pair.Key, keep))
            {
                entries.TryRemove(pair);
            }
        }

        var excess = entries.Count - (maxEntries - (maxEntries / 10));
        if (excess <= 0)
        {
            return;
        }

        foreach (var pair in entries.OrderBy(p => p.Value.Expires).Take(excess + 1).ToList())
        {
            if (!EqualityComparer<TKey>.Default.Equals(pair.Key, keep))
            {
                entries.TryRemove(pair);
            }
        }
    }

    private sealed class Entry
    {
        private readonly Lazy<Task<TValue>> load;
        private long expires;

        public Entry(DateTime expires, Func<Task<TValue>> load)
        {
            this.expires = expires.Ticks;

            // A load that throws before it returns a task is a failed read like any other.
            this.load = new Lazy<Task<TValue>>(() =>
            {
                try
                {
                    return load();
                }
                catch (Exception ex)
                {
                    return Task.FromException<TValue>(ex);
                }
            });
        }

        /// <summary>Gets the read: started by whoever asks first, shared by everyone after.</summary>
        public Task<TValue> Read => load.Value;

        public DateTime Expires => new(Volatile.Read(ref expires), DateTimeKind.Utc);

        public void ExpireIn(TimeSpan span) => Volatile.Write(ref expires, (DateTime.UtcNow + span).Ticks);

        /// <summary>Gets whether this entry may be served: not expired, and not a read that failed.</summary>
        public bool Usable(DateTime now) => Expires > now && !(load.IsValueCreated && (load.Value.IsFaulted || load.Value.IsCanceled));
    }
}
