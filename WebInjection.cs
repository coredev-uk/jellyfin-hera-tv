using System.Text;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.HeraTv;

public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<IStartupFilter, WebInjection>();
        serviceCollection.AddSingleton<ServerHealth>(provider =>
        {
            var health = new ServerHealth(provider.GetRequiredService<ILogger<ServerHealth>>());
            try
            {
                health.LogStartup(applicationHost);
            }
            catch (Exception ex)
            {
                // The line is a convenience; the plugin must not fail to load over it.
                health.Fault("Startup report", "log its version line", ex);
            }

            return health;
        });
        serviceCollection.AddSingleton<HealthStore>();
        serviceCollection.AddSingleton<Integrations.UpstreamClient>();
        serviceCollection.AddSingleton<Integrations.LibraryLookup>();
        serviceCollection.AddSingleton<Integrations.HiddenStore>();
        serviceCollection.AddSingleton<Stats.PlaybackReportingSource>();
        serviceCollection.AddSingleton<Stats.StatsStore>();
        serviceCollection.AddSingleton<Stats.IItemCatalogue, Stats.ItemCatalogue>();
        serviceCollection.AddSingleton<Stats.IStatsReports, Stats.StatsReports>();
        serviceCollection.AddGuardedHostedService<Stats.StreamRecorder>(Stats.StreamRecorder.Feature);
        serviceCollection.AddSingleton<Integrations.UserRequests>();
        serviceCollection.AddSingleton<Notifications.NotificationStore>();
        serviceCollection.AddGuardedHostedService<Notifications.NotificationCentre>(Notifications.NotificationCentre.Feature);
        serviceCollection.AddSingleton<Letterboxd.LetterboxdStore>();
        serviceCollection.AddSingleton<Letterboxd.LetterboxdSync>();
        serviceCollection.AddSingleton<Letterboxd.LetterboxdWatcher>();
        serviceCollection.AddGuardedHostedService(Letterboxd.LetterboxdWatcher.Feature, provider => provider.GetRequiredService<Letterboxd.LetterboxdWatcher>());
        serviceCollection.AddSingleton<Collections.Snapshots>();
        serviceCollection.AddSingleton<Collections.Catalogue>();
        serviceCollection.AddSingleton<Collections.StreamingCache>();
        serviceCollection.AddSingleton<Collections.ICollectionsView, Collections.CollectionsView>();
        serviceCollection.AddSingleton<Collections.ICollectionBuilder, Collections.CollectionBuilder>();
    }
}

/// <summary>
/// Adds the Hera TV stylesheet, font preload and script to the web client's index.html as it is
/// served. Nothing on disk changes, so the image's read-only web folder is fine, and turning the
/// plugin off (or removing it) restores the stock page on the next load.
/// </summary>
/// <remarks>
/// It fails open: this runs in front of the server's own web page, so whatever goes wrong while
/// rewriting, the page Jellyfin produced is what gets sent.
/// </remarks>
public sealed class WebInjection(ILogger<WebInjection> logger, ServerHealth health) : IStartupFilter
{
    private const string Marker = "data-hera-tv";

    /// <summary>Sets html[data-hera-scheme] from the saved appearance (hera-tv.js, `appearance`).</summary>
    private const string SchemeScript =
        """(function(){try{var p=localStorage.getItem("hera-appearance");var l=p==="light"||(p!=="dark"&&!!window.matchMedia&&matchMedia("(prefers-color-scheme: light)").matches);document.documentElement.setAttribute("data-hera-scheme",l?"light":"dark");}catch(e){}})();""";

    /// <summary>
    /// Switches Hera's styling on before first paint: the core stylesheets sit behind <c>hera-on</c> and
    /// each module's behind <c>hera-m-&lt;module&gt;</c> (see <see cref="CssGate"/>), so without these
    /// classes on the page from the start the web client would draw unstyled until the script ran. They
    /// are left off when this tab has asked for Hera to be off (<c>?hera=off</c>, or hera-off in
    /// sessionStorage, which <c>?hera=on</c> overrides): hera-tv.js, once it runs, only ever removes them
    /// (safe mode, a module standing aside, one switched off in the settings since this page was served).
    /// </summary>
    private const string GateScript =
        """(function(){try{var q=new URLSearchParams(location.search).get("hera")||new URLSearchParams(location.hash.split("?")[1]||"").get("hera"),o=q==="off";if(!o&&q!=="on"){try{o=sessionStorage.getItem("hera-off")==="1"}catch(e){}}if(!o)document.documentElement.classList.add(@CLASSES);}catch(e){}})();""";

