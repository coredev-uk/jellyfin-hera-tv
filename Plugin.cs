using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>Hera TV: an Apple TV-style look and home hero for Jellyfin's web client.</summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
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

/// <summary>Settings read by the web client through <c>/HeraTV/config</c>.</summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Gets or sets a value indicating whether the stylesheet and script are injected.</summary>
    public bool Enabled { get; set; } = true;

    /// <summary>Gets or sets how many titles the home hero rotates through.</summary>
    public int HeroItemCount { get; set; } = 8;

    /// <summary>Gets or sets how long each hero title stays before the next, in seconds.</summary>
    public int HeroIntervalSeconds { get; set; } = 8;

    /// <summary>Gets or sets a value indicating whether the Discover tab shows.</summary>
    public bool DiscoverEnabled { get; set; } = true;

    /// <summary>Gets or sets a value indicating whether Maintainerr's Leaving Soon row and chip show.</summary>
    public bool LeavingSoonEnabled { get; set; } = true;

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
}
