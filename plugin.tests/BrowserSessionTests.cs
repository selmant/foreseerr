using System.Reflection;
using Foreseerr.Jellyfin;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace Foreseerr.Jellyfin.Tests;

public class BrowserSessionTests
{
    private const string Token = "jellyfin-login-token";

    private sealed class FakeAuth : IAuthService
    {
        public User User { get; } = new("alice", "provider", "reset");
        public Dictionary<string, User> OtherUsers { get; } = [];
        public HashSet<string> Revoked { get; } = [];
        public bool ApiKey { get; set; }
        public int Calls { get; private set; }
        public Task<AuthorizationInfo> Authenticate(HttpRequest request)
        {
            Calls++;
            var header = request.Headers.Authorization.ToString();
            Assert.StartsWith("MediaBrowser Token=\"", header, StringComparison.Ordinal);
            Assert.DoesNotContain("attacker", header, StringComparison.Ordinal);
            Assert.False(request.Headers.ContainsKey("X-Emby-Token"));
            var token = header["MediaBrowser Token=\"".Length..^1];
            if (Revoked.Contains(token)) throw new SecurityException("Invalid token");
            return Task.FromResult(new AuthorizationInfo
            {
                IsAuthenticated = true, User = OtherUsers.GetValueOrDefault(token, User), Token = token, IsApiKey = ApiKey,
            });
        }
    }

