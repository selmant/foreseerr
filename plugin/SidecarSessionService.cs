using System.Net.Http.Json;
using Microsoft.Extensions.Logging;

namespace Foreseerr.Jellyfin;

public class SidecarSessionService
{
    private readonly SidecarSupervisor _supervisor;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<SidecarSessionService> _logger;
    private readonly Dictionary<Guid, string> _cookies = new();
    private readonly SemaphoreSlim _gate = new(1, 1);

    public SidecarSessionService(
        SidecarSupervisor supervisor,
        IHttpClientFactory httpClientFactory,
        ILogger<SidecarSessionService> logger)
    {
        _supervisor = supervisor;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public async Task<string?> EnsureCookieAsync(
        Guid jellyfinUserId,
        string username,
        bool isAdmin,
        string? jellyfinAccessToken,
        CancellationToken cancellationToken)
    {
        await _gate.WaitAsync(cancellationToken);
        try
        {
            if (_cookies.TryGetValue(jellyfinUserId, out var existing) && !string.IsNullOrEmpty(existing))
            {
                return existing;
            }

            var cookie = await MintAsync(
                jellyfinUserId,
                username,
                isAdmin,
                jellyfinAccessToken,
                cancellationToken);
            if (!string.IsNullOrEmpty(cookie))
            {
                _cookies[jellyfinUserId] = cookie;
            }

            return cookie;
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Forget(Guid jellyfinUserId) => _cookies.Remove(jellyfinUserId);

    private async Task<string?> MintAsync(
        Guid jellyfinUserId,
        string username,
        bool isAdmin,
        string? jellyfinAccessToken,
        CancellationToken cancellationToken)
    {
        var secret = ForeseerrPlugin.Instance?.Configuration.PluginSecret;
        if (string.IsNullOrEmpty(secret))
        {
            return null;
        }

        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var userId = jellyfinUserId.ToString("D");
        var payload = new
        {
            jellyfinUserId = userId,
            jellyfinUsername = username,
            jellyfinAccessToken,
            isAdministrator = isAdmin,
            timestamp,
            signature = PluginHmac.Sign(secret, userId, timestamp),
        };

        var client = _httpClientFactory.CreateClient(PluginServiceRegistrator.SidecarHttpClient);
        client.Timeout = TimeSpan.FromSeconds(15);
        using var request = new HttpRequestMessage(
            HttpMethod.Post,
            $"{_supervisor.Origin}/Foreseerr/api/v1/auth/jellyfin/plugin")
        {
            Content = JsonContent.Create(payload),
        };
        request.Headers.TryAddWithoutValidation("X-Foreseerr-Plugin-Secret", secret);

        using var response = await client.SendAsync(request, cancellationToken);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Content.ReadAsStringAsync(cancellationToken);
            _logger.LogWarning(
                "Foreseerr plugin mint failed: {Status} {Body}",
                (int)response.StatusCode,
                body);
            return await TryQuickConnectFallback(username, cancellationToken);
        }

        return ReadSessionCookie(response);
    }

    private async Task<string?> TryQuickConnectFallback(string username, CancellationToken cancellationToken)
    {
        try
        {
            var client = _httpClientFactory.CreateClient(PluginServiceRegistrator.SidecarHttpClient);
            using var initiate = await client.PostAsync(
                $"{_supervisor.Origin}/Foreseerr/api/v1/auth/jellyfin/quickconnect/initiate",
                null,
                cancellationToken);
            if (!initiate.IsSuccessStatusCode)
            {
                return null;
            }

            _logger.LogInformation(
                "Foreseerr plugin mint failed; Quick Connect is available as a browser fallback for {User}",
                username);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Quick Connect fallback probe failed");
        }

        return null;
    }

    private static string? ReadSessionCookie(HttpResponseMessage response)
    {
        if (!response.Headers.TryGetValues("Set-Cookie", out var headers))
        {
            return null;
        }

        foreach (var header in headers)
        {
            var pair = header.Split(';', 2)[0];
            var eq = pair.IndexOf('=');
            if (eq <= 0)
            {
                continue;
            }

            var name = pair[..eq];
            var value = pair[(eq + 1)..];
            if (name.Equals("XSRF-TOKEN", StringComparison.OrdinalIgnoreCase)
                || name.Equals("_csrf", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (value.StartsWith("s%3A", StringComparison.Ordinal)
                || value.StartsWith("s:", StringComparison.Ordinal)
                || name.Contains("sid", StringComparison.OrdinalIgnoreCase)
                || name.Equals("connect.sid", StringComparison.OrdinalIgnoreCase))
            {
                return $"{name}={value}";
            }
        }

        return null;
    }
}
