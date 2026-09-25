using Foreseerr.Jellyfin;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Foreseerr.Jellyfin.Tests;

public class BrowserSessionTests
{
    private sealed class FakeAuth : IAuthService
    {
        public User User { get; } = new("alice", "provider", "reset");
        public bool Revoked { get; set; }
        public bool ApiKey { get; set; }
        public int Calls { get; private set; }
        public Task<AuthorizationInfo> Authenticate(HttpRequest request)
        {
            Calls++;
            Assert.Equal("MediaBrowser Token=\"jellyfin-login-token\"", request.Headers.Authorization.ToString());
            Assert.False(request.Headers.ContainsKey("X-Emby-Token"));
            if (Revoked) throw new SecurityException("Invalid token");
            return Task.FromResult(new AuthorizationInfo
            {
                IsAuthenticated = true, User = User,
                Token = "jellyfin-login-token", IsApiKey = ApiKey,
            });
        }
    }

    private static SidecarSessionService Create(FakeAuth auth) =>
        new(null!, null!, auth, NullLogger<SidecarSessionService>.Instance);

    private static HttpRequest Request(string ticket)
    {
        var request = new DefaultHttpContext().Request;
        request.Headers.Cookie = $"{SidecarSessionService.CookieName}={ticket}";
        // These must not influence which identity is validated.
        request.Headers["X-Emby-Token"] = "attacker-token";
        request.Headers.Authorization = "MediaBrowser Token=\"attacker-token\"";
        return request;
    }

    [Fact]
    public async Task BrowserNavigationRevalidatesBoundJellyfinTokenEveryTime()
    {
        var auth = new FakeAuth();
        using var sessions = Create(auth);
        var ticket = sessions.Create(new(auth.User.Id, "jellyfin-login-token"));
        Assert.DoesNotContain("jellyfin-login-token", ticket);
        Assert.NotNull(await sessions.AuthenticateAsync(Request(ticket)));
        Assert.NotNull(await sessions.AuthenticateAsync(Request(ticket)));
        Assert.Equal(2, auth.Calls);
    }

    [Fact]
    public async Task RevokedJellyfinSessionPermanentlyInvalidatesBrowserTicket()
    {
        var auth = new FakeAuth();
        using var sessions = Create(auth);
        var ticket = sessions.Create(new(auth.User.Id, "jellyfin-login-token"));
        Assert.NotNull(await sessions.AuthenticateAsync(Request(ticket)));
        auth.Revoked = true;
        Assert.Null(await sessions.AuthenticateAsync(Request(ticket)));
        auth.Revoked = false;
        Assert.Null(await sessions.AuthenticateAsync(Request(ticket)));
        Assert.Equal(2, auth.Calls);
    }

    [Fact]
    public async Task LogoutDoesNotInvalidateOtherDeviceSessions()
    {
        var auth = new FakeAuth();
        using var sessions = Create(auth);
        var first = sessions.Create(new(auth.User.Id, "jellyfin-login-token"));
        var second = sessions.Create(new(auth.User.Id, "jellyfin-login-token"));
        sessions.Forget(first);
        Assert.Null(await sessions.AuthenticateAsync(Request(first)));
        Assert.NotNull(await sessions.AuthenticateAsync(Request(second)));
    }

    [Fact]
    public async Task ApiKeysAndChangedUsersCannotUseBrowserTickets()
    {
        var auth = new FakeAuth { ApiKey = true };
        using var sessions = Create(auth);
        var ticket = sessions.Create(new(auth.User.Id, "jellyfin-login-token"));
        Assert.Null(await sessions.AuthenticateAsync(Request(ticket)));
        auth.ApiKey = false;
        ticket = sessions.Create(new(Guid.NewGuid(), "jellyfin-login-token"));
        Assert.Null(await sessions.AuthenticateAsync(Request(ticket)));
    }

    [Theory]
    [InlineData("https", "https://evil.test", "", 403)]
    [InlineData("https", "null", "", 403)]
    [InlineData("https", "", "", 403)]
    [InlineData("https", "https://jellyfin.test", "", 401)]
    // TLS-terminating proxy without Known Proxies: Jellyfin sees http://.
    [InlineData("http", "https://jellyfin.test", "", 403)]
    [InlineData("http", "https://jellyfin.test", "same-origin", 401)]
    [InlineData("https", "https://jellyfin.test", "same-site", 403)]
    [InlineData("https", "https://jellyfin.test", "cross-site", 403)]
    public async Task CrossOriginWritesAreRejectedBeforeAuthentication(
        string scheme, string origin, string fetchSite, int status)
    {
        var auth = new FakeAuth();
        using var sessions = Create(auth);
        var context = new DefaultHttpContext();
        context.Request.Method = "POST";
        context.Request.Scheme = scheme;
        context.Request.Host = new HostString("jellyfin.test");
        context.Request.Headers.Origin = origin;
        if (fetchSite.Length > 0) context.Request.Headers["Sec-Fetch-Site"] = fetchSite;
        var controller = new ForeseerrProxyController(null!, sessions, null!, auth)
        {
            ControllerContext = new ControllerContext { HttpContext = context },
        };
        var result = await controller.Proxy("api/v1/request", CancellationToken.None);
        var actual = result is StatusCodeResult code ? code.StatusCode : ((ObjectResult)result).StatusCode;
        Assert.Equal(status, actual);
        Assert.Equal(0, auth.Calls);
    }
}
