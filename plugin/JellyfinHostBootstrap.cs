using System.Runtime.Loader;
using Jellyfin.Data;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Configuration;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Security;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json;

namespace Foreseerr.Jellyfin;

public class JellyfinHostBootstrap
{
    private readonly IServerApplicationHost _appHost;
    private readonly ILibraryManager _libraryManager;
    private readonly IUserManager _userManager;
    private readonly IApplicationPaths _applicationPaths;
    private readonly IServiceProvider _services;
    private readonly ILogger<JellyfinHostBootstrap> _logger;

    public JellyfinHostBootstrap(
        IServerApplicationHost appHost,
        ILibraryManager libraryManager,
        IUserManager userManager,
        IApplicationPaths applicationPaths,
        IServiceProvider services,
        ILogger<JellyfinHostBootstrap> logger)
    {
        _appHost = appHost;
        _libraryManager = libraryManager;
        _userManager = userManager;
        _applicationPaths = applicationPaths;
        _services = services;
        _logger = logger;
    }

    /// <summary>Survives plugin upgrades, unlike the versioned plugin install folder.</summary>
    public string ConfigDirectory =>
        Path.Combine(_applicationPaths.PluginConfigurationsPath, "Foreseerr", "foreseerr");

    public void WriteHostFile()
    {
        Directory.CreateDirectory(ConfigDirectory);
        var plugin = ForeseerrPlugin.Instance;
        var config = plugin?.Configuration;
        config?.EnsureSecrets();
        var publicUrl = PublicUrl();

        var apiKey = EnsureApiKey();
        if (plugin != null && !string.IsNullOrEmpty(apiKey) && plugin.Configuration.ApiKeyToken != apiKey)
        {
            plugin.Configuration.ApiKeyToken = apiKey;
            plugin.SaveConfiguration();
        }

        var host = new Dictionary<string, object?>
        {
            ["main"] = new Dictionary<string, object?>
            {
                ["applicationUrl"] = publicUrl.Length > 0 ? publicUrl + "/Foreseerr" : "",
                ["mediaServerLogin"] = true,
                ["localLogin"] = false,
                ["locale"] = ResolveLocale(),
            },
            ["jellyfin"] = new Dictionary<string, object?>
            {
                ["name"] = _appHost.FriendlyName,
                ["ip"] = "127.0.0.1",
                ["port"] = GetHttpPort(),
                ["useSsl"] = false,
                ["urlBase"] = GetBasePath(),
                ["externalHostname"] = publicUrl,
                ["serverId"] = _appHost.SystemId,
                ["apiKey"] = apiKey ?? config?.ApiKeyToken ?? "",
                // null keeps Foreseerr's saved library selection.
                ["libraries"] = CollectLibraries(),
            },
        };

        if (BetterTraktPresent())
        {
            // Foreseerr only uses this when Trakt is not configured directly.
            host["trakt"] = new Dictionary<string, string> { ["provider"] = "jellyfin" };
        }

        // Jellyfin changed Users to GetUsers in a 10.11 patch release.
        // Resolve only this API boundary dynamically to support both forms.
        var managerType = typeof(IUserManager);
        var users = (managerType.GetMethod("GetUsers")?.Invoke(_userManager, null)
            ?? managerType.GetProperty("Users")?.GetValue(_userManager))
            as IEnumerable<global::Jellyfin.Database.Implementations.Entities.User>
            ?? throw new InvalidOperationException("Jellyfin user enumeration API is unavailable.");
        var admin = users.FirstOrDefault(user =>
        {
            try
            {
                return user.HasPermission(PermissionKind.IsAdministrator)
                    && !user.HasPermission(PermissionKind.IsDisabled);
            }
            catch
            {
                return false;
            }
        });
        if (admin != null)
        {
            host["adminUser"] = new Dictionary<string, string>
            {
                ["jellyfinUserId"] = admin.Id.ToString("N"),
                ["jellyfinUsername"] = admin.Username,
                ["email"] = string.IsNullOrWhiteSpace(admin.Username)
                    ? admin.Id.ToString("N")
                    : admin.Username,
            };
        }

        var path = Path.Combine(ConfigDirectory, "jellyfin-host.json");
        var temporary = path + ".tmp";
        var options = new FileStreamOptions { Mode = FileMode.Create, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows()) options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        using (var stream = new FileStream(temporary, options))
        using (var writer = new StreamWriter(stream))
            writer.Write(JsonConvert.SerializeObject(host, Formatting.Indented));
        File.Move(temporary, path, overwrite: true);
        _logger.LogInformation("Wrote Foreseerr jellyfin-host.json to {Path}", path);
    }

