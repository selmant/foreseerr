using System.Net.Http.Json;
using System.Security.Cryptography;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

namespace Foreseerr.Jellyfin;

/// <summary>
/// Browser tickets are opaque and scoped to a single Jellyfin login. Neither
/// Jellyfin tokens nor the sidecar's session cookie are exposed to JavaScript.
/// Jellyfin revalidates its token on every request, including after logout.
/// </summary>
public sealed class SidecarSessionService : IDisposable
{
    public const string CookieName = "Foreseerr.Session";
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(8);
    private readonly MemoryCache _tickets = new(new MemoryCacheOptions { SizeLimit = 1024 });
    private readonly SidecarSupervisor _supervisor;
    private readonly IHttpClientFactory _clients;
    private readonly IAuthService _auth;
    private readonly ILogger<SidecarSessionService> _logger;

    public SidecarSessionService(SidecarSupervisor supervisor, IHttpClientFactory clients,
        IAuthService auth, ILogger<SidecarSessionService> logger)
    {
        _supervisor = supervisor;
        _clients = clients;
        _auth = auth;
        _logger = logger;
    }

    public sealed class BrowserSession(Guid userId, string token)
    {
        public Guid UserId { get; } = userId;
        public string Token { get; } = token;
        public string? Cookie { get; set; }
        public Guid Generation { get; set; }
        public SemaphoreSlim Gate { get; } = new(1, 1);
    }

    public string Create(BrowserSession session)
    {
        var ticket = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        _tickets.Set(ticket, session, new MemoryCacheEntryOptions
        {
            AbsoluteExpirationRelativeToNow = Lifetime,
            Size = 1,
        });
        return ticket;
    }

    public void Forget(string? ticket)
    {
        if (!string.IsNullOrEmpty(ticket)) _tickets.Remove(ticket);
    }

    public async Task<(BrowserSession Session, AuthorizationInfo Authorization)?> AuthenticateAsync(HttpRequest request)
    {
        var ticket = request.Cookies[CookieName];
        if (string.IsNullOrEmpty(ticket) || !_tickets.TryGetValue<BrowserSession>(ticket, out var session)
            || session == null) return null;

        // Use a separate context so browser headers and Jellyfin's cached
        // authorization info cannot override the token bound to this ticket.
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = request.HttpContext.Connection.RemoteIpAddress;
        // Jellyfin 12 disables legacy X-Emby-Token auth by default.
        context.Request.Headers.Authorization = $"MediaBrowser Token=\"{session.Token}\"";
        try
        {
            var authorization = await _auth.Authenticate(context.Request).ConfigureAwait(false);
            if (authorization.IsAuthenticated && !authorization.IsApiKey && authorization.User != null
                && authorization.UserId == session.UserId)
                return (session, authorization);
        }
        catch (MediaBrowser.Controller.Authentication.AuthenticationException)
        {
            // Expired or revoked Jellyfin session.
        }
        catch (MediaBrowser.Controller.Net.SecurityException)
        {
            // User disabled or denied by Jellyfin's access policy.
        }

        Forget(ticket);
        return null;
    }

    public async Task<string?> EnsureCookieAsync(BrowserSession session, string username,
        bool isAdmin, CancellationToken cancellationToken)
    {
        await session.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (session.Cookie != null && session.Generation == _supervisor.Generation)
                return session.Cookie;
            var generation = _supervisor.Generation;
            var secret = ForeseerrPlugin.Instance?.Configuration.PluginSecret;
            if (string.IsNullOrEmpty(secret) || !_supervisor.IsReady) return null;
            var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            // Compact form, as returned by the Jellyfin API.
            var userId = session.UserId.ToString("N");
            using var request = new HttpRequestMessage(HttpMethod.Post,
                $"{_supervisor.Origin}/Foreseerr/api/v1/auth/jellyfin/plugin")
            {
                Content = JsonContent.Create(new
                {
                    jellyfinUserId = userId,
                    jellyfinUsername = username,
                    jellyfinAccessToken = session.Token,
                    isAdministrator = isAdmin,
                    timestamp,
                    signature = PluginHmac.Sign(secret, userId, timestamp),
                }),
            };
            request.Headers.Add("X-Foreseerr-Plugin-Secret", secret);
            request.Headers.Add("X-Foreseerr-Mint", "1");
            var client = _clients.CreateClient(PluginServiceRegistrator.SidecarHttpClient);
            using var response = await client.SendAsync(request, cancellationToken).ConfigureAwait(false);
            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("Foreseerr sign-in failed with status {Status}", (int)response.StatusCode);
                return null;
            }

            if (!response.Headers.TryGetValues("Set-Cookie", out var headers)) return null;
            session.Cookie = headers.Select(header => header.Split(';', 2)[0])
                .FirstOrDefault(pair => pair.StartsWith("connect.sid=", StringComparison.Ordinal));
            session.Generation = generation;
            return session.Cookie;
        }
        catch (HttpRequestException)
        {
            return null;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return null;
        }
        finally
        {
            session.Gate.Release();
        }
    }

    public void Dispose() => _tickets.Dispose();
}
