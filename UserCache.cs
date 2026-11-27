namespace Jellyfin.Plugin.HeraTv;

/// <summary>
/// Keeps one built value per person for a while, and builds it once however many callers ask at the
/// same moment: the rest wait for the first build rather than repeating it.
/// </summary>
/// <remarks>
/// A build that throws is forgotten, so the next caller tries again instead of being handed the same
/// failure for the whole lifetime. The keys are people (or one fixed key), so the bound is only a guard.
/// </remarks>
/// <typeparam name="T">What is built.</typeparam>
internal sealed class UserCache<T>(TimeSpan lifetime)
    where T : class
{
    private const int MaxPeople = 1000;

    private readonly AsyncTtlCache<Guid, T> cache = new(MaxPeople);

    /// <summary>Gets the value for <paramref name="key"/>, running <paramref name="build"/> only when there isn't a live one.</summary>
    public T Get(Guid key, Func<T> build) => cache.Get(key, lifetime, build);

    /// <summary>Forgets everything built, so the next read builds again.</summary>
    public void Clear() => cache.Clear();
}
