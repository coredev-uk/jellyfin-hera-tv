using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>Hera TV: an Apple TV-style look and home hero for Jellyfin's web client.</summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(BackedUp(applicationPaths), xmlSerializer)
    {
        Instance = this;
    }

    /// <summary>
    /// Keeps a copy of the saved configuration the first time each version of the plugin starts, before anything
    /// has read or changed it. Jellyfin replaces a configuration file it can't read with the defaults, and saves
    /// over it, without a word; a copy from before the upgrade is what makes that recoverable. It runs ahead of
    /// the base constructor for that reason. A failure to copy never stops the plugin (there is nowhere to log
    /// yet), and only the newest few copies are kept.
    /// </summary>
    private static IApplicationPaths BackedUp(IApplicationPaths paths)
    {
        const int Kept = 5;
        try
        {
            var assembly = typeof(Plugin).Assembly.GetName();
            var file = Path.Combine(paths.PluginConfigurationsPath, assembly.Name + ".xml");
            var copy = $"{file}.before-{assembly.Version}";
            if (File.Exists(file) && !File.Exists(copy))
            {
                File.Copy(file, copy);
                foreach (var old in new DirectoryInfo(paths.PluginConfigurationsPath).GetFiles(Path.GetFileName(file) + ".before-*").OrderByDescending(f => f.LastWriteTimeUtc).Skip(Kept))
                {
                    old.Delete();
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // Left uncopied; see above.
        }

        return paths;
    }

    public static Plugin? Instance { get; private set; }

    public override string Name => "Hera TV";

    public override Guid Id => Guid.Parse("9718b214-55d6-4828-84c8-677f2a4a131b");

    /// <summary>The name the dashboard page is addressed by: <c>#/configurationpage?name=HeraTV</c>.</summary>
    public const string SettingsPage = "HeraTV";

    /// <summary>The name the Statistics dashboard page is addressed by: <c>#/configurationpage?name=HeraStats</c>.</summary>
    public const string StatsPage = "HeraStats";

    /// <summary>Gets the dashboard's settings page (HTML plus its script) and its place in the sidebar.</summary>
    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = SettingsPage,
            DisplayName = "Hera TV",
            EmbeddedResourcePath = "heratv-settings.html",
            EnableInMainMenu = true,
            MenuSection = "server",
            MenuIcon = "tv",
        };
        yield return new PluginPageInfo
        {
            Name = "heratv-settings.js",
            EmbeddedResourcePath = "heratv-settings.js",
        };
        yield return new PluginPageInfo
        {
            Name = StatsPage,
            DisplayName = "Statistics",
            EmbeddedResourcePath = "herastats.html",
            EnableInMainMenu = true,
            MenuSection = "server",
            MenuIcon = "insights",
        };
        yield return new PluginPageInfo
        {
            Name = "herastats.js",
            EmbeddedResourcePath = "herastats.js",
        };
    }

    public override string Description => "Apple TV-style theme, personalised home, Discover with Seerr requests and Maintainerr's Leaving Soon for the web client.";
}

