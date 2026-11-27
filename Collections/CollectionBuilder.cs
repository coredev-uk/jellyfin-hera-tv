using System.Diagnostics;
using Jellyfin.Data.Enums;
using Jellyfin.Plugin.HeraTv.Integrations;
using MediaBrowser.Controller.Collections;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Library;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.HeraTv.Collections;

/// <summary>What one build did.</summary>
/// <param name="At">When it finished.</param>
/// <param name="Created">Sets made.</param>
/// <param name="Updated">Sets whose members, name or art changed.</param>
/// <param name="Removed">Sets deleted: below their minimum, out of season, switched off or no longer defined.</param>
/// <param name="Unchanged">Sets that were already right.</param>
/// <param name="Failed">Sets that couldn't be built; the rest carried on.</param>
/// <param name="Seconds">How long it took.</param>
/// <param name="Note">What the run did about something unusual: why nothing was done, removals it held back, or why it stopped early.</param>
public sealed record BuildSummary(DateTimeOffset At, int Created, int Updated, int Removed, int Unchanged, int Failed, double Seconds, string? Note);

/// <summary>Whether a build is running, and how the last one went.</summary>
public sealed record BuildStatus(bool Running, BuildSummary? Last);

/// <summary>Builds and reconciles Hera's BoxSets; the scheduled task's whole job.</summary>
public interface ICollectionBuilder
{
    BuildStatus Status { get; }

    Task<BuildSummary> RunAsync(IProgress<double> progress, CancellationToken cancellationToken);
}