    private int GetHttpPort()
    {
        try
        {
            var network = ReadNetworkConfiguration();
            if (network != null)
            {
                var type = network.GetType();
                var prop =
                    type.GetProperty("InternalHttpPort")
                    ?? type.GetProperty("HttpServerPortNumber");
                if (prop?.GetValue(network) is int port && port > 0)
                {
                    return port;
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Could not read InternalHttpPort");
        }

        return 8096;
    }

    /// <summary>
    /// The Jellyfin address browsers use, including its base path, or "" when
    /// neither the plugin setting nor Jellyfin's published server URI is set.
    /// </summary>
    public string PublicUrl() =>
        PublicUrl(ForeseerrPlugin.Instance?.Configuration.PublicServerUrl,
            ReadNetworkConfiguration()?.PublishedServerUriBySubnet, GetBasePath());

    internal static string PublicUrl(string? configured, IEnumerable<string>? published, string basePath)
    {
        var url = string.IsNullOrWhiteSpace(configured) ? PublishedUrl(published) : configured;
        if (string.IsNullOrWhiteSpace(url)) return "";
        url = url.Trim().TrimEnd('/');
        // Accept both the origin and the full Jellyfin address.
        var path = Uri.TryCreate(url, UriKind.Absolute, out var uri) ? uri.AbsolutePath.TrimEnd('/') : "";
        return basePath.Length > 0 && !path.EndsWith(basePath, StringComparison.OrdinalIgnoreCase)
            ? url + basePath
            : url;
    }

    /// <summary>Jellyfin's "Published server URIs": all=URL or external=URL entries.</summary>
    private static string? PublishedUrl(IEnumerable<string>? entries) =>
        entries?
            .Select(entry => entry.Split('=', 2, StringSplitOptions.TrimEntries))
            .Where(pair => pair.Length == 2
                && (pair[0].Equals("all", StringComparison.OrdinalIgnoreCase)
                    || pair[0].Equals("external", StringComparison.OrdinalIgnoreCase))
                && Uri.TryCreate(pair[1], UriKind.Absolute, out var uri)
                && (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp))
            .Select(pair => pair[1])
            .FirstOrDefault();

    private string ResolveLocale()
    {
        try
        {
            var configManager = _services.GetService<IServerConfigurationManager>();
            var culture = configManager?.Configuration?.GetType()
                .GetProperty("UICulture")
                ?.GetValue(configManager.Configuration)
                ?.ToString();
            if (!string.IsNullOrWhiteSpace(culture))
            {
                return culture.Replace('_', '-').Split('-')[0];
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Could not read UICulture");
        }

        return "en";
    }

    private List<object>? CollectLibraries()
    {
        var libraries = new List<object>();
        try
        {
            foreach (var folder in _libraryManager.GetVirtualFolders())
            {
                var type = MapCollectionType(folder);
                if (type == null)
                {
                    continue;
                }

                var folderType = folder.GetType();
                var name = folderType.GetProperty("Name")?.GetValue(folder)?.ToString() ?? "Library";
                var itemId = folderType.GetProperty("ItemId")?.GetValue(folder)?.ToString()
                    ?? folderType.GetProperty("Id")?.GetValue(folder)?.ToString();
                libraries.Add(new
                {
                    id = string.IsNullOrEmpty(itemId) ? name : itemId,
                    name,
                    enabled = true,
                    type,
                });
            }
        }
        catch (Exception ex)
        {
            // A partial list would read as removed libraries and lose their settings.
            _logger.LogWarning(ex, "Failed to list Jellyfin libraries for Foreseerr");
            return null;
        }

        return libraries;
    }

    private static string? MapCollectionType(object folder)
    {
        var raw = folder.GetType().GetProperty("CollectionType")?.GetValue(folder)?.ToString() ?? "";
        if (raw.Contains("movie", StringComparison.OrdinalIgnoreCase)
            || string.Equals(raw, "movies", StringComparison.OrdinalIgnoreCase))
        {
            return "movie";
        }

        if (raw.Contains("tv", StringComparison.OrdinalIgnoreCase)
            || raw.Contains("show", StringComparison.OrdinalIgnoreCase))
        {
            return "show";
        }

        return null;
    }

    public static bool BetterTraktPresent()
    {
        return AssemblyLoadContext.All
            .SelectMany(context => context.Assemblies)
            .Any(assembly =>
            {
                var name = assembly.GetName().Name ?? assembly.FullName ?? "";
                return name.Contains("BetterTrakt", StringComparison.OrdinalIgnoreCase)
                    || (name.Contains("Trakt", StringComparison.OrdinalIgnoreCase)
                        && name.Contains("Better", StringComparison.OrdinalIgnoreCase));
            });
    }

    private string? EnsureApiKey()
    {
        var existing = ForeseerrPlugin.Instance?.Configuration.ApiKeyToken;
        if (!string.IsNullOrEmpty(existing))
        {
            return existing;
        }

        var manager = _services.GetService<IAuthenticationManager>();
        if (manager == null)
        {
            _logger.LogWarning("IAuthenticationManager is not available; Foreseerr API key was not created");
            return existing;
        }

        try
        {
            var token = FindForeseerrApiKey(manager);
            if (!string.IsNullOrEmpty(token))
            {
                return token;
            }

            manager.CreateApiKey("Foreseerr").GetAwaiter().GetResult();
            token = FindForeseerrApiKey(manager);
            if (!string.IsNullOrEmpty(token))
            {
                return token;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Could not create a Jellyfin API key for Foreseerr");
        }

        _logger.LogWarning("Foreseerr API key was not created; set it after first admin login if library scans fail");
        return existing;
    }

    private static string? FindForeseerrApiKey(IAuthenticationManager manager)
    {
        var keys = manager.GetApiKeys().GetAwaiter().GetResult();
        foreach (var key in keys)
        {
            if (string.Equals(key.AppName, "Foreseerr", StringComparison.OrdinalIgnoreCase)
                && !string.IsNullOrEmpty(key.AccessToken))
            {
                return key.AccessToken;
            }
        }

        return null;
    }

    private NetworkConfiguration? ReadNetworkConfiguration() =>
        _services.GetService<IServerConfigurationManager>()?.GetNetworkConfiguration();

    public string GetBasePath() =>
        (ReadNetworkConfiguration()?.BaseUrl ?? "").TrimEnd('/');
}