/// <summary>
/// Settings read by the web client through <c>/HeraTV/config</c>, and saved by Jellyfin as XML that every
/// version of the plugin shares. A property is never given another type or meaning: a new one is added
/// instead, because Jellyfin replaces a file it can't read with the defaults without saying so. The on/off
/// switches are listed once, in <see cref="Integrations.FeatureSwitches"/>.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Gets or sets a value indicating whether the stylesheet and script are injected.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Gets or sets how many titles the home hero rotates through.</summary>
    public int HeroItemCount { get; set; } = 8;

    /// <summary>Gets or sets how long each hero title stays before the next, in seconds.</summary>
    public int HeroIntervalSeconds { get; set; } = 8;

    /// <summary>
    /// Gets or sets the names of the web client's modules switched off (hero, player, login, ...): the
    /// script never runs them and their styling never applies. The way to turn a surface off that a
    /// Jellyfin update has broken, until Hera has been updated for it.
    /// </summary>
    public List<string> DisabledModules { get; set; } = [];

    /// <summary>Gets or sets a value indicating whether the Discover tab shows.</summary>
    public bool DiscoverEnabled { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether Maintainerr's Leaving Soon row and chip show.</summary>
    public bool LeavingSoonEnabled { get; set; } = true;

    /// <summary>Gets or sets how far ahead Leaving Soon looks, in days: titles leaving later are left out. 0 lists everything Maintainerr has queued.</summary>
    public int LeavingSoonDays { get; set; }

    /// <summary>Gets or sets who sees the quality capsule (1080p | 4K) on a request: "seerr" (anyone Seerr lets pick a profile), "admins" (Jellyfin administrators among them) or "off".</summary>
    public string RequestQualityPicker { get; set; } = "seerr";

    /// <summary>Gets or sets the profile a 1080p film request uses, as "serverId:profileId" from Seerr's Radarr servers; empty reads it from the profiles' names.</summary>
    public string? RequestMovieHdProfile { get; set; }

    /// <summary>Gets or sets the profile a 4K film request uses ("serverId:profileId"); on a server Seerr marks 4K, the request is a 4K request. Empty reads it from the names.</summary>
    public string? RequestMovie4kProfile { get; set; }

    /// <summary>Gets or sets the profile a 1080p series request uses ("serverId:profileId" on a Sonarr server); empty reads it from the names.</summary>
    public string? RequestTvHdProfile { get; set; }

    /// <summary>Gets or sets the profile a 4K series request uses ("serverId:profileId"); empty reads it from the names.</summary>
    public string? RequestTv4kProfile { get; set; }

    /// <summary>Gets or sets the quality the capsule starts on: "server" (the server's own default profile), "1080p" or "4K".</summary>
    public string RequestDefaultQuality { get; set; } = "server";

    /// <summary>Gets or sets a value indicating whether the Your Requests row shows on the home page.</summary>
    public bool RequestsRowEnabled { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether title pages list the streaming services that carry the title.</summary>
    public bool ElsewhereEnabled { get; set; } = true;

    /// <summary>Gets or sets the ISO 3166-1 country whose streaming services "Also on" lists.</summary>
    public string WatchRegion { get; set; } = "GB";

    /// <summary>Gets or sets a value indicating whether title pages show IMDb and Rotten Tomatoes scores.</summary>
    public bool RatingsEnabled { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether 4K, HDR, Dolby Vision and Atmos badges show.</summary>
    public bool QualityBadgesEnabled { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the Trending to Request row shows on the home page.</summary>
    public bool TrendingRowEnabled { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether requests show live download progress from Sonarr, Radarr and SABnzbd.</summary>
    public bool ActivityEnabled { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the header's bell and its notices are on: request progress, new episodes of shows being watched, and the daily summary of arrivals.</summary>
    public bool NotificationsEnabled { get; set; } = true;

    /// <summary>Gets or sets the hour (0 to 23, server time) from which the daily summary of new arrivals is written.</summary>
    public int ArrivalsHour { get; set; } = 18;

    /// <summary>Gets or sets a value indicating whether Hera builds its collections (BoxSets) on a schedule. Off removes the ones it built.</summary>
    public bool CollectionsEnabled { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the home page shows the rows <c>/HeraTV/collections/rows</c> serves.</summary>
    public bool HomeRowsEnabled { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether Universes (Marvel, Star Wars, ...) become collections.</summary>
    public bool CollectionsUniverses { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether Awards (Best Picture, BAFTA) become collections.</summary>
    public bool CollectionsAwards { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether streaming services ("On Netflix") become collections.</summary>
    public bool CollectionsStreaming { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether seasonal sets (Christmas, Bonfire Night, ...) become collections while in season.</summary>
    public bool CollectionsSeasonal { get; set; } = true;

    /// <summary>Gets or sets the seasonal sets switched off, by key ("halloween,remembrance"); the rest follow <see cref="CollectionsSeasonal"/>.</summary>
    public string? SeasonalOff { get; set; }

    /// <summary>Gets or sets a value indicating whether Homegrown (British-made) sets become collections.</summary>
    public bool CollectionsHomegrown { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether the best of each decade becomes a collection.</summary>
    public bool CollectionsDecades { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether genres become collections.</summary>
    public bool CollectionsGenres { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether film studios become collections. Off by default: there are many and they crowd the list.</summary>
    public bool CollectionsStudios { get; set; }

    /// <summary>Gets or sets a value indicating whether TV networks become collections. Off by default: a series' studios mix networks with production companies, and the real networks repeat the Streaming sets.</summary>
    public bool CollectionsNetworks { get; set; }

    /// <summary>Gets or sets a value indicating whether certificates (U, PG, 12A, 15, 18) become collections. Off by default: they add clutter.</summary>
    public bool CollectionsCertificates { get; set; }

    // Integrations. HERATV_* environment variables take precedence over these.

    /// <summary>Gets or sets the Seerr URL the server calls.</summary>
    public string? SeerrUrl { get; set; }

    /// <summary>Gets or sets the Seerr URL people open in a browser.</summary>
    public string? SeerrPublicUrl { get; set; }

    /// <summary>Gets or sets the Seerr API key.</summary>
    public string? SeerrApiKey { get; set; }

    /// <summary>Gets or sets Jellyfin username to Seerr user id pairs, as <c>alice=1,bob=3</c>.</summary>
    public string? SeerrUsers { get; set; }

    /// <summary>Gets or sets the Maintainerr URL the server calls.</summary>
    public string? MaintainerrUrl { get; set; }

    /// <summary>Gets or sets the Sonarr URL the server calls.</summary>
    public string? SonarrUrl { get; set; }

    /// <summary>Gets or sets the Sonarr API key.</summary>
    public string? SonarrApiKey { get; set; }

    /// <summary>Gets or sets the Radarr URL the server calls.</summary>
    public string? RadarrUrl { get; set; }

    /// <summary>Gets or sets the Radarr API key.</summary>
    public string? RadarrApiKey { get; set; }

    /// <summary>Gets or sets the SABnzbd URL the server calls.</summary>
    public string? SabnzbdUrl { get; set; }

    /// <summary>Gets or sets the SABnzbd API key.</summary>
    public string? SabnzbdApiKey { get; set; }

    /// <summary>Gets or sets the Sonarr URL people open in a browser.</summary>
    public string? SonarrPublicUrl { get; set; }

    /// <summary>Gets or sets the Radarr URL people open in a browser.</summary>
    public string? RadarrPublicUrl { get; set; }

    /// <summary>Gets or sets the SABnzbd URL people open in a browser.</summary>
    public string? SabnzbdPublicUrl { get; set; }

    /// <summary>Gets or sets a value indicating whether people can link a Letterboxd account, so the films they finish are logged to its diary.</summary>
    public bool LetterboxdEnabled { get; set; } = true;

    /// <summary>Gets or sets the Letterboxd API key. Letterboxd only issues keys to partners.</summary>
    public string? LetterboxdApiKey { get; set; }

    /// <summary>Gets or sets the Letterboxd API shared secret that signs every request.</summary>
    public string? LetterboxdApiSecret { get; set; }
}