/// <summary>
/// Makes real Jellyfin collections (BoxSets) out of <see cref="Catalogue"/>'s definitions, so
/// Swiftfin and Android TV, which know nothing of Hera's web client, see them too.
/// </summary>
/// <remarks>
/// <para>
/// Hera's sets are the BoxSets tagged <c>hera-tv</c>, and only those. A BoxSet without the tag
/// (one the person made, or one from the TMDb Box Sets plugin) is never read as ours, changed or
/// deleted. Each set also carries <c>hera-tv:&lt;definition id&gt;</c>, which is how a later run finds
/// the set a definition built.
/// </para>
/// <para>
/// A run is idempotent: it computes what should exist, then makes the library match, adding and
/// removing members as well as sets. One definition failing is logged and counted; the others go on.
/// </para>
/// </remarks>
internal sealed class CollectionBuilder(
    ILibraryManager libraryManager,
    ICollectionManager collectionManager,
    Catalogue catalogue,
    StreamingCache streaming,
    ICollectionsView view,
    ILogger<CollectionBuilder> logger,
    ServerHealth health) : ICollectionBuilder
{
    /// <summary>The tag every set Hera builds carries.</summary>
    public const string HeraTag = "hera-tv";

    private const string Feature = "Collections build";

    /// <summary>The most sets that no longer qualify that one run removes, at the very least; see <see cref="RemovalShare"/>.</summary>
    private const int MinRemovalLimit = 5;

    /// <summary>
    /// The share of Hera's sets one run may remove when they only stopped qualifying (too few titles, or no
    /// longer in the data at all). A change in what Seerr sends or what the library returns can make dozens
    /// stop qualifying at once; a real change in the library moves a few at a time. More than this is held
    /// back unless the library itself shrank by about as much.
    /// </summary>
    private const double RemovalShare = 0.2;

    /// <summary>The prefix of the tag that names the definition a set was built from.</summary>
    public const string IdTagPrefix = "hera-tv:";

    private readonly Lock _gate = new();
    private BuildSummary? _last;
    private bool _running;

    // How many films and series the last build saw; not kept across a restart, so the first build after one is cautious.
    private int? _lastPool;

    public BuildStatus Status
    {
        get
        {
            lock (_gate)
            {
                return new BuildStatus(_running, _last);
            }
        }
    }

    /// <summary>Gets a value indicating whether a BoxSet is one of Hera's.</summary>
    public static bool IsHera(BaseItem item) => item.Tags.Contains(HeraTag, StringComparer.Ordinal);

    /// <summary>Gets the definition id a Hera set was built from, or null.</summary>
    public static string? DefinitionId(BaseItem item)
        => item.Tags.FirstOrDefault(t => t.StartsWith(IdTagPrefix, StringComparison.Ordinal))?[IdTagPrefix.Length..];

    public async Task<BuildSummary> RunAsync(IProgress<double> progress, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            _running = true;
        }

        var clock = Stopwatch.StartNew();
        try
        {
            var summary = await ReconcileAsync(progress, clock, cancellationToken).ConfigureAwait(false);
            lock (_gate)
            {
                _last = summary;
            }

            return summary;
        }
        finally
        {
            lock (_gate)
            {
                _running = false;
            }

            view.Clear();
        }
    }

    private async Task<BuildSummary> ReconcileAsync(IProgress<double> progress, Stopwatch clock, CancellationToken ct)
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var existing = libraryManager.GetItemList(new InternalItemsQuery { IncludeItemTypes = [BaseItemKind.BoxSet], Recursive = true })
            .OfType<BoxSet>()
            .Where(IsHera)
            .ToList();

        var wanted = new List<(Definition Definition, List<Title> Members)>();
        var poolSize = 0;
        if (config.CollectionsEnabled)
        {
            // Streaming data is fetched here, once a day, so the home rows read a file instead of calling Seerr.
            // If Seerr is down the last file is used.
            await streaming.RefreshAsync(ct).ConfigureAwait(false);

            var pool = Title.From(libraryManager.GetItemList(new InternalItemsQuery
            {
                IncludeItemTypes = [BaseItemKind.Movie, BaseItemKind.Series],
                Recursive = true,
                IsVirtualItem = false,
            }));
            poolSize = pool.Count;
            if (pool.Count == 0 && existing.Count > 0)
            {
                // A library mid-scan can answer with nothing; reconciling against that would delete every set.
                logger.LogWarning("Hera TV collections: the library returned no films or series, so the {Count} existing sets were left alone", existing.Count);
                return Summarise(0, 0, 0, existing.Count, 0, clock, "The library returned nothing, so nothing was changed.");
            }

            var today = DateOnly.FromDateTime(Stats.Clock.Today);
            foreach (var definition in catalogue.Build(pool, streaming.Current))
            {
                if (!definition.Group.Enabled(config) || !definition.InSeason(today))
                {
                    continue;
                }

                var members = definition.Members(pool);
                if (members.Count >= definition.Min)
                {
                    wanted.Add((definition, members));
                }
            }
        }

        var byId = new Dictionary<string, BoxSet>(StringComparer.Ordinal);
        var stale = new List<BoxSet>();
        foreach (var set in existing)
        {
            var id = DefinitionId(set);
            if (id is null || !byId.TryAdd(id, set))
            {
                stale.Add(set); // A set with no definition, or a second one for the same definition.
            }
        }

        // Art is chosen for every set up front, in sort-name order (the order native apps list them in), so
        // a set that fails to build can't change what the others get. Without this every set holding the
        // library's best-rated title would wear its poster.
        wanted.Sort((a, b) => string.CompareOrdinal(CollectionGroups.SortName(a.Definition.Group, a.Definition.Name), CollectionGroups.SortName(b.Definition.Group, b.Definition.Name)));
        var picker = new ArtPicker();
        var art = new Dictionary<string, Art>(StringComparer.Ordinal);
        foreach (var (definition, members) in wanted)
        {
            var items = members.Select(m => m.Item).ToList();
            art[definition.Id] = new Art(picker.Pick(items, ImageType.Primary), picker.Pick(items, ImageType.Backdrop));
        }

        int created = 0, updated = 0, unchanged = 0, removed = 0, failed = 0;
        var done = 0;
        foreach (var (definition, members) in wanted)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                if (byId.Remove(definition.Id, out var set))
                {
                    if (await UpdateAsync(set, definition, members, art[definition.Id], ct).ConfigureAwait(false))
                    {
                        updated++;
                    }
                    else
                    {
                        unchanged++;
                    }
                }
                else
                {
                    await CreateAsync(definition, members, art[definition.Id], ct).ConfigureAwait(false);
                    created++;
                }
            }
            catch (TagNotPersistedException ex)
            {
                // Every further set would be made untagged too, and the next run would make them all again.
                logger.LogError(ex, "Hera TV collections: the build stopped because Jellyfin didn't keep the tag on a set it made");
                health.Fault(Feature, "build collections: Jellyfin didn't keep the tag on a set Hera made, so the build stopped before making any more", ex);
                failed++;
                progress.Report(100);
                return Summarise(created, updated, 0, unchanged, failed, clock, ex.Message);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                failed++;
                logger.LogWarning(ex, "Hera TV collections: building {Id} failed", definition.Id);
            }

            progress.Report(90.0 * ++done / Math.Max(wanted.Count, 1));
        }

        // Whatever is left was built before and is no longer wanted.
        var (doomed, heldBack, limit) = LimitRemovals([.. byId.Values.Concat(stale)], stale, config, existing.Count, poolSize);
        foreach (var set in doomed)
        {
            ct.ThrowIfCancellationRequested();
            try
            {
                libraryManager.DeleteItem(set, new DeleteOptions { DeleteFileLocation = true });
                removed++;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                failed++;
                logger.LogWarning(ex, "Hera TV collections: removing {Name} failed", set.Name);
            }
        }

        string? note = null;
        if (heldBack > 0)
        {
            note = string.Create(
                System.Globalization.CultureInfo.InvariantCulture,
                $"{heldBack} sets that no longer qualify were left in place: more than {limit} at once looks like a change in what Seerr or the library returns, and the library didn't shrink to match. They are looked at again next run.");
            logger.LogWarning("Hera TV collections: {Note}", note);
            health.Fault(Feature, "remove every set that no longer qualifies: " + note);
        }
        else
        {
            health.Recovered(Feature);
        }

        if (config.CollectionsEnabled)
        {
            _lastPool = poolSize;
        }

        progress.Report(100);
        return Summarise(created, updated, removed, unchanged, failed, clock, note);
    }

    /// <summary>
    /// Works out which of the sets to remove may go this run. Sets the administrator's own choices end (collections
    /// or the group switched off, a season out of season, a set no longer built by anyone) always go. Those that only
    /// stopped qualifying are limited to <see cref="RemovalShare"/> of Hera's sets, and at least
    /// <see cref="MinRemovalLimit"/>, unless the library shrank by that share since the last build: the rest wait for the next run.
    /// </summary>
    private (List<BoxSet> Remove, int HeldBack, int Limit) LimitRemovals(List<BoxSet> all, List<BoxSet> stale, PluginConfiguration config, int existing, int poolSize)
    {
        var limit = Math.Max(MinRemovalLimit, (int)Math.Ceiling(existing * RemovalShare));
        var intentional = all.Where(set => stale.Contains(set) || Chosen(set, config)).ToList();
        var lapsed = all.Except(intentional).OrderBy(set => set.Name, StringComparer.Ordinal).ToList();
        var poolShrank = _lastPool is int last && poolSize * 5 <= last * 4;
        if (lapsed.Count <= limit || poolShrank)
        {
            return (all, 0, limit);
        }

        return ([.. intentional, .. lapsed.Take(limit)], lapsed.Count - limit, limit);
    }

    /// <summary>Gets whether a set goes because of a choice (everything off, its group off, seasonal) rather than because its data stopped qualifying.</summary>
    private static bool Chosen(BoxSet set, PluginConfiguration config)
    {
        var id = DefinitionId(set);
        var prefix = id?.Split(':')[0];
        return !config.CollectionsEnabled
            || !CollectionGroups.TryParse(prefix, out var group)
            || !group.Builds()
            || !group.Enabled(config)
            || group == CollectionGroup.Seasonal;
    }

    private BuildSummary Summarise(int created, int updated, int removed, int unchanged, int failed, Stopwatch clock, string? note)
    {
        var summary = new BuildSummary(DateTimeOffset.UtcNow, created, updated, removed, unchanged, failed, Math.Round(clock.Elapsed.TotalSeconds, 1), note);
        logger.LogInformation(
            "Hera TV collections: {Created} created, {Updated} updated, {Removed} removed, {Unchanged} unchanged, {Failed} failed in {Seconds}s",
            created,
            updated,
            removed,
            unchanged,
            failed,
            summary.Seconds);
        return summary;
    }

    private async Task CreateAsync(Definition definition, List<Title> members, Art art, CancellationToken ct)
    {
        // Locked, so the metadata refresh a new collection triggers can't rename it after a
        // look-alike on TMDB: the TMDb Box Sets plugin's provider searches by name when a BoxSet has no
        // TMDB id, and "Comedy" or "Christmas" would find something. Locking limits a refresh to local sources.
        var set = await collectionManager.CreateCollectionAsync(new CollectionCreationOptions
        {
            Name = definition.Name,
            IsLocked = true,
            ItemIdList = [],
            UserIds = [],
        }).ConfigureAwait(false);

        // Tagged before members go in, so a run that dies in between leaves a set the next run recognises as ours.
        Describe(set, definition);
        await set.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, ct).ConfigureAwait(false);
        VerifyTagged(set, definition);

        await collectionManager.AddToCollectionAsync(set.Id, members.Select(m => m.Id)).ConfigureAwait(false);

        // Adding members saves the set and queues a refresh; read it again so the art goes on the current copy.
        var current = libraryManager.GetItemById<BoxSet>(set.Id) ?? set;
        if (SetArt(current, art))
        {
            await current.UpdateToRepositoryAsync(ItemUpdateType.ImageUpdate, ct).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Reads a set Hera just made back the way the next run will find it (a query for BoxSets, kept if tagged) and
    /// checks its tags. Hera knows its sets only by those tags; if Jellyfin didn't keep or return them, every run
    /// would make another copy of every set. So the set is removed again (it is empty and ours) and the build stops.
    /// </summary>
    private void VerifyTagged(BoxSet set, Definition definition)
    {
        var stored = libraryManager.GetItemList(new InternalItemsQuery { IncludeItemTypes = [BaseItemKind.BoxSet], Recursive = true, ItemIds = [set.Id] })
            .OfType<BoxSet>()
            .FirstOrDefault();
        if (stored is not null && IsHera(stored) && string.Equals(DefinitionId(stored), definition.Id, StringComparison.Ordinal))
        {
            return;
        }

        try
        {
            libraryManager.DeleteItem(set, new DeleteOptions { DeleteFileLocation = true });
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Hera TV collections: couldn't remove the untagged set {Name} either", set.Name);
        }

        throw new TagNotPersistedException($"Jellyfin didn't keep the tag on the set made for {definition.Id}, so the build stopped before making more. Hera TV can't recognise its own sets without it.");
    }

    /// <summary>Makes an existing set match its definition. Returns true when anything changed.</summary>
    private async Task<bool> UpdateAsync(BoxSet set, Definition definition, List<Title> members, Art art, CancellationToken ct)
    {
        var changed = false;
        if (Describe(set, definition))
        {
            await set.UpdateToRepositoryAsync(ItemUpdateType.MetadataEdit, ct).ConfigureAwait(false);
            changed = true;
        }

        var wanted = members.Select(m => m.Id).ToHashSet();
        var have = new HashSet<Guid>();
        foreach (var link in set.LinkedChildren)
        {
            var id = link.ItemId ?? Guid.Empty;
            if (id != Guid.Empty)
            {
                have.Add(id);
            }
        }

        var drop = have.Where(id => !wanted.Contains(id)).ToList();
        var add = wanted.Where(id => !have.Contains(id)).ToList();
        if (drop.Count > 0)
        {
            await collectionManager.RemoveFromCollectionAsync(set.Id, drop).ConfigureAwait(false);
        }

        if (add.Count > 0)
        {
            await collectionManager.AddToCollectionAsync(set.Id, add).ConfigureAwait(false);
        }

        changed |= drop.Count > 0 || add.Count > 0;

        var current = drop.Count > 0 || add.Count > 0 ? libraryManager.GetItemById<BoxSet>(set.Id) ?? set : set;
        if (SetArt(current, art))
        {
            await current.UpdateToRepositoryAsync(ItemUpdateType.ImageUpdate, ct).ConfigureAwait(false);
            changed = true;
        }

        return changed;
    }

    /// <summary>Sets the name, tags, sort name and overview the definition calls for. Returns true when any differed.</summary>
    private static bool Describe(BoxSet set, Definition definition)
    {
        var changed = false;
        if (!string.Equals(set.Name, definition.Name, StringComparison.Ordinal))
        {
            set.Name = definition.Name;
            changed = true;
        }

        // "~NN Group Name": the tilde sorts after letters and digits, so native apps list Hera's sets
        // after the person's own, and the number keeps the groups in browse order.
        var sortName = CollectionGroups.SortName(definition.Group, definition.Name);
        if (!string.Equals(set.ForcedSortName, sortName, StringComparison.Ordinal))
        {
            set.ForcedSortName = sortName;
            changed = true;
        }

        if (definition.Summary is not null && !string.Equals(set.Overview, definition.Summary, StringComparison.Ordinal))
        {
            set.Overview = definition.Summary;
            changed = true;
        }

        var idTag = IdTagPrefix + definition.Id;
        if (!set.Tags.Contains(HeraTag, StringComparer.Ordinal) || !set.Tags.Contains(idTag, StringComparer.Ordinal))
        {
            // Keep any tags a person added; only Hera's own are ours to set.
            set.Tags = [.. set.Tags.Where(t => t != HeraTag && !t.StartsWith(IdTagPrefix, StringComparison.Ordinal)), HeraTag, idTag];
            changed = true;
        }

        return changed;
    }

    /// <summary>
    /// Gives the set its poster and backdrop: the members <see cref="ArtPicker"/> chose for it, which
    /// are its best-rated that no earlier set in the run already uses. Never the logo, which would
    /// label the set with one title's name. Returns true when an image changed.
    /// </summary>
    /// <remarks>
    /// The set points at the member's own image through Jellyfin's own <see cref="BaseItem.SetImage"/>,
    /// as an <see cref="ItemImageInfo"/> with the member's path. Copying the file into the set's folder
    /// instead would need write access to the data directory, leave a second copy to go stale when the
    /// member's art changes, and need cleaning up when the set is deleted. A path costs nothing, Jellyfin
    /// serves, resizes and caches it like any other image, and the next run notices a changed path or
    /// modified time and re-points the set. The cost is that art which a person set by hand on one of
    /// Hera's sets is replaced.
    /// </remarks>
    private static bool SetArt(BoxSet set, Art art)
    {
        var changed = false;
        foreach (var (type, member) in new[] { (ImageType.Primary, art.Primary), (ImageType.Backdrop, art.Backdrop) })
        {
            var source = member?.GetImageInfo(type, 0);
            if (source is null)
            {
                continue;
            }

            var current = set.GetImageInfo(type, 0);
            if (current is not null && current.Path == source.Path && current.DateModified == source.DateModified)
            {
                continue;
            }

            set.SetImage(
                new ItemImageInfo
                {
                    Path = source.Path,
                    Type = type,
                    DateModified = source.DateModified,
                    Width = source.Width,
                    Height = source.Height,
                    BlurHash = source.BlurHash,
                },
                0);
            changed = true;
        }

        return changed;
    }

    /// <summary>The members whose poster and backdrop stand for one set.</summary>
    private readonly record struct Art(BaseItem? Primary, BaseItem? Backdrop);
}

/// <summary>A set Hera made didn't come back from Jellyfin carrying its tag; the build can't go on, or it would make every set again next run.</summary>
internal sealed class TagNotPersistedException(string message) : Exception(message);
