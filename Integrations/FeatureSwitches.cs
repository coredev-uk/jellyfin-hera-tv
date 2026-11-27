using System.Text.Json;
using System.Text.RegularExpressions;

namespace Jellyfin.Plugin.HeraTv.Integrations;

/// <summary>
/// One on/off setting: the name the web client reads it by, the name the dashboard saves it under, and
/// where it lives in the saved configuration.
/// </summary>
/// <param name="Feature">The key in the <c>features</c> object the web client and dashboard read.</param>
/// <param name="Body">The key the dashboard posts it under when saving.</param>
/// <param name="Get">Reads the saved switch.</param>
/// <param name="Set">Writes it.</param>
/// <param name="Listed">Whether it is in the <c>features</c> object at all; the master switch and Collections are shown elsewhere.</param>
/// <param name="Offered">What the web client is told, when that isn't just the saved switch (Letterboxd also needs its key and secret).</param>
public sealed record FeatureSwitch(
    string Feature,
    string Body,
    Func<PluginConfiguration, bool> Get,
    Action<PluginConfiguration, bool> Set,
    bool Listed = true,
    Func<PluginConfiguration, bool>? Offered = null);

/// <summary>
/// Every server-wide on/off switch, in one table. Saving, describing the settings for the dashboard and
/// telling the web client what is on all read this list, so a new switch is one row here and one property
/// in <see cref="PluginConfiguration"/>, and the three can't drift apart. The modules the web client is
/// told to leave unregistered (<see cref="PluginConfiguration.DisabledModules"/>) are kept the same way.
/// </summary>
public static class FeatureSwitches
{
    private const int MaxModules = 64;
    private const int MaxModuleName = 40;

    private static readonly Regex ModuleName = new("^[a-z0-9][a-z0-9-]*$", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));

    /// <summary>The switches, in the order the dashboard and the web client list them.</summary>
    public static readonly IReadOnlyList<FeatureSwitch> All =
    [
        new("enabled", "enabled", c => c.Enabled, (c, v) => c.Enabled = v, Listed: false),
        new("discover", "discoverEnabled", c => c.DiscoverEnabled, (c, v) => c.DiscoverEnabled = v),
        new("leavingSoon", "leavingSoonEnabled", c => c.LeavingSoonEnabled, (c, v) => c.LeavingSoonEnabled = v),
        new("requests", "requestsRowEnabled", c => c.RequestsRowEnabled, (c, v) => c.RequestsRowEnabled = v),
        new("trending", "trendingRowEnabled", c => c.TrendingRowEnabled, (c, v) => c.TrendingRowEnabled = v),
        new("elsewhere", "elsewhereEnabled", c => c.ElsewhereEnabled, (c, v) => c.ElsewhereEnabled = v),
        new("ratings", "ratingsEnabled", c => c.RatingsEnabled, (c, v) => c.RatingsEnabled = v),
        new("qualityBadges", "qualityBadgesEnabled", c => c.QualityBadgesEnabled, (c, v) => c.QualityBadgesEnabled = v),
        new("activity", "activityEnabled", c => c.ActivityEnabled, (c, v) => c.ActivityEnabled = v),
        new("notifications", "notificationsEnabled", c => c.NotificationsEnabled, (c, v) => c.NotificationsEnabled = v),
        new("homeRows", "homeRowsEnabled", c => c.HomeRowsEnabled, (c, v) => c.HomeRowsEnabled = v),
        new("collections", "collectionsEnabled", c => c.CollectionsEnabled, (c, v) => c.CollectionsEnabled = v, Listed: false),
        new(
            "letterboxd",
            "letterboxdEnabled",
            c => c.LetterboxdEnabled,
            (c, v) => c.LetterboxdEnabled = v,
            Offered: c => c.LetterboxdEnabled
                && !string.IsNullOrEmpty(IntegrationSettings.Inspect(IntegrationSettings.LetterboxdApiKeyVariable, c.LetterboxdApiKey).Value)
                && !string.IsNullOrEmpty(IntegrationSettings.Inspect(IntegrationSettings.LetterboxdApiSecretVariable, c.LetterboxdApiSecret).Value)),
    ];

    /// <summary>Gets whether the saved switch is on.</summary>
    public static bool On(string feature, PluginConfiguration config) => All.First(s => s.Feature == feature).Get(config);

    /// <summary>Gets what the web client and the dashboard read as <c>features</c>: each listed switch, as it applies now.</summary>
    public static Dictionary<string, bool> Describe(PluginConfiguration config)
    {
        var features = new Dictionary<string, bool>(StringComparer.Ordinal);
        foreach (var feature in All.Where(s => s.Listed))
        {
            features[feature.Feature] = (feature.Offered ?? feature.Get)(config);
        }

        return features;
    }

    /// <summary>
    /// Saves the switches a form sent. One that wasn't sent, or wasn't true or false, keeps its saved value.
    /// </summary>
    /// <param name="config">The configuration to change.</param>
    /// <param name="sent">The form's fields that aren't read elsewhere, by name.</param>
    public static void Apply(PluginConfiguration config, IReadOnlyDictionary<string, JsonElement> sent)
    {
        foreach (var feature in All)
        {
            // Matched without regard to case, whatever the dictionary was made with: the form's names are camelCase.
            foreach (var (name, value) in sent)
            {
                if (string.Equals(name, feature.Body, StringComparison.OrdinalIgnoreCase) && value.ValueKind is JsonValueKind.True or JsonValueKind.False)
                {
                    feature.Set(config, value.GetBoolean());
                }
            }
        }
    }

    /// <summary>Gets the web modules switched off, as saved.</summary>
    public static IReadOnlyList<string> DisabledModules(PluginConfiguration config) => [.. config.DisabledModules];

    /// <summary>Saves which web modules are switched off: lower-case names of the kind the modules register under, once each, and no more than the page has.</summary>
    public static void SetDisabledModules(PluginConfiguration config, IEnumerable<string?> names)
        => config.DisabledModules = [.. names
            .Select(n => n?.Trim().ToLowerInvariant())
            .Where(n => n is { Length: > 0 and <= MaxModuleName } && ModuleName.IsMatch(n))
            .Select(n => n!)
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .Take(MaxModules)];
}
