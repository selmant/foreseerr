using System.Reflection;
using System.Text.Encodings.Web;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Foreseerr.Jellyfin;

[ApiController]
[Route("")]
public class ForeseerrProxyController(
    SidecarSupervisor supervisor,
    SidecarSessionService sessions,
    IHttpClientFactory clients,
    IAuthService auth) : ControllerBase
{
    private static readonly HashSet<string> HopByHop = new(StringComparer.OrdinalIgnoreCase)
    {
        "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
        "te", "trailer", "trailers", "transfer-encoding", "upgrade", "host",
    };

    [HttpGet("ForeseerrPlugin/loader.js")]
    [AllowAnonymous]
    public IActionResult Loader()
    {
        using var stream = Assembly.GetExecutingAssembly()
            .GetManifestResourceStream("Foreseerr.Jellyfin.Web.loader.js");
        if (stream == null) return NotFound();
        using var reader = new StreamReader(stream);
        return Content(reader.ReadToEnd(), "application/javascript");
    }

    [HttpGet("ForeseerrPlugin/Status")]
    [Authorize(Policy = "RequiresElevation")]
    public IActionResult Status() => Ok(new
    {
        running = supervisor.IsRunning,
        ready = supervisor.IsReady,
        pid = supervisor.Pid,
        lastError = supervisor.LastError,
        betterTrakt = JellyfinHostBootstrap.BetterTraktPresent(),
        sidecarPort = supervisor.Port,
        version = typeof(ForeseerrPlugin).Assembly.GetName().Version?.ToString(),
    });

    [HttpPost("Foreseerr/sso")]
    [Authorize]
    public async Task<IActionResult> Sso(CancellationToken cancellationToken)
    {
        var authorization = await auth.Authenticate(Request).ConfigureAwait(false);
        if (!authorization.IsAuthenticated || authorization.IsApiKey
            || authorization.UserId == Guid.Empty || authorization.User == null || string.IsNullOrEmpty(authorization.Token)) return Unauthorized();
        var session = new SidecarSessionService.BrowserSession(authorization.UserId, authorization.Token);
        var cookie = await sessions.EnsureCookieAsync(session, authorization.User!.Username,
            authorization.User.HasPermission(PermissionKind.IsAdministrator), cancellationToken);
        if (cookie == null) return Problem("Foreseerr sign-in is unavailable. Retry after checking the plugin status.", statusCode: 503);

        sessions.Forget(Request.Cookies[SidecarSessionService.CookieName]);
        Response.Cookies.Append(SidecarSessionService.CookieName, sessions.Create(session), CookieOptions());
        Response.Headers.CacheControl = "no-store";
        return Ok(new { url = Request.PathBase + "/Foreseerr/", mint = true });
    }

    [AcceptVerbs("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS")]
    [Route("Foreseerr")]
    [Route("Foreseerr/{**path}")]
    [AllowAnonymous] // Opaque browser ticket is validated against Jellyfin below.
    public async Task<IActionResult> Proxy(string? path, CancellationToken cancellationToken)
    {
        if (!IsSafeMethod(Request.Method) && !IsSameOrigin(Request))
            return StatusCode(StatusCodes.Status403Forbidden);
        if (HttpContext.WebSockets.IsWebSocketRequest)
            return StatusCode(StatusCodes.Status501NotImplemented);
        var authenticated = await sessions.AuthenticateAsync(Request).ConfigureAwait(false);
        if (authenticated == null)
        {
            Response.Cookies.Delete(SidecarSessionService.CookieName, CookieOptions());
            if (HttpMethods.IsGet(Request.Method) && Request.Headers.Accept.ToString().Contains("text/html", StringComparison.Ordinal))
            {
                Response.StatusCode = StatusCodes.Status401Unauthorized;
                Response.Headers.CacheControl = "no-store";
                var jellyfinUrl = HtmlEncoder.Default.Encode(Request.PathBase + "/web/index.html");
                return Content($"<!doctype html><html lang=\"en\"><head><meta name=\"viewport\" content=\"width=device-width\"><title>Sign in to Foreseerr</title></head><body><main><h1>Sign in through Jellyfin</h1><p>Open Foreseerr from Jellyfin to start a new session.</p><a href=\"{jellyfinUrl}\">Return to Jellyfin</a></main></body></html>", "text/html");
            }
            return Unauthorized(new { message = "Open Foreseerr from Jellyfin to sign in." });
        }

        var (session, authorization) = authenticated.Value;
        var cookie = await sessions.EnsureCookieAsync(session, authorization.User!.Username,
            authorization.User.HasPermission(PermissionKind.IsAdministrator), cancellationToken);
        if (cookie == null) return StatusCode(StatusCodes.Status503ServiceUnavailable);

        // These routes can replace a Foreseerr identity independently of Jellyfin.
        // Keep the mint endpoint private even to authenticated browser sessions.
        var route = (path ?? "").TrimEnd('/');
        if (route.StartsWith("api/v1/auth/", StringComparison.OrdinalIgnoreCase)
            && !route.Equals("api/v1/auth/me", StringComparison.OrdinalIgnoreCase)
            && !route.Equals("api/v1/auth/logout", StringComparison.OrdinalIgnoreCase))
            return NotFound();

        // The upstream always uses a fixed origin and mount. Request.PathBase
        // belongs to Jellyfin and is deliberately not part of the sidecar path.
        using var upstream = new HttpRequestMessage(new HttpMethod(Request.Method),
            supervisor.Origin + Request.Path + Request.QueryString);
        if (Request.ContentLength is > 0 || Request.Headers.ContainsKey("Transfer-Encoding"))
            upstream.Content = new StreamContent(Request.Body);
        var excluded = ConnectionHeaders(Request.Headers.Connection.ToString());
        foreach (var header in Request.Headers)
        {
            if (excluded.Contains(header.Key) || IsCredentialHeader(header.Key)) continue;
            if (!upstream.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray()) && upstream.Content != null)
                upstream.Content.Headers.TryAddWithoutValidation(header.Key, header.Value.ToArray());
        }
        upstream.Headers.Add("Cookie", cookie);
        upstream.Headers.Add("X-Foreseerr-Plugin-Secret", ForeseerrPlugin.Instance!.Configuration.PluginSecret);
        upstream.Headers.Add("X-Forwarded-Proto", Request.Scheme);

        using var client = clients.CreateClient(PluginServiceRegistrator.SidecarHttpClient);
        HttpResponseMessage response;
        try
        {
            response = await client.SendAsync(upstream, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        }
        catch (HttpRequestException)
        {
            return StatusCode(StatusCodes.Status502BadGateway);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return StatusCode(StatusCodes.Status504GatewayTimeout);
        }
        using (response)
        {
            if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized
                || (response.StatusCode == System.Net.HttpStatusCode.Forbidden
                    && route.Equals("api/v1/auth/me", StringComparison.OrdinalIgnoreCase))) session.Cookie = null;
            if (route.Equals("api/v1/auth/logout", StringComparison.OrdinalIgnoreCase) && response.IsSuccessStatusCode)
            {
                sessions.Forget(Request.Cookies[SidecarSessionService.CookieName]);
                Response.Cookies.Delete(SidecarSessionService.CookieName, CookieOptions());
            }
            Response.StatusCode = (int)response.StatusCode;
            var responseExcluded = ConnectionHeaders(string.Join(",", response.Headers.Connection));
            foreach (var header in response.Headers.Concat(response.Content.Headers))
            {
                if (responseExcluded.Contains(header.Key) || header.Key.Equals("Set-Cookie", StringComparison.OrdinalIgnoreCase)) continue;
                Response.Headers[header.Key] = header.Value.ToArray();
            }
            // Authenticated content must never be shared by an intermediary cache.
            Response.Headers.CacheControl = "no-store";
            await response.Content.CopyToAsync(Response.Body, cancellationToken);
        }
        return new EmptyResult();
    }

    private CookieOptions CookieOptions() => new()
    {
        Path = Request.PathBase + "/Foreseerr",
        HttpOnly = true,
        Secure = Request.IsHttps,
        SameSite = SameSiteMode.Strict,
        MaxAge = SidecarSessionService.Lifetime,
        IsEssential = true,
    };

    internal static bool IsSafeMethod(string method) => method is "GET" or "HEAD" or "OPTIONS";

    internal static bool IsSameOrigin(HttpRequest request)
    {
        // Fetch Metadata comes from the browser itself, so it stays correct behind
        // a TLS-terminating proxy that Jellyfin sees as http:// or a rewritten Host.
        var site = request.Headers["Sec-Fetch-Site"].ToString();
        if (site.Length > 0) return site == "same-origin";
        return Uri.TryCreate(request.Headers.Origin.ToString(), UriKind.Absolute, out var origin)
            && Uri.TryCreate($"{request.Scheme}://{request.Host}", UriKind.Absolute, out var expected)
            && origin.GetLeftPart(UriPartial.Authority) == expected.GetLeftPart(UriPartial.Authority);
    }

    private static HashSet<string> ConnectionHeaders(string connection)
    {
        var result = new HashSet<string>(HopByHop, StringComparer.OrdinalIgnoreCase);
        foreach (var name in connection.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)) result.Add(name);
        return result;
    }

    private static bool IsCredentialHeader(string name) =>
        name.Equals("Cookie", StringComparison.OrdinalIgnoreCase)
        || name.Equals("Authorization", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("X-Api-", StringComparison.OrdinalIgnoreCase)
        || name.Equals("X-Emby-Token", StringComparison.OrdinalIgnoreCase)
        || name.Equals("X-MediaBrowser-Token", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("X-Foreseerr-", StringComparison.OrdinalIgnoreCase)
        || name.StartsWith("X-Forwarded-", StringComparison.OrdinalIgnoreCase)
        || name.Equals("Forwarded", StringComparison.OrdinalIgnoreCase);
}
