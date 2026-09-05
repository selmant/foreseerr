using System.Reflection;
using System.Text;
using Jellyfin.Data.Enums;
using MediaBrowser.Controller.Library;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Foreseerr.Jellyfin;

[ApiController]
[Route("")]
public class ForeseerrProxyController : ControllerBase
{
    private static readonly HashSet<string> HopByHop = new(StringComparer.OrdinalIgnoreCase)
    {
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailers", "transfer-encoding", "upgrade", "host",
    };

    private readonly SidecarSupervisor _supervisor;
    private readonly SidecarSessionService _sessions;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IUserManager _userManager;
    private readonly ILogger<ForeseerrProxyController> _logger;

    public ForeseerrProxyController(
        SidecarSupervisor supervisor,
        SidecarSessionService sessions,
        IHttpClientFactory httpClientFactory,
        IUserManager userManager,
        ILogger<ForeseerrProxyController> logger)
    {
        _supervisor = supervisor;
        _sessions = sessions;
        _httpClientFactory = httpClientFactory;
        _userManager = userManager;
        _logger = logger;
    }

    [HttpGet("ForeseerrPlugin/loader.js")]
    [AllowAnonymous]
    public IActionResult Loader()
    {
        var stream = Assembly.GetExecutingAssembly()
            .GetManifestResourceStream("Foreseerr.Jellyfin.Web.loader.js");
        if (stream == null)
        {
            return NotFound();
        }

        using var reader = new StreamReader(stream);
        return Content(reader.ReadToEnd(), "application/javascript");
    }

    [HttpGet("ForeseerrPlugin/Status")]
    [Authorize]
    public IActionResult Status()
    {
        var config = ForeseerrPlugin.Instance?.Configuration;
        return Ok(new
        {
            running = _supervisor.IsRunning,
            pid = _supervisor.Pid,
            origin = _supervisor.Origin,
            lastError = _supervisor.LastError ?? config?.LastError,
            betterTrakt = JellyfinHostBootstrap.BetterTraktPresent(),
            publicServerUrl = config?.PublicServerUrl,
            sidecarPort = _supervisor.Port,
            version = typeof(ForeseerrPlugin).Assembly.GetName().Version?.ToString(),
        });
    }

    [HttpPost("ForeseerrPlugin/Webhook")]
    [AllowAnonymous]
    public IActionResult Webhook()
    {
        var expected = ForeseerrPlugin.Instance?.Configuration.WebhookSecret;
        var provided = Request.Query["secret"].ToString();
        if (string.IsNullOrEmpty(provided)
            && Request.Headers.TryGetValue("Authorization", out var auth))
        {
            var header = auth.ToString();
            provided = header.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase)
                ? header["Bearer ".Length..].Trim()
                : header;
        }

        if (string.IsNullOrEmpty(expected)
            || !string.Equals(provided, expected, StringComparison.Ordinal))
        {
            return Unauthorized();
        }

