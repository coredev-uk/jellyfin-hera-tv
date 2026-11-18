using System.Text;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.HeraTv;

public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<IStartupFilter, WebInjection>();
        serviceCollection.AddSingleton<HealthStore>();
        serviceCollection.AddSingleton<Integrations.UpstreamClient>();
        serviceCollection.AddSingleton<Integrations.LibraryLookup>();
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
public sealed class WebInjection(ILogger<WebInjection> logger) : IStartupFilter
{
    private const string Marker = "data-hera-tv";

    /// <summary>Sets html[data-hera-scheme] from the saved appearance (hera-tv.js, `appearance`).</summary>
    private const string SchemeScript =
        """(function(){try{var p=localStorage.getItem("hera-appearance");var l=p==="light"||(p!=="dark"&&!!window.matchMedia&&matchMedia("(prefers-color-scheme: light)").matches);document.documentElement.setAttribute("data-hera-scheme",l?"light":"dark");}catch(e){}})();""";

    /// <summary>Set once a rewrite failure has been logged as a warning; later ones are debug, so a broken page doesn't fill the log on every load.</summary>
    private static int warned;

    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next) => app =>
    {
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
        var bytes = buffer.ToArray();
        byte[]? rewritten = null;
        try
        {
            rewritten = TryRewrite(context, bytes);
        }
        catch (Exception ex)
        {
            Warn(ex, context.Request.Path);
        }

        if (rewritten is null)
        {
            await original.WriteAsync(bytes).ConfigureAwait(false);
            return;
        }

        context.Response.ContentLength = rewritten.Length;
        context.Response.Headers.Remove("ETag");
        context.Response.Headers.Remove("Last-Modified");
        context.Response.Headers.CacheControl = "no-cache";
        await original.WriteAsync(rewritten).ConfigureAwait(false);
        logger.LogDebug("Injected Hera TV {Version} into {Path}", WebAssets.Version, context.Request.Path);
    }

    /// <summary>
    /// Returns the page with Hera TV added, or null when it should go out as it is: not an HTML
    /// 200, already injected, no head or body to anchor on, or a response that has already
    /// started (its headers are on the wire, so its length can no longer change).
    /// </summary>
    private static byte[]? TryRewrite(HttpContext context, byte[] page)
    {
        var isHtml = context.Response.StatusCode == StatusCodes.Status200OK
            && !context.Response.HasStarted
            && (context.Response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) ?? false);
        if (!isHtml)
        {
            return null;
        }

        var html = Encoding.UTF8.GetString(page);
        var headEnd = html.IndexOf("</head>", StringComparison.OrdinalIgnoreCase);
        var bodyEnd = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (headEnd < 0 || bodyEnd < 0 || html.Contains(Marker, StringComparison.Ordinal))
        {
            return null;
        }

        var v = WebAssets.Version;
        // The stylesheet asks for the font by a bare relative URL, so the preload must match it.
        // The inline script paints the saved appearance before first render; hera-tv.js keeps it
        // in step afterwards (see `appearance` there). Without it a dark choice on a light-mode
        // device would flash white on every load.
        var head =
            $"<link {Marker} rel=\"preload\" as=\"font\" type=\"font/woff2\" crossorigin href=\"../HeraTV/InterVariable.woff2\">" +
            $"<script {Marker}>{SchemeScript}</script>" +
            string.Concat(WebAssets.Stylesheets.Select(name => $"<link {Marker} rel=\"stylesheet\" href=\"../HeraTV/{name}?v={v}\">"));
        var body = string.Concat(WebAssets.Scripts.Select(name => $"<script {Marker} src=\"../HeraTV/{name}?v={v}\" defer></script>"));

        html = new StringBuilder(html.Length + head.Length + body.Length)
            .Append(html, 0, headEnd).Append(head)
            .Append(html, headEnd, bodyEnd - headEnd).Append(body)
            .Append(html, bodyEnd, html.Length - bodyEnd)
            .ToString();

        return Encoding.UTF8.GetBytes(html);
    }

    private void Warn(Exception ex, PathString path)
    {
        if (Interlocked.Exchange(ref warned, 1) == 0)
        {
            logger.LogWarning(ex, "Hera TV couldn't rewrite {Path}; serving Jellyfin's page unmodified. Further failures are logged at debug level", path);
        }
        else
        {
            logger.LogDebug(ex, "Hera TV couldn't rewrite {Path}", path);
        }
    }
}
