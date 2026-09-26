using System.Net.Http.Json;
using System.Security.Cryptography;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Foreseerr.Jellyfin;

/// <summary>
/// Browser tickets are opaque and scoped to a single Jellyfin login. Neither
/// Jellyfin tokens nor the sidecar's session cookie are exposed to JavaScript.
/// Jellyfin revalidates the bound token for every page and API request,
/// including after logout.
/// </summary>
public sealed class SidecarSessionService
{
    public const string CookieName = "Foreseerr.Session";
    public static readonly TimeSpan Lifetime = TimeSpan.FromHours(8);

    /// <summary>Jellyfin logins per user that can hold a ticket at once.</summary>
    public const int MaxLoginsPerUser = 10;

    /// <summary>How long one validation also covers static files and images.</summary>
    public static readonly TimeSpan StaticValidationWindow = TimeSpan.FromSeconds(30);

    private readonly Lock _lock = new();
    private readonly Dictionary<string, BrowserSession> _tickets = new(StringComparer.Ordinal);
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

    internal TimeProvider Time { get; init; } = TimeProvider.System;

    public sealed class BrowserSession(Guid userId, string token)
    {
        public Guid UserId { get; } = userId;
        public string Token { get; } = token;
        internal string? Ticket { get; set; }
        internal DateTimeOffset Expires { get; set; }
        internal Minted? Cookie { get; set; }
        internal Validation? Validated { get; set; }
        internal SemaphoreSlim Gate { get; } = new(1, 1);
    }

    internal sealed record Minted(string Value, Guid Generation);

    internal sealed record Validation(AuthorizationInfo Authorization, DateTimeOffset At);

    /// <summary>The session of an existing Jellyfin login, or a new one.</summary>
    public BrowserSession SessionFor(Guid userId, string token)
    {
        lock (_lock)
        {
            return _tickets.Values.FirstOrDefault(session => session.UserId == userId && session.Token == token)
                ?? new BrowserSession(userId, token);
        }
    }

    /// <summary>
    /// Issues a new ticket for the session and revokes its previous one, so a
    /// Jellyfin login holds one ticket no matter how often it signs in.
    /// </summary>
    public string Issue(BrowserSession session)
    {
        var now = Time.GetUtcNow();
        var ticket = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
        lock (_lock)
        {
            foreach (var (key, existing) in _tickets.ToList())
            {
                if (existing.Expires <= now || existing == session
                    || (existing.UserId == session.UserId && existing.Token == session.Token))
                    _tickets.Remove(key);
            }

            // A user's oldest logins give way; other users are unaffected.
            var logins = _tickets.Values.Where(existing => existing.UserId == session.UserId)
                .OrderBy(existing => existing.Expires).ToList();
            foreach (var old in logins.Take(logins.Count - (MaxLoginsPerUser - 1)))
                _tickets.Remove(old.Ticket!);

            session.Ticket = ticket;
            session.Expires = now + Lifetime;
            _tickets[ticket] = session;
        }

        return ticket;
    }

    public void Forget(string? ticket)
    {
        if (string.IsNullOrEmpty(ticket)) return;
        lock (_lock) _tickets.Remove(ticket);
    }

    /// <param name="staticContent">
    /// Static files and images may reuse a validation from the last
    /// <see cref="StaticValidationWindow"/>. Pages and API calls never do.
    /// </param>
    public async Task<(BrowserSession Session, AuthorizationInfo Authorization)?> AuthenticateAsync(
        HttpRequest request, bool staticContent = false)
    {
        var ticket = request.Cookies[CookieName];
        if (string.IsNullOrEmpty(ticket)) return null;
        var now = Time.GetUtcNow();
        BrowserSession? session;
        lock (_lock)
        {
            if (!_tickets.TryGetValue(ticket, out session)) return null;
            if (session.Expires <= now)
            {
                _tickets.Remove(ticket);
                return null;
            }
        }

        if (staticContent && session.Validated is { } recent && now - recent.At < StaticValidationWindow)
            return (session, recent.Authorization);

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
            {
                session.Validated = new Validation(authorization, now);
                return (session, authorization);
            }
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

    /// <summary>Drops the sidecar session so the next request signs in again.</summary>
    public static void ResetCookie(BrowserSession session) => session.Cookie = null;

    public async Task<string?> EnsureCookieAsync(BrowserSession session, string username,
        bool isAdmin, CancellationToken cancellationToken)
    {
        if (session.Cookie is { } minted && minted.Generation == _supervisor.Generation) return minted.Value;
        await session.Gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            var generation = _supervisor.Generation;
            if (session.Cookie is { } current && current.Generation == generation) return current.Value;
            var secret = ForeseerrPlugin.Instance?.Configuration.PluginSecret;
            if (string.IsNullOrEmpty(secret) || !_supervisor.IsReady) return null;
            using var request = new HttpRequestMessage(HttpMethod.Post,
                $"{_supervisor.Origin}/Foreseerr/api/v1/auth/jellyfin/plugin")
            {
                Content = JsonContent.Create(new
                {
                    // Compact form, as returned by the Jellyfin API.
                    jellyfinUserId = session.UserId.ToString("N"),
                    jellyfinUsername = username,
                    jellyfinAccessToken = session.Token,
                    isAdministrator = isAdmin,
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
            var cookie = headers.Select(header => header.Split(';', 2)[0])
                .FirstOrDefault(pair => pair.StartsWith("connect.sid=", StringComparison.Ordinal));
            session.Cookie = cookie == null ? null : new Minted(cookie, generation);
            return cookie;
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
}
