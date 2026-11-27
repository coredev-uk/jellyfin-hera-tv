using System.Globalization;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// Seerr as an extension of the library: a person's whole filmography, what to watch or request
/// next to a title, and a collection's missing films. Reads run as the signed-in Jellyfin user, so
/// library matches follow their access; requests are made as their linked Seerr account.
/// </summary>
[ApiController]
[Authorize]
[Route("HeraTV")]
public partial class SeerrExtensionController(
    UpstreamClient upstream,
    LibraryLookup library,
    ILibraryManager libraryManager,
    IUserManager userManager) : ControllerBase
{
    private const int RelatedLimit = 30;

    // A person's shelf shows this many cards before "Show all" (the client draws the same number) and
    // never more than ShelfMax after it.
    private const int ShelfFirst = 40;
    private const int ShelfMax = 80;

    private static readonly Dictionary<string, string> PrimaryKinds = new(StringComparer.Ordinal)
    {
        ["Acting"] = "acting",
        ["Directing"] = "directed",
        ["Writing"] = "written",
        ["Production"] = "produced",
        ["Sound"] = "composed",
        ["Creator"] = "created",
    };

    // What a person is known for decides which shelves lead. An actor's producer credits are noise;
    // for a producer they are the point.
    private static readonly Dictionary<string, string[]> SectionOrder = new(StringComparer.Ordinal)
    {
        ["acting"] = ["films", "tv", "directed", "created", "written"],
        ["directed"] = ["directed", "created", "written", "produced", "acting"],
        ["created"] = ["created", "directed", "written", "produced", "acting"],
        ["written"] = ["written", "created", "directed", "produced", "acting"],
        ["produced"] = ["produced", "directed", "created", "written", "acting"],
        ["composed"] = ["composed", "acting"],
    };

    private static readonly Dictionary<string, string> SectionTitles = new(StringComparer.Ordinal)
    {
        ["films"] = "Films",
        ["tv"] = "TV Shows",
        ["acting"] = "Acting",
        ["directed"] = "Directed",
        ["created"] = "Created",
        ["written"] = "Written",
        ["produced"] = "Produced",
        ["composed"] = "Composed",
        ["appearances"] = "Appearances",
    };

    // Crew jobs worth a shelf of their own; everything else (grips, gaffers, thanks) is left out.
    private static readonly Dictionary<string, string> JobKinds = new(StringComparer.Ordinal)
    {
        ["Director"] = "directed",
        ["Co-Director"] = "directed",
        ["Creator"] = "created",
        ["Writer"] = "written",
        ["Screenplay"] = "written",
        ["Story"] = "written",
        ["Teleplay"] = "written",
        ["Novel"] = "written",
        ["Original Story"] = "written",
        ["Producer"] = "produced",
        ["Executive Producer"] = "produced",
        ["Original Music Composer"] = "composed",
        ["Composer"] = "composed",
    };

    private static readonly (string Kind, string Label)[] KindLabels =
    [
        ("directed", "Director"),
        ("created", "Creator"),
        ("written", "Writer"),
        ("produced", "Producer"),
        ("composed", "Composer"),
    ];

    // Credits that are the person turning up as themselves: talk shows, archive footage, award nights.
    [GeneratedRegex(@"^\s*(self|himself|herself|themselves|archive footage)\b|archive footage", RegexOptions.IgnoreCase)]
    private static partial Regex SelfRole();

    /// <summary>A person: who they are and everything TMDB credits them with, as the viewer's library and Seerr see it.</summary>
    [HttpGet("discover/person/{tmdbId:int}")]
    public async Task<IActionResult> GetPerson([FromRoute] int tmdbId)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        if (!IntegrationSettings.Current.SeerrEnabled)
        {
            return NotFound();
        }

        var personTask = upstream.SeerrGetAsync($"api/v1/person/{tmdbId}?language=en", TimeSpan.FromMinutes(30));
        var creditsTask = upstream.SeerrGetAsync($"api/v1/person/{tmdbId}/combined_credits?language=en", TimeSpan.FromMinutes(10));
        var person = await personTask.ConfigureAwait(false);
        if (person is null)
        {
            return NotFound();
        }

        var credits = await creditsTask.ConfigureAwait(false);
        var knownFor = (string?)person["knownForDepartment"];
        var films = BuildFilmography(knownFor, credits, user);
        return Ok(new
        {
            tmdbId,
            name = (string?)person["name"],
            role = RoleOf(knownFor),
            biography = (string?)person["biography"],
            birthday = (string?)person["birthday"],
            deathday = (string?)person["deathday"],
            placeOfBirth = (string?)person["placeOfBirth"],
            profile = SeerrMapper.Image((string?)person["profilePath"], "w342"),
            jellyfinId = FindPerson(tmdbId),
            library = films.Library.Select(HeldJson),
            shelves = films.Shelves.Select(s => new
            {
                id = s.Id,
                title = s.Title,
                total = Math.Min(s.Entries.Count, ShelfMax),
                items = Window(s.Entries, ShelfFirst).Select(CardJson),
            }),
        });
    }

    /// <summary>
    /// Everything a shelf of a person's page can show after "Show all": the first view carries only the
    /// top of each shelf, this carries the rest of what the page will ever draw for it.
    /// </summary>
    [HttpGet("discover/person/{tmdbId:int}/shelf/{shelf}")]
    public async Task<IActionResult> GetPersonShelf([FromRoute] int tmdbId, [FromRoute] string shelf)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        if (!IntegrationSettings.Current.SeerrEnabled)
        {
            return NotFound();
        }

        var personTask = upstream.SeerrGetAsync($"api/v1/person/{tmdbId}?language=en", TimeSpan.FromMinutes(30));
        var creditsTask = upstream.SeerrGetAsync($"api/v1/person/{tmdbId}/combined_credits?language=en", TimeSpan.FromMinutes(10));
        var person = await personTask.ConfigureAwait(false);
        if (person is null)
        {
            return NotFound();
        }

        var credits = await creditsTask.ConfigureAwait(false);
        var found = BuildFilmography((string?)person["knownForDepartment"], credits, user).Shelves.FirstOrDefault(s => s.Id == shelf);
        return found is null ? NotFound() : Ok(new { items = Window(found.Entries, ShelfMax).Select(CardJson) });
    }

    /// <summary>Recommendations, then similar titles, for the film or show a page is about.</summary>
    [HttpGet("discover/titles/{mediaType}/{tmdbId:int}/related")]
    public async Task<IActionResult> GetRelated([FromRoute] string mediaType, [FromRoute] int tmdbId)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        if (!IntegrationSettings.Current.SeerrEnabled)
        {
            return NotFound();
        }

        var type = mediaType == "tv" ? "tv" : "movie";
        var recommendedTask = upstream.SeerrGetAsync($"api/v1/{type}/{tmdbId}/recommendations?language=en", TimeSpan.FromMinutes(30));
        var similarTask = upstream.SeerrGetAsync($"api/v1/{type}/{tmdbId}/similar?language=en", TimeSpan.FromMinutes(30));
        var recommended = await recommendedTask.ConfigureAwait(false);
        var similar = await similarTask.ConfigureAwait(false);

        // TMDB's "similar" is keyword matching and noisy; only well-known titles are worth showing from it.
        var candidates = (recommended?["results"]?.AsArray() ?? [])
            .Concat((similar?["results"]?.AsArray() ?? []).Where(r => (r?["voteCount"]?.GetValue<int?>() ?? 0) >= 200));
        var seen = new HashSet<int> { tmdbId };
        var results = new List<object>();
        foreach (var node in candidates)
        {
            var id = node?["id"]?.GetValue<int?>();
            if (node is null || id is null || string.IsNullOrEmpty((string?)node["posterPath"]) || !seen.Add(id.Value))
            {
                continue;
            }

            results.Add(SeerrMapper.Item(node, user, library));
            if (results.Count >= RelatedLimit)
            {
                break;
            }
        }

        return Ok(new { results });
    }

    /// <summary>A TMDB collection: its films with the viewer's library and Seerr state, and which of them can be requested.</summary>
    [HttpGet("discover/collections/{id:int}")]
    public async Task<IActionResult> GetCollection([FromRoute] int id)
    {
        var user = CurrentUser();
        if (user is null)
        {
            return Unauthorized();
        }

        if (!IntegrationSettings.Current.SeerrEnabled)
        {
            return NotFound();
        }

        var node = await upstream.SeerrGetAsync($"api/v1/collection/{id}?language=en", TimeSpan.FromMinutes(10)).ConfigureAwait(false);
        if (node is null)
        {
            return NotFound();
        }

        var parts = Parts(node);
        return Ok(new
        {
            id,
            name = (string?)node["name"],
            overview = (string?)node["overview"],
            poster = SeerrMapper.Image((string?)node["posterPath"], "w342"),
            backdrop = SeerrMapper.Image((string?)node["backdropPath"], "w1280"),
            parts = parts.Select(p => SeerrMapper.Item(p, user, library)).ToArray(),
            requestable = parts.Where(p => Requestable(p, user)).Select(p => p["id"]!.GetValue<int>()).ToArray(),
        });
    }

    /// <summary>Requests every film of a collection that is released and neither in the library nor already asked for.</summary>
    [HttpPost("discover/collections/{id:int}/request")]
    public async Task<IActionResult> RequestCollection([FromRoute] int id)
    {
        var settings = IntegrationSettings.Current;
        var user = CurrentUser();
        var seerrUser = user is null ? null : settings.SeerrUserFor(user.Username);
        if (user is null || !settings.SeerrEnabled || seerrUser is null)
        {
            return StatusCode(StatusCodes.Status403Forbidden, new { message = "Your account is not linked to Seerr." });
        }

        var node = await upstream.SeerrGetAsync($"api/v1/collection/{id}?language=en", TimeSpan.FromMinutes(10)).ConfigureAwait(false);
        if (node is null)
        {
            return NotFound();
        }

        var requested = 0;
        var failed = 0;
        foreach (var part in Parts(node).Where(p => Requestable(p, user)))
        {
            var payload = new JsonObject
            {
                ["mediaType"] = "movie",
                ["mediaId"] = part["id"]!.GetValue<int>(),
                ["is4k"] = false,
            };
            var (status, _) = await upstream.SeerrPostAsync("api/v1/request", payload, seerrUser.Value).ConfigureAwait(false);
            if (status is >= 200 and < 300)
            {
                requested++;
            }
            else
            {
                failed++;
            }
        }

        return Ok(new { requested, failed });
    }

    private static string? RoleOf(string? department) => department switch
    {
        "Acting" => "Actor",
        "Directing" => "Director",
        "Writing" => "Writer",
        "Production" => "Producer",
        "Sound" => "Composer",
        "Camera" => "Cinematographer",
        "Editing" => "Editor",
        "Creator" => "Creator",
        _ => department,
    };

    private static List<JsonNode> Parts(JsonNode collection)
    {
        var parts = new List<JsonNode>();
        foreach (var part in collection["parts"]?.AsArray() ?? [])
        {
            if (part is not null && part["id"] is not null)
            {
                parts.Add(part);
            }
        }

        // Release order; films with no date yet (announced, untitled) go last.
        return [.. parts.OrderBy(p => string.IsNullOrEmpty((string?)p["releaseDate"])).ThenBy(p => (string?)p["releaseDate"], StringComparer.Ordinal)];
    }

    private bool Requestable(JsonNode part, User user)
    {
        var released = DateTime.TryParse((string?)part["releaseDate"], CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var date)
            && date <= DateTime.UtcNow;
        return released
            && library.Find(user, "movie", part["id"]?.ToString()) is null
            && SeerrMapper.MediaStatus(part["mediaInfo"]?["status"]?.GetValue<int>() ?? 0) == "none";
    }

    // One entry per title: a person is credited once per role, so the roles gather under it. Most popular first.
    private List<Held> Collect(JsonNode? list, bool crew, User user)
    {
        var byKey = new Dictionary<string, Credit>(StringComparer.Ordinal);
        var ordered = new List<Credit>();
        foreach (var node in list?.AsArray() ?? [])
        {
            var type = (string?)node?["mediaType"];
            var id = node?["id"]?.GetValue<int?>();
            var title = (string?)node?["title"] ?? (string?)node?["name"];
            if (node is null || type is not ("movie" or "tv") || id is null || string.IsNullOrEmpty(title))
            {
                continue;
            }

            var key = $"{type}:{id}";
            if (!byKey.TryGetValue(key, out var credit))
            {
                credit = new Credit(node, type, id.Value, title);
                byKey[key] = credit;
                ordered.Add(credit);
            }

            var role = (string?)node[crew ? "job" : "character"];
            if (!string.IsNullOrWhiteSpace(role) && !credit.Roles.Contains(role))
            {
                credit.Roles.Add(role);
            }

            credit.Episodes = Math.Max(credit.Episodes, node["episodeCount"]?.GetValue<int?>() ?? 0);
        }

        return ordered
            .Select(c => new Held(c, library.Find(user, c.MediaType, c.TmdbId.ToString(CultureInfo.InvariantCulture)), crew))
            // A title with no artwork has nothing to show, unless the library holds it.
            .Where(h => h.Match is not null || !string.IsNullOrEmpty((string?)h.Credit.Node["posterPath"]))
            .OrderByDescending(h => h.Credit.Popularity)
            .ToList();
    }

    // The kinds of work a crew credit stands for, most important first.
    private static List<string> CrewKinds(Credit credit)
        => [.. KindLabels.Where(k => credit.Roles.Any(r => JobKinds.TryGetValue(r, out var kind) && kind == k.Kind)).Select(k => k.Kind)];

    private static string? CrewLabel(Credit credit)
    {
        var labels = CrewKinds(credit).Select(kind => KindLabels.First(k => k.Kind == kind).Label).Take(2).ToList();
        return labels.Count > 0 ? string.Join(" & ", labels) : credit.Roles.FirstOrDefault();
    }

    private static string KindText(Credit credit) => credit.MediaType == "tv" ? "TV Show" : "Film";

    private static string Subtitle(params string?[] parts) => string.Join(" · ", parts.Where(p => !string.IsNullOrEmpty(p)));

    // What a person's page draws: the titles the library holds, then a shelf per kind of credit, each
    // title on the first shelf that has it (a director's films are also the ones they wrote).
    private Filmography BuildFilmography(string? knownFor, JsonNode? credits, User user)
    {
        var cast = Collect(credits?["cast"], crew: false, user);
        var crew = Collect(credits?["crew"], crew: true, user);
        var primary = knownFor is not null && PrimaryKinds.TryGetValue(knownFor, out var primaryKind) ? primaryKind : "acting";

        // On a crew person's page the job they are known for outranks a cameo.
        var held = new List<Entry>();
        var heldKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var h in primary == "acting" ? cast.Concat(crew) : crew.Concat(cast))
        {
            if (h.Match is null || !heldKeys.Add(h.Credit.Key))
            {
                continue;
            }

            var role = h.Crew ? CrewLabel(h.Credit) : h.Credit.Roles.FirstOrDefault();
            held.Add(new Entry(h, Subtitle(string.IsNullOrEmpty(role) ? KindText(h.Credit) : role, SeerrMapper.Year(h.Credit.Date))));
        }

        var rows = new Dictionary<string, List<Entry>>(StringComparer.Ordinal);
        void Put(string section, Held h)
        {
            // Mixed shelves (Directed, Written) hold shows as well as films.
            var crewRow = section is not ("films" or "tv" or "acting" or "appearances");
            var label = crewRow ? CrewLabel(h.Credit) : section == "appearances" ? null : h.Credit.Roles.FirstOrDefault();
            if (!rows.TryGetValue(section, out var row))
            {
                rows[section] = row = [];
            }

            row.Add(new Entry(h, Subtitle(string.IsNullOrEmpty(label) ? KindText(h.Credit) : label, SeerrMapper.Year(h.Credit.Date), crewRow && h.Credit.MediaType == "tv" ? "TV Show" : null)));
        }

        foreach (var h in cast.Where(h => !heldKeys.Contains(h.Credit.Key)))
        {
            Put(h.Credit.IsAppearance() ? "appearances" : primary == "acting" ? (h.Credit.MediaType == "tv" ? "tv" : "films") : "acting", h);
        }

        foreach (var h in crew.Where(h => !heldKeys.Contains(h.Credit.Key)))
        {
            foreach (var kind in CrewKinds(h.Credit))
            {
                Put(kind, h);
            }
        }

        var seen = new HashSet<string>(StringComparer.Ordinal);
        var shelves = new List<Shelf>();
        foreach (var section in SectionOrder[primary].Append("appearances"))
        {
            if (!rows.TryGetValue(section, out var row))
            {
                continue;
            }

            var fresh = row.Where(e => !seen.Contains(e.Held.Credit.Key)).ToList();
            seen.UnionWith(fresh.Select(e => e.Held.Credit.Key));
            if (fresh.Count > 0)
            {
                shelves.Add(new Shelf(section, SectionTitles[section], fresh));
            }
        }

        return new Filmography(held, shelves);
    }

    // The entries a shelf shows sorted either way, `take` of each: Popular is the head of the list,
    // Newest the latest dated. Nothing else on the shelf can be on screen in either order.
    private static List<Entry> Window(List<Entry> entries, int take)
    {
        if (entries.Count <= take)
        {
            return entries;
        }

        var keep = new HashSet<Entry>(entries.Take(take));
        keep.UnionWith(entries.OrderByDescending(e => e.Held.Credit.Date ?? string.Empty, StringComparer.Ordinal).Take(take));
        return [.. entries.Where(keep.Contains)];
    }

    private static object CardJson(Entry e) => new
    {
        tmdbId = e.Held.Credit.TmdbId,
        mediaType = e.Held.Credit.MediaType,
        title = e.Held.Credit.Title,
        year = SeerrMapper.Year(e.Held.Credit.Date),
        releaseDate = e.Held.Credit.Date,
        poster = SeerrMapper.Image((string?)e.Held.Credit.Node["posterPath"], "w342"),
        popularity = e.Held.Credit.Popularity,
        status = SeerrMapper.Status(e.Held.Credit.Node, e.Held.Match),
        jellyfinId = SeerrMapper.JellyfinId(e.Held.Match),
        subtitle = e.Subtitle,
    };

    // The library row draws its own artwork, so its entries carry none of Seerr's.
    private static object HeldJson(Entry e) => new
    {
        tmdbId = e.Held.Credit.TmdbId,
        mediaType = e.Held.Credit.MediaType,
        title = e.Held.Credit.Title,
        year = SeerrMapper.Year(e.Held.Credit.Date),
        releaseDate = e.Held.Credit.Date,
        popularity = e.Held.Credit.Popularity,
        jellyfinId = SeerrMapper.JellyfinId(e.Held.Match),
        subtitle = e.Subtitle,
    };

    // Persons are library items too, found by the TMDB id their metadata carries.
    private string? FindPerson(int tmdbId)
    {
        var found = libraryManager.GetItemList(new InternalItemsQuery
        {
            IncludeItemTypes = [BaseItemKind.Person],
            HasAnyProviderId = new Dictionary<string, string>
            {
                [nameof(MediaBrowser.Model.Entities.MetadataProvider.Tmdb)] = tmdbId.ToString(CultureInfo.InvariantCulture),
            },
            Limit = 1,
        });
        return found.Count > 0 ? found[0].Id.ToString("N", CultureInfo.InvariantCulture) : null;
    }

    private User? CurrentUser()
    {
        var claim = User.FindFirst("Jellyfin-UserId")?.Value;
        return Guid.TryParse(claim, out var id) ? userManager.GetUserById(id) : null;
    }

    // One credit per title; roles are the characters or jobs it is credited under.
    private sealed class Credit(JsonNode node, string mediaType, int tmdbId, string title)
    {
        public JsonNode Node { get; } = node;

        public string MediaType { get; } = mediaType;

        public int TmdbId { get; } = tmdbId;

        public string Title { get; } = title;

        public string Key { get; } = $"{mediaType}:{tmdbId}";

        public double Popularity { get; } = node["popularity"]?.GetValue<double?>() ?? 0;

        public string? Date { get; } = (string?)node["releaseDate"] ?? (string?)node["firstAirDate"];

        public List<string> Roles { get; } = [];

        public int Episodes { get; set; }

        // "Self" on a talk show is a guest slot; "Self" across a season of a show is a cast member.
        public bool IsAppearance()
            => Roles.Count > 0
                ? Roles.All(r => SelfRole().IsMatch(r)) && (MediaType == "movie" || Episodes < 8)
                : MediaType == "tv" && Episodes <= 3;
    }

    private sealed record Held(Credit Credit, BaseItem? Match, bool Crew);

    // A credit placed on a shelf, with the line that sits under its card there.
    private sealed class Entry(Held held, string subtitle)
    {
        public Held Held { get; } = held;

        public string Subtitle { get; } = subtitle;
    }

    private sealed record Shelf(string Id, string Title, List<Entry> Entries);

    private sealed record Filmography(List<Entry> Library, List<Shelf> Shelves);
}
