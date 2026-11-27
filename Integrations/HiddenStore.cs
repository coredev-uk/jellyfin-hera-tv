using System.Globalization;
using System.Text.Json;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>One title a person hid, as saved.</summary>
public sealed class HiddenTitle
{
    public string Scope { get; set; } = string.Empty;

    public string Key { get; set; } = string.Empty;

    public string Title { get; set; } = string.Empty;

    public string? Year { get; set; }

    public string? Kind { get; set; }

    public string? Image { get; set; }

    public List<string> Aliases { get; set; } = [];

    public DateTime At { get; set; }
}

/// <summary>
/// Hidden titles, one JSON file per user in the plugin's own data folder. "upnext" removes a
/// series or film from Up Next until it is watched again; "interest" keeps it out of every
/// suggestion row.
/// </summary>
/// <remarks>
/// A file that can't be read is never replaced unseen: it is copied to <c>*.bad</c> beside it before
/// the list starts again, so a person's list is recoverable by hand, and the fault is reported once.
/// </remarks>
public sealed class HiddenStore(ServerHealth health)
{
    public const string UpNext = "upnext";
    public const string Interest = "interest";

    private const int Limit = 500;
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    private readonly Lock gate = new();

    // Each user's list after its first read. Lists are replaced whole, never edited in place, so a
    // list handed out stays valid for whoever holds it; the file is only read once per user per process.
    private readonly Dictionary<Guid, IReadOnlyList<HiddenTitle>> lists = [];

    public IReadOnlyList<HiddenTitle> Read(Guid user)
    {
        lock (gate)
        {
            return Held(user);
        }
    }

    public IReadOnlyList<HiddenTitle> Add(Guid user, HiddenTitle entry)
    {
        lock (gate)
        {
            var list = Held(user).Where(t => t.Scope != entry.Scope || t.Key != entry.Key).ToList();
            list.Add(entry);
            if (list.Count > Limit)
            {
                list = [.. list.OrderByDescending(t => t.At).Take(Limit)];
            }

            // Saved before it is kept, so a write that fails leaves memory agreeing with the file.
            Save(user, list);
            return lists[user] = list;
        }
    }

    public IReadOnlyList<HiddenTitle> Remove(Guid user, string scope, string key)
    {
        lock (gate)
        {
            var current = Held(user);
            var list = current.Where(t => t.Scope != scope || (t.Key != key && !t.Aliases.Contains(key))).ToList();
            if (list.Count == current.Count)
            {
                return current;
            }

            Save(user, list);
            return lists[user] = list;
        }
    }

    private static string FileOf(Guid user)
    {
        var folder = Path.Combine(Plugin.Instance?.DataFolderPath ?? throw new InvalidOperationException("The plugin is not loaded."), "hidden");
        Directory.CreateDirectory(folder);
        return Path.Combine(folder, user.ToString("N", CultureInfo.InvariantCulture) + ".json");
    }

    private static void Save(Guid user, List<HiddenTitle> list)
    {
        var file = FileOf(user);
        var temporary = file + ".tmp";
        File.WriteAllText(temporary, JsonSerializer.Serialize(list, Json));
        File.Move(temporary, file, overwrite: true);
    }

    private IReadOnlyList<HiddenTitle> Held(Guid user)
    {
        if (!lists.TryGetValue(user, out var list))
        {
            lists[user] = list = Load(user);
        }

        return list;
    }

    private List<HiddenTitle> Load(Guid user)
    {
        var file = FileOf(user);
        if (!File.Exists(file))
        {
            return [];
        }

        try
        {
            var list = JsonSerializer.Deserialize<List<HiddenTitle>>(File.ReadAllText(file), Json) ?? [];
            health.Recovered("Hidden titles");
            return list;
        }
        catch (JsonException ex)
        {
            // The list starts again, and the next save replaces the file: keep what was there first.
            var kept = DamagedFiles.Keep(file);
            health.Fault("Hidden titles", $"read a hidden-titles list ({DamagedFiles.Describe(kept)}); that person's list starts again empty", ex);
            return [];
        }
    }
}
