using System.Reflection;
using System.Security.Cryptography;
using System.Text.Encodings.Web;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller;
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
    IAuthService auth,
    JellyfinHostBootstrap bootstrap,
    IServerApplicationHost appHost) : ControllerBase
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
        sidecarPort = supervisor.Port,
        version = typeof(ForeseerrPlugin).Assembly.GetName().Version?.ToString(),
        publicUrl = bootstrap.PublicUrl(),
        headerButton = FileTransformationHostedService.Registered,
    });

    [HttpPost("Foreseerr/sso")]
    [Authorize]
    public async Task<IActionResult> Sso(CancellationToken cancellationToken)
    {
        var authorization = await auth.Authenticate(Request).ConfigureAwait(false);
        if (!authorization.IsAuthenticated || authorization.IsApiKey
            || authorization.UserId == Guid.Empty || authorization.User == null || string.IsNullOrEmpty(authorization.Token)) return Unauthorized();
        var session = sessions.SessionFor(authorization.UserId, authorization.Token);
        var cookie = await sessions.EnsureCookieAsync(session, authorization.User!.Username,
            authorization.User.HasPermission(PermissionKind.IsAdministrator), cancellationToken);
        if (cookie == null) return Problem("Foreseerr sign-in is unavailable. Retry after checking the plugin status.", statusCode: 503);

        sessions.Forget(Request.Cookies[SidecarSessionService.CookieName]);
        Response.Cookies.Append(SidecarSessionService.CookieName, sessions.Issue(session), CookieOptions());
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
        var route = (path ?? "").TrimEnd('/');
        var authenticated = await sessions.AuthenticateAsync(Request, IsStaticContent(route)).ConfigureAwait(false);
        if (authenticated == null)
        {
            // Only clear a ticket the browser sent. A cross-site navigation
            // omits the SameSite=Strict cookie that the browser still holds.
            if (Request.Cookies.ContainsKey(SidecarSessionService.CookieName))
                Response.Cookies.Delete(SidecarSessionService.CookieName, CookieOptions());
            if (HttpMethods.IsGet(Request.Method) && Request.Headers.Accept.ToString().Contains("text/html", StringComparison.Ordinal))
                return SignInPage();
            return Unauthorized(new { message = "Open Foreseerr from Jellyfin to sign in." });
        }

        var (session, authorization) = authenticated.Value;
        var cookie = await sessions.EnsureCookieAsync(session, authorization.User!.Username,
            authorization.User.HasPermission(PermissionKind.IsAdministrator), cancellationToken);
        if (cookie == null) return StatusCode(StatusCodes.Status503ServiceUnavailable);

        // These routes can replace a Foreseerr identity independently of Jellyfin.
        // Keep the mint endpoint private even to authenticated browser sessions.
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
                    && route.Equals("api/v1/auth/me", StringComparison.OrdinalIgnoreCase)))
                SidecarSessionService.ResetCookie(session);
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

    /// <summary>
    /// Signs in with the browser's Jellyfin Web login, then reloads the
    /// requested page. Links from notifications and bookmarks land here.
    /// </summary>
    private ContentResult SignInPage()
    {
        var nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(16));
        Response.StatusCode = StatusCodes.Status401Unauthorized;
        Response.Headers.CacheControl = "no-store";
        Response.Headers.ContentSecurityPolicy =
            $"default-src 'none'; script-src 'nonce-{nonce}'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
        var html = HtmlEncoder.Default;
        return Content(SignInHtml
            .Replace("{nonce}", nonce, StringComparison.Ordinal)
            .Replace("{serverId}", html.Encode(appHost.SystemId), StringComparison.Ordinal)
            .Replace("{sso}", html.Encode(Request.PathBase + "/Foreseerr/sso"), StringComparison.Ordinal)
            .Replace("{jellyfin}", html.Encode(Request.PathBase + "/web/index.html"), StringComparison.Ordinal),
            "text/html");
    }

    private const string SignInHtml = """
        <!doctype html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width">
        <title>Foreseerr</title>
        <style>body{font-family:system-ui,sans-serif;background:#101010;color:#ddd;display:grid;place-items:center;min-height:90vh}a{color:#00a4dc}</style>
        </head>
        <body>
        <main id="signin" data-server-id="{serverId}" data-sso="{sso}">
        <h1 id="title">Opening Foreseerr…</h1>
        <p id="message"></p>
        <a id="jellyfin" href="{jellyfin}" hidden>Open Jellyfin</a>
        </main>
        <script nonce="{nonce}">
        (function () {
          var root = document.getElementById('signin');
          function fail(message) {
            document.getElementById('title').textContent = 'Sign in through Jellyfin';
            document.getElementById('message').textContent = message;
            document.getElementById('jellyfin').hidden = false;
          }
          var token = null;
          try {
            var servers = JSON.parse(localStorage.getItem('jellyfin_credentials') || '{}').Servers || [];
            for (var i = 0; i < servers.length; i++) {
              if (servers[i].Id === root.dataset.serverId && servers[i].AccessToken) token = servers[i].AccessToken;
            }
          } catch (e) { /* no stored login */ }
          if (!token) return fail('Sign in to Jellyfin in this browser, then open this link again.');
          // A refused cookie must not turn into a reload loop.
          var attempt = location.href + ' ' + Math.floor(Date.now() / 10000);
          if (sessionStorage.getItem('foreseerr-signin') === attempt) return fail('Foreseerr could not keep its session. Allow cookies for this site and retry.');
          sessionStorage.setItem('foreseerr-signin', attempt);
          fetch(root.dataset.sso, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { Authorization: 'MediaBrowser Token="' + token + '"' }
          }).then(function (response) {
            if (response.status === 401) throw new Error('Your Jellyfin session has ended. Sign in to Jellyfin, then open this link again.');
            if (!response.ok) throw new Error('Foreseerr sign-in is unavailable. Check the plugin status in Jellyfin and retry.');
            location.replace(location.href);
          }).catch(function (error) {
            fail(error.message || 'Foreseerr sign-in is unavailable.');
          });
        })();
        </script>
        </body>
        </html>
        """;

    /// <summary>Static files and images carry no per-user data.</summary>
    internal static bool IsStaticContent(string route) =>
        route.StartsWith("imageproxy/", StringComparison.OrdinalIgnoreCase)
        || route.StartsWith("avatarproxy/", StringComparison.OrdinalIgnoreCase)
        || (!route.StartsWith("api/", StringComparison.OrdinalIgnoreCase)
            && Path.HasExtension(route)
            && !route.EndsWith(".html", StringComparison.OrdinalIgnoreCase));

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
