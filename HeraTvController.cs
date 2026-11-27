using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.HeraTv;

/// <summary>Serves the web assets and the client-facing settings. The login page loads them too, so no auth.</summary>
[ApiController]
[AllowAnonymous]
[Route("HeraTV")]
public class HeraTvController : ControllerBase
{
    [HttpGet("{name}")]
    public IActionResult GetAsset([FromRoute] string name)
    {
        var asset = WebAssets.Get(name);
        if (asset is null)
        {
            return NotFound();
        }

        // The page references assets with ?v=<fingerprint>, so those URLs never change content.
        Response.Headers.CacheControl = Request.Query.ContainsKey("v")
            ? "public, max-age=31536000, immutable"
            : "public, max-age=86400";

        // Compressed once at its best setting rather than by the server's quick one on every request.
        // Naming the coding in the validator keeps a cache from matching one form against the other.
        string? coding = null;
        if (asset.Compressible)
        {
            Response.Headers.Append(HeaderNames.Vary, HeaderNames.AcceptEncoding);
            coding = WebAssets.ChooseEncoding(Request);
            if (coding is not null)
            {
                Response.Headers.ContentEncoding = coding;
            }
        }

        return File(asset.Payload.Encoded(coding), asset.ContentType, null, EntityTagHeaderValue.Parse(asset.Payload.ETag(coding)));
    }

    [HttpGet("config")]
    public IActionResult GetConfig()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        Response.Headers.CacheControl = "no-cache";
        return Ok(new
        {
            heroItemCount = Math.Clamp(config.HeroItemCount, 1, 20),
            heroIntervalSeconds = Math.Clamp(config.HeroIntervalSeconds, 4, 60),
            // Modules switched off in the plugin's settings: the script never runs them and their stylesheets stay off.
            disabledModules = (config.DisabledModules ?? []).Where(name => !string.IsNullOrWhiteSpace(name) && name.Length <= 48).Distinct(StringComparer.Ordinal).Take(64),
        });
    }
}