    private sealed class ManualTime : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = DateTimeOffset.UnixEpoch;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    public class ServerHost : DispatchProxy
    {
        protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) =>
            targetMethod?.Name == "get_SystemId" ? "0123456789abcdef0123456789abcdef" : throw new NotSupportedException();
    }

    private static SidecarSessionService Create(FakeAuth auth, TimeProvider? time = null) =>
        new(null!, null!, auth, NullLogger<SidecarSessionService>.Instance) { Time = time ?? TimeProvider.System };

    private static string SignIn(SidecarSessionService sessions, Guid userId, string token = Token) =>
        sessions.Issue(sessions.SessionFor(userId, token));

    private static HttpRequest Request(string ticket)
    {
        var request = new DefaultHttpContext().Request;
        request.Headers.Cookie = $"{SidecarSessionService.CookieName}={ticket}";
        // These must not influence which identity is validated.
        request.Headers["X-Emby-Token"] = "attacker-token";
        request.Headers.Authorization = "MediaBrowser Token=\"attacker-token\"";
        return request;
    }

    private static ForeseerrProxyController Controller(SidecarSessionService sessions, FakeAuth auth, HttpContext context) =>
        new(null!, sessions, null!, auth, null!, DispatchProxy.Create<IServerApplicationHost, ServerHost>())
        {
            ControllerContext = new ControllerContext { HttpContext = context },
        };

    [Fact]
    public async Task BrowserNavigationRevalidatesBoundJellyfinTokenEveryTime()
    {
        var auth = new FakeAuth();
        var sessions = Create(auth);
        var ticket = SignIn(sessions, auth.User.Id);
        Assert.DoesNotContain(Token, ticket, StringComparison.Ordinal);
        Assert.NotNull(await sessions.AuthenticateAsync(Request(ticket)));
        Assert.NotNull(await sessions.AuthenticateAsync(Request(ticket)));
        Assert.Equal(2, auth.Calls);
    }

    [Fact]
    public async Task RevokedJellyfinSessionPermanentlyInvalidatesBrowserTicket()
    {
        var auth = new FakeAuth();
        var sessions = Create(auth);
        var ticket = SignIn(sessions, auth.User.Id);
        Assert.NotNull(await sessions.AuthenticateAsync(Request(ticket)));
        auth.Revoked.Add(Token);
        Assert.Null(await sessions.AuthenticateAsync(Request(ticket)));
        auth.Revoked.Clear();
        Assert.Null(await sessions.AuthenticateAsync(Request(ticket)));
        Assert.Equal(2, auth.Calls);
    }

    [Fact]
    public async Task StaticContentReusesARecentValidationOnly()
    {
        var auth = new FakeAuth();
        var time = new ManualTime();
        var sessions = Create(auth, time);
        var ticket = SignIn(sessions, auth.User.Id);
        Assert.NotNull(await sessions.AuthenticateAsync(Request(ticket)));
        Assert.NotNull(await sessions.AuthenticateAsync(Request(ticket), staticContent: true));
        Assert.Equal(1, auth.Calls);
        // Pages and API calls always revalidate.
        Assert.NotNull(await sessions.AuthenticateAsync(Request(ticket)));
        Assert.Equal(2, auth.Calls);
        time.Now += SidecarSessionService.StaticValidationWindow;
        Assert.NotNull(await sessions.AuthenticateAsync(Request(ticket), staticContent: true));
        Assert.Equal(3, auth.Calls);
        // A failed revalidation also ends static access.
        auth.Revoked.Add(Token);
        Assert.Null(await sessions.AuthenticateAsync(Request(ticket)));
        Assert.Null(await sessions.AuthenticateAsync(Request(ticket), staticContent: true));
    }

    [Fact]
    public async Task TicketsExpire()
    {
        var auth = new FakeAuth();
        var time = new ManualTime();
        var sessions = Create(auth, time);
        var ticket = SignIn(sessions, auth.User.Id);
        time.Now += SidecarSessionService.Lifetime;
        Assert.Null(await sessions.AuthenticateAsync(Request(ticket)));
        Assert.Equal(0, auth.Calls);
    }

    [Fact]
    public async Task SigningInAgainRotatesTheLoginsTicket()
    {
        var auth = new FakeAuth();
        var sessions = Create(auth);
        var session = sessions.SessionFor(auth.User.Id, Token);
        var first = sessions.Issue(session);
        // The same Jellyfin login reuses its session and Foreseerr cookie.
        Assert.Same(session, sessions.SessionFor(auth.User.Id, Token));
        var second = sessions.Issue(session);
        Assert.NotEqual(first, second);
        Assert.Null(await sessions.AuthenticateAsync(Request(first)));
        Assert.NotNull(await sessions.AuthenticateAsync(Request(second)));
    }

    [Fact]
    public async Task LogoutDoesNotInvalidateOtherDeviceSessions()
    {
        var auth = new FakeAuth();
        var sessions = Create(auth);
        var first = SignIn(sessions, auth.User.Id, "device-one");
        var second = SignIn(sessions, auth.User.Id, "device-two");
        sessions.Forget(first);
        Assert.Null(await sessions.AuthenticateAsync(Request(first)));
        Assert.NotNull(await sessions.AuthenticateAsync(Request(second)));
        auth.Revoked.Add("device-one");
        Assert.NotNull(await sessions.AuthenticateAsync(Request(second)));
    }

    [Fact]
    public async Task OneUserCannotEvictOtherUsersTickets()
    {
        var auth = new FakeAuth();
        var time = new ManualTime();
        var sessions = Create(auth, time);
        var bob = new User("bob", "provider", "reset");
        auth.OtherUsers["bystander"] = bob;
        var bystander = SignIn(sessions, bob.Id, "bystander");
        var tickets = new List<string>();
        for (var i = 0; i < 2000; i++)
        {
            time.Now += TimeSpan.FromMilliseconds(1);
            tickets.Add(SignIn(sessions, auth.User.Id, $"login-{i}"));
        }

        Assert.NotNull(await sessions.AuthenticateAsync(Request(bystander)));
        // Only the user's own oldest logins were dropped.
        Assert.Null(await sessions.AuthenticateAsync(Request(tickets[^(SidecarSessionService.MaxLoginsPerUser + 1)])));
        Assert.Equal(1, auth.Calls);
        foreach (var ticket in tickets.TakeLast(SidecarSessionService.MaxLoginsPerUser))
            Assert.NotNull(await sessions.AuthenticateAsync(Request(ticket)));
    }

    [Fact]
    public async Task ApiKeysAndChangedUsersCannotUseBrowserTickets()
    {
        var auth = new FakeAuth { ApiKey = true };
        var sessions = Create(auth);
        var ticket = SignIn(sessions, auth.User.Id);
        Assert.Null(await sessions.AuthenticateAsync(Request(ticket)));
        auth.ApiKey = false;
        ticket = SignIn(sessions, Guid.NewGuid());
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
        var sessions = Create(auth);
        var context = new DefaultHttpContext();
        context.Request.Method = "POST";
        context.Request.Scheme = scheme;
        context.Request.Host = new HostString("jellyfin.test");
        context.Request.Headers.Origin = origin;
        if (fetchSite.Length > 0) context.Request.Headers["Sec-Fetch-Site"] = fetchSite;
        var result = await Controller(sessions, auth, context).Proxy("api/v1/request", CancellationToken.None);
        var actual = result is StatusCodeResult code ? code.StatusCode : ((ObjectResult)result).StatusCode;
        Assert.Equal(status, actual);
        Assert.Equal(0, auth.Calls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task PageNavigationWithoutTicketGetsTheSignInPage(bool staleTicket)
    {
        var auth = new FakeAuth();
        var sessions = Create(auth);
        var context = new DefaultHttpContext();
        context.Request.Method = "GET";
        context.Request.PathBase = "/jellyfin";
        context.Request.Headers.Accept = "text/html";
        if (staleTicket) context.Request.Headers.Cookie = $"{SidecarSessionService.CookieName}=stale";
        var result = await Controller(sessions, auth, context).Proxy("movie/603", CancellationToken.None);
        var page = Assert.IsType<ContentResult>(result);
        Assert.Equal(401, context.Response.StatusCode);
        Assert.Contains("data-server-id=\"0123456789abcdef0123456789abcdef\"", page.Content, StringComparison.Ordinal);
        Assert.Contains("data-sso=\"/jellyfin/Foreseerr/sso\"", page.Content, StringComparison.Ordinal);
        var nonce = context.Response.Headers.ContentSecurityPolicy.ToString().Split("'nonce-")[1].Split('\'')[0];
        Assert.Contains($"<script nonce=\"{nonce}\">", page.Content, StringComparison.Ordinal);
        // A cross-site navigation omits a still-valid SameSite=Strict cookie; keep it.
        Assert.Equal(staleTicket, context.Response.Headers.SetCookie.ToString().Contains(SidecarSessionService.CookieName, StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("assets/index-abc.js", true)]
    [InlineData("imageproxy/tmdb/t/p/w300/x.jpg", true)]
    [InlineData("avatarproxy/0123456789abcdef0123456789abcdef", true)]
    [InlineData("api/v1/auth/me", false)]
    [InlineData("api/v1/export.csv", false)]
    [InlineData("movie/603", false)]
    [InlineData("index.html", false)]
    [InlineData("", false)]
    public void OnlyStaticContentMayReuseAValidation(string route, bool expected) =>
        Assert.Equal(expected, ForeseerrProxyController.IsStaticContent(route));

    [Theory]
    [InlineData("https://host", null, "/jellyfin", "https://host/jellyfin")]
    [InlineData("https://host/jellyfin/", null, "/jellyfin", "https://host/jellyfin")]
    [InlineData("https://host", null, "", "https://host")]
    [InlineData(null, new[] { "internal=http://192.168.1.2:8096", "all=https://public.test" }, "", "https://public.test")]
    [InlineData(null, new[] { "external=https://public.test" }, "/jf", "https://public.test/jf")]
    [InlineData(null, new[] { "10.0.0.0/8=http://lan.test" }, "", "")]
    [InlineData("  ", null, "/jellyfin", "")]
    public void PublicUrlIncludesJellyfinsBasePath(string? configured, string[]? published, string basePath, string expected) =>
        Assert.Equal(expected, JellyfinHostBootstrap.PublicUrl(configured, published, basePath));

    [Theory]
    [InlineData("", null)]
    [InlineData(" https://host/jellyfin/ ", "https://host/jellyfin")]
    [InlineData("http://host:8096", "http://host:8096")]
    public void PublicServerUrlIsNormalized(string value, string? expected) =>
        Assert.Equal(expected, PluginConfiguration.NormalizePublicServerUrl(value));

    [Theory]
    [InlineData("jellyfin.example.com")]
    [InlineData("javascript:alert(1)")]
    [InlineData("https://user:pass@host")]
    [InlineData("https://host/?next=x")]
    public void InvalidPublicServerUrlIsRejected(string value) =>
        Assert.Throws<ArgumentException>(() => PluginConfiguration.NormalizePublicServerUrl(value));
}
