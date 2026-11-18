using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.HeraTv.Collections;

/// <summary>
/// The curated lists compiled into the plugin (Collections/Data/*.json): awards, universes and
/// the hand-picked seasonal films. Each is a snapshot taken from a public source and dated, so a
/// list is only as fresh as the release that carries it; the Data folder's README says how each was
/// made and how to refresh it.
/// </summary>
internal sealed class Snapshots
{
    private const string Prefix = "collection-";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private static readonly HashSet<string> NoKeys = [];

    private readonly IReadOnlyDictionary<string, Snapshot> _byId;

    public Snapshots(ILogger<Snapshots> logger)
    {
        var byId = new Dictionary<string, Snapshot>(StringComparer.Ordinal);
        var assembly = typeof(Snapshots).Assembly;
        foreach (var resource in assembly.GetManifestResourceNames().Where(n => n.StartsWith(Prefix, StringComparison.Ordinal) && n.EndsWith(".json", StringComparison.Ordinal)))
        {
            try
            {
                using var stream = assembly.GetManifestResourceStream(resource)!;
                var document = JsonSerializer.Deserialize<Document>(stream, Json);
                if (document is null || string.IsNullOrWhiteSpace(document.Id) || string.IsNullOrWhiteSpace(document.Name) || !Enum.TryParse<CollectionGroup>(document.Group, true, out var group))
                {
                    logger.LogWarning("Hera TV: the snapshot {Resource} is not a collection definition; skipped", resource);
                    continue;
                }

                var keys = new HashSet<string>(StringComparer.Ordinal);
                foreach (var entry in document.Items ?? [])
                {
                    keys.Add(Keys.Of(entry.Type ?? "movie", entry.Tmdb));
                }

                byId[document.Id] = new Snapshot(document.Id, document.Name, group, document.Source, document.Updated, keys);
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException)
            {
                logger.LogWarning(ex, "Hera TV: the snapshot {Resource} could not be read; skipped", resource);
            }
        }

        _byId = byId;
    }

    /// <summary>Gets every snapshot, in id order.</summary>
    public IEnumerable<Snapshot> All => _byId.Values.OrderBy(s => s.Id, StringComparer.Ordinal);

    /// <summary>Gets the keys (<c>movie:603</c>) of one snapshot, or an empty set when it isn't there.</summary>
    public IReadOnlySet<string> KeysOf(string id) => _byId.TryGetValue(id, out var snapshot) ? snapshot.Keys : NoKeys;

    /// <summary>One curated list.</summary>
    /// <param name="Id">The file's id, which is also the set's slug.</param>
    /// <param name="Name">What the set is called.</param>
    /// <param name="Group">Where it belongs.</param>
    /// <param name="Source">Where the list came from.</param>
    /// <param name="Updated">The month the snapshot was last brought up to date.</param>
    /// <param name="Keys">The titles, as <c>movie:603</c> or <c>tv:1396</c>.</param>
    public sealed record Snapshot(string Id, string Name, CollectionGroup Group, string? Source, string? Updated, IReadOnlySet<string> Keys);

    private sealed class Document
    {
        public string? Id { get; set; }

        public string? Name { get; set; }

        public string? Group { get; set; }

        public string? Source { get; set; }

        public string? Updated { get; set; }

        public List<Entry>? Items { get; set; }
    }

    private sealed class Entry
    {
        public int Tmdb { get; set; }

        public string? Type { get; set; }
    }
}