    /// <summary>The last page rewritten. Jellyfin's index.html is one file that changes only with an upgrade, so this is nearly always the one asked for again.</summary>
    private static volatile Page? latest;

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
        // Off the startup path and off the first page load: compressing the bundles is the one
        // slow step. Anything it throws is thrown again by the first request that needs the result,
        // where it is handled, so this only needs to say so.
        _ = Task.Run(() =>
        {
            try
            {
                WebAssets.Warm();
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Hera TV couldn't prepare its web assets ahead of the first request");
            }
        });
        app.Use(InvokeAsync);
        next(app);
    };

    private static bool IsIndex(PathString path)
    {
        var value = path.Value;
        return value is not null
            && (value.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase)
                || value.EndsWith("/web/", StringComparison.OrdinalIgnoreCase)
                || value.EndsWith("/web", StringComparison.OrdinalIgnoreCase));
    }

    private async Task InvokeAsync(HttpContext context, Func<Task> next)
    {
        if (!HttpMethods.IsGet(context.Request.Method)
            || !IsIndex(context.Request.Path)
            || Plugin.Instance?.Configuration.Enabled != true)
        {
            await next().ConfigureAwait(false);
            return;
        }

        // What the client can take and what it already holds are answered for the rewritten page,
        // below, not for the file Jellyfin serves.
        var coding = WebAssets.ChooseEncoding(context.Request);
        var held = context.Request.GetTypedHeaders().IfNoneMatch;

        // A plain, whole 200 is the only body worth rewriting.
        context.Request.Headers.Remove("Accept-Encoding");
        context.Request.Headers.Remove("Range");
        context.Request.Headers.Remove("If-Range");
        context.Request.Headers.Remove("If-None-Match");
        context.Request.Headers.Remove("If-Modified-Since");

        var original = context.Response.Body;
        using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            // An exception from Jellyfin's own handling of the page is Jellyfin's to raise, as
            // it would be without this plugin; there is no finished response to fall back to.
            await next().ConfigureAwait(false);
        }
        finally
        {
            context.Response.Body = original;
        }

        // Everything that can fail is in TryRewrite, which touches no header. If it throws, or
        // declines, the bytes Jellyfin wrote go out exactly as they were. Past this point there
        // is only the write to the client.
        var bytes = buffer.GetBuffer().AsMemory(0, (int)buffer.Length);
        Rewrite? rewritten = null;
        string? decline = null;
        try
        {
            rewritten = TryRewrite(context, bytes, coding, held, out decline);
        }
        catch (Exception ex)
        {
            health.Declined($"rewriting {context.Request.Path} failed", ex);
            decline = null;
        }

        if (rewritten is not null)
        {
            health.Injected();
        }
        else if (decline is not null)
        {
            health.Declined(decline);
        }

        if (rewritten is null)
        {
            await original.WriteAsync(bytes).ConfigureAwait(false);
            return;
        }

        var response = context.Response;
        response.Headers.Remove("Last-Modified");
        response.Headers.Remove("Accept-Ranges");
        response.Headers.CacheControl = "no-cache";
        response.Headers.ETag = rewritten.ETag;
        // Jellyfin's compression usually has said this already.
        if (!response.Headers.Vary.Any(value => value?.Contains(HeaderNames.AcceptEncoding, StringComparison.OrdinalIgnoreCase) ?? false))
        {
            response.Headers.Append(HeaderNames.Vary, HeaderNames.AcceptEncoding);
        }

        if (rewritten.NotModified)
        {
            response.StatusCode = StatusCodes.Status304NotModified;
            response.ContentLength = null;
            response.Headers.Remove("Content-Type");
            return;
        }

        if (coding is not null)
        {
            response.Headers.ContentEncoding = coding;
        }

        response.ContentLength = rewritten.Body.Length;
        await original.WriteAsync(rewritten.Body).ConfigureAwait(false);
        logger.LogDebug("Injected Hera TV {Version} into {Path}", WebAssets.Version, context.Request.Path);
    }

    /// <summary>
    /// Returns the page with Hera TV added, in the form the client asked for, or null when it
    /// should go out as it is: not an HTML 200, already injected, no head or body to anchor on, or
    /// a response that has already started (its headers are on the wire, so its length can no
    /// longer change).
    /// </summary>
    private static Rewrite? TryRewrite(HttpContext context, ReadOnlyMemory<byte> source, string? coding, IList<EntityTagHeaderValue> held, out string? decline)
    {
        // A redirect (Jellyfin's /web to /web/) carries no page to rewrite and is nothing to report.
        if (context.Response.StatusCode is >= 300 and < 400)
        {
            decline = null;
            return null;
        }

        var isHtml = context.Response.StatusCode == StatusCodes.Status200OK
            && !context.Response.HasStarted
            && (context.Response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) ?? false);
        if (!isHtml)
        {
            decline = $"Jellyfin answered {context.Response.StatusCode} ({context.Response.ContentType ?? "no content type"}) rather than an HTML page";
            return null;
        }

        // The page is the file Jellyfin served with this build's fragments and the modules the
        // settings leave on; a change to either (a module switched off, a new Jellyfin file) is a
        // different page, with its own validator.
        var enabled = EnabledModules();
        var key = string.Join(',', enabled);
        var page = latest;
        if (page is null || page.Key != key || !page.Original.AsSpan().SequenceEqual(source.Span))
        {
            page = Inject(source.ToArray(), key, enabled, out decline);
            if (page is null)
            {
                return null;
            }

            latest = page;
        }

        decline = null;

        // The page depends on nothing but Jellyfin's file, this build and the modules switched off, so
        // its validator is a hash of what is sent. Jellyfin's own ETag is for the file it has on disk,
        // not for this.
        var etag = page.Payload.ETag(coding);
        var notModified = held.Any(tag => tag.Equals(EntityTagHeaderValue.Any) || tag.Compare(EntityTagHeaderValue.Parse(etag), useStrongComparison: false));
        return new Rewrite(etag, notModified ? [] : page.Payload.Encoded(coding), notModified);
    }

    /// <summary>The modules in the manifest that the plugin's settings leave switched on.</summary>
    private static string[] EnabledModules()
    {
        var off = Plugin.Instance?.Configuration.DisabledModules ?? [];
        return [.. WebAssets.Modules.Where(module => !off.Contains(module, StringComparer.Ordinal))];
    }

    /// <summary>The page with Hera TV added, or null (with the reason) where it has no head and body to add it to or has it already.</summary>
    private static Page? Inject(byte[] source, string key, string[] enabled, out string? decline)
    {
        var html = Encoding.UTF8.GetString(source);
        var headEnd = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        var bodyEnd = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (headEnd < 0 || bodyEnd < 0)
        {
            decline = "Jellyfin's page has no </head> or </body> to add to";
            return null;
        }

        if (html.Contains(Marker, StringComparison.Ordinal))
        {
            decline = "the page already carries Hera TV";
            return null;
        }

        var fragments = BuildFragments(enabled);
        html = new StringBuilder(html.Length + fragments.Head.Length + fragments.Body.Length)
            .Append(html, 0, headEnd).Append(fragments.Head)
            .Append(html, headEnd, bodyEnd - headEnd).Append(fragments.Body)
            .Append(html, bodyEnd, html.Length - bodyEnd)
            .ToString();

        decline = null;
        return new Page(source, key, new WebAssets.Payload(Encoding.UTF8.GetBytes(html)));
    }

    private static Fragments BuildFragments(string[] enabled)
    {
        var v = WebAssets.Version;
        // The stylesheet asks for the font by a bare relative URL, so the preload must match it.
        // The inline script paints the saved appearance before first render; hera-tv.js keeps it
        // in step afterwards (see `appearance` there). Without it a dark choice on a light-mode
        // device would flash white on every load.
        var gates = string.Join(',', new[] { "hera-on" }.Concat(enabled.Select(module => $"hera-m-{module}")).Select(name => $"\"{name}\""));
        var head =
            $"<link {Marker} rel=\"preload\" as=\"font\" type=\"font/woff2\" crossorigin href=\"../HeraTV/InterVariable.woff2?v={v}\">" +
            $"<script {Marker}>{SchemeScript}{GateScript.Replace("@CLASSES", gates, StringComparison.Ordinal)}</script>" +
            $"<link {Marker} rel=\"stylesheet\" href=\"../HeraTV/{WebAssets.StylesheetBundle}?v={v}\">";
        var body = $"<script {Marker} src=\"../HeraTV/{WebAssets.ScriptBundle}?v={v}\" defer></script>";
        return new Fragments(head, body);
    }

    private sealed record Fragments(string Head, string Body);

    /// <summary>Jellyfin's page as it was (to recognise it again), the modules it was made for, and the page sent in its place.</summary>
    private sealed record Page(byte[] Original, string Key, WebAssets.Payload Payload);

    /// <summary>What to send: the validator, the body in the client's encoding (empty when it already holds this page).</summary>
    private sealed record Rewrite(string ETag, byte[] Body, bool NotModified);
}