        _logger.LogInformation("Accepted Foreseerr webhook notification");
        return NoContent();
    }

    [HttpPost("ForeseerrPlugin/sso")]
    [Authorize]
    public async Task<IActionResult> Sso(CancellationToken cancellationToken)
    {
        var cookie = await AttachSessionCookie(cancellationToken);
        if (string.IsNullOrEmpty(cookie))
        {
            return Ok(new
            {
                url = "/Foreseerr/login",
                mint = false,
                lastError = _supervisor.LastError,
            });
        }

        AppendBrowserCookie(cookie);
        return Ok(new { url = "/Foreseerr/", mint = true });
    }

    [AcceptVerbs("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")]
    [Route("Foreseerr")]
    [Route("Foreseerr/{**path}")]
    [Authorize]
    public async Task Proxy(string? path, CancellationToken cancellationToken)
    {
        var cookie = await AttachSessionCookie(cancellationToken);
        var targetPath = Request.Path.Value ?? "/Foreseerr/";
        var target = _supervisor.Origin + targetPath + Request.QueryString.Value;
        using var upstream = new HttpRequestMessage(new HttpMethod(Request.Method), target);
        if (Request.ContentLength is > 0 || Request.ContentType != null)
        {
            upstream.Content = new StreamContent(Request.Body);
            if (!string.IsNullOrEmpty(Request.ContentType))
            {
                upstream.Content.Headers.TryAddWithoutValidation("Content-Type", Request.ContentType);
            }
        }

        foreach (var header in Request.Headers)
        {
            if (HopByHop.Contains(header.Key) || header.Key.Equals("Cookie", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (!upstream.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray())
                && upstream.Content != null)
            {
                upstream.Content.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
            }
        }

        if (!string.IsNullOrEmpty(cookie))
        {
            upstream.Headers.TryAddWithoutValidation("Cookie", cookie);
        }

        var client = _httpClientFactory.CreateClient(PluginServiceRegistrator.SidecarHttpClient);
        client.Timeout = TimeSpan.FromMinutes(5);
        using var response = await client.SendAsync(
            upstream,
            HttpCompletionOption.ResponseHeadersRead,
            cancellationToken);

        Response.StatusCode = (int)response.StatusCode;
        foreach (var header in response.Headers)
        {
            if (HopByHop.Contains(header.Key))
            {
                continue;
            }

            Response.Headers[header.Key] = header.Value.ToArray();
        }

        foreach (var header in response.Content.Headers)
        {
            if (header.Key.Equals("Content-Length", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            Response.Headers[header.Key] = header.Value.ToArray();
        }

        if (response.Headers.TryGetValues("Set-Cookie", out var setCookies))
        {
            foreach (var setCookie in setCookies)
            {
                AppendBrowserCookie(setCookie.Split(';', 2)[0]);
            }
        }

        await response.Content.CopyToAsync(Response.Body, cancellationToken);
    }

    private async Task<string?> AttachSessionCookie(CancellationToken cancellationToken)
    {
        var userId = ForeseerrClaims.ReadUserId(User);
        if (userId == Guid.Empty)
        {
            return null;
        }

        var user = _userManager.GetUserById(userId);
        if (user == null)
        {
            return null;
        }

        var token = ReadJellyfinToken();
        var isAdmin = false;
        try
        {
            isAdmin = user.HasPermission(PermissionKind.IsAdministrator);
        }
        catch
        {
            isAdmin = false;
        }

        return await _sessions.EnsureCookieAsync(
            user.Id,
            user.Username,
            isAdmin,
            token,
            cancellationToken);
    }

    private string? ReadJellyfinToken()
    {
        if (Request.Headers.TryGetValue("X-Emby-Token", out var emby) && !string.IsNullOrEmpty(emby))
        {
            return emby.ToString();
        }

        if (Request.Headers.TryGetValue("X-MediaBrowser-Token", out var mb) && !string.IsNullOrEmpty(mb))
        {
            return mb.ToString();
        }

        var authorization = Request.Headers.Authorization.ToString();
        const string marker = "Token=\"";
        var start = authorization.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (start >= 0)
        {
            start += marker.Length;
            var end = authorization.IndexOf('"', start);
            if (end > start)
            {
                return authorization[start..end];
            }
        }

        return null;
    }

    private void AppendBrowserCookie(string cookiePair)
    {
        var pair = cookiePair.Contains(';') ? cookiePair.Split(';', 2)[0] : cookiePair;
        Response.Cookies.Append(
            pair.Split('=', 2)[0],
            pair.Contains('=') ? pair.Split('=', 2)[1] : string.Empty,
            new CookieOptions
            {
                Path = "/Foreseerr",
                HttpOnly = true,
                SameSite = SameSiteMode.Lax,
            });
    }
}

public static class ForeseerrClaims
{
    public static Guid ReadUserId(System.Security.Claims.ClaimsPrincipal user)
    {
        var value = user.FindFirst("UserId")?.Value
            ?? user.FindFirst("http://jellyfin.org/claims/userid")?.Value
            ?? user.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
        return Guid.TryParse(value, out var id) ? id : Guid.Empty;
    }
}
