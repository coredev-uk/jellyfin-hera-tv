namespace Jellyfin.Plugin.HeraTv.Notifications;

/// <summary>The three things a notice can be about; <c>kind</c> in the endpoint's JSON.</summary>
public static class NoticeKind
{
    public const string Request = "request";
    public const string Episode = "episode";
    public const string Arrivals = "arrivals";
}

/// <summary>One library item a notice names, as the bell lists it.</summary>
public sealed record NoticeItem(string Id, string Name, string Type);

/// <summary>A notice ready to be written for one user.</summary>
/// <param name="Kind">One of <see cref="NoticeKind"/>.</param>
/// <param name="DedupeKey">Unique per user: writing the same key again is the same notice, never a second one.</param>
/// <param name="ItemId">The library item that opening the notice goes to, or null.</param>
/// <param name="ImageId">The library item whose artwork the notice shows, or null.</param>
/// <param name="Url">A client route to open when there is no item, or null.</param>
/// <param name="Items">The titles an arrivals summary lists; null for the other kinds.</param>
/// <param name="RefIds">Library item ids this notice announces, which the client marks "New" until it is read.</param>
/// <param name="Data">What the producer needs to fold a later arrival into this notice; never sent to the client.</param>
public sealed record NoticeDraft(
    string Kind,
    string DedupeKey,
    string Title,
    string? Body,
    string? ItemId,
    string? ImageId,
    string? Url,
    IReadOnlyList<NoticeItem>? Items,
    IReadOnlyList<string> RefIds,
    string? Data = null);

/// <summary>A stored notice, as <c>GET /HeraTV/notifications</c> lists it.</summary>
/// <param name="CreatedAt">UTC, <c>yyyy-MM-ddTHH:mm:ssZ</c>.</param>
public sealed record Notice(
    long Id,
    string Kind,
    string Title,
    string? Body,
    string? ItemId,
    string? ImageId,
    string? Url,
    IReadOnlyList<NoticeItem>? Items,
    string CreatedAt,
    bool Read);

/// <summary>A user's notices, newest first, and what the unread ones announce.</summary>
public sealed record Listing(int Unread, IReadOnlyList<Notice> Notices, IReadOnlyList<string> NewItems);

/// <summary>Which kinds of notice a user wants. Everything is on until they say otherwise.</summary>
public sealed record NoticePrefs(bool Requests, bool Episodes, bool Arrivals)
{
    public static NoticePrefs Default { get; } = new(true, true, true);
}

/// <summary>Where a request stood the last time it was looked at.</summary>
public sealed record RequestState(string State, string? RequestedAt);
