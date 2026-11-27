using System.Collections.Concurrent;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>Keeps a cache that is keyed by anything a person can type from growing without bound, and without wiping what is still good.</summary>
internal static class CachePruning
{
    /// <summary>
    /// When <paramref name="cache"/> holds more than <paramref name="limit"/> entries, drops the expired
    /// ones and then, if that isn't enough, those closest to expiring, down to nine tenths of the
    /// limit so the next insert doesn't prune again. <paramref name="keep"/> (the entry just written)
    /// is never dropped.
    /// </summary>
    /// <param name="cache">The cache to trim.</param>
    /// <param name="limit">The most entries it should hold.</param>
    /// <param name="expiresAt">When an entry stops being served, as <see cref="DateTime.UtcNow"/> time.</param>
    /// <param name="keep">A key that must survive.</param>
    /// <typeparam name="TKey">The key type.</typeparam>
    /// <typeparam name="TValue">The entry type.</typeparam>
    public static void Prune<TKey, TValue>(ConcurrentDictionary<TKey, TValue> cache, int limit, Func<TValue, DateTime> expiresAt, TKey keep)
        where TKey : notnull
    {
        if (cache.Count <= limit)
        {
            return;
        }

        var now = DateTime.UtcNow;
        foreach (var pair in cache)
        {
            if (expiresAt(pair.Value) <= now && !EqualityComparer<TKey>.Default.Equals(pair.Key, keep))
            {
                cache.TryRemove(pair);
            }
        }

        var excess = cache.Count - (limit - limit / 10);
        if (excess <= 0)
        {
            return;
        }

        foreach (var pair in cache.OrderBy(p => expiresAt(p.Value)).Take(excess + 1).ToList())
        {
            if (!EqualityComparer<TKey>.Default.Equals(pair.Key, keep))
            {
                cache.TryRemove(pair);
            }
        }
    }
}
