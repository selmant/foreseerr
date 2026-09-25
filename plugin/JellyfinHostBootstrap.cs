using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
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
        var publicUrl = ResolvePublicUrl(config?.PublicServerUrl).TrimEnd('/');
        var basePath = "/Foreseerr";
        var applicationUrl = string.IsNullOrEmpty(publicUrl)
            ? ""
            : publicUrl + basePath;

        var apiKey = EnsureApiKey();
        if (plugin != null && !string.IsNullOrEmpty(apiKey) && plugin.Configuration.ApiKeyToken != apiKey)
        {
            plugin.Configuration.ApiKeyToken = apiKey;
            plugin.SaveConfiguration();
        }

        var mdblistKey = FirstNonEmpty(config?.MdblistApiKey, TryReadMoonbaseMdbListKey());

        var host = new Dictionary<string, object?>
        {
            ["main"] = new Dictionary<string, object?>
            {
                ["applicationUrl"] = applicationUrl,
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
                ["libraries"] = CollectLibraries(),
            },
        };

        if (BetterTraktPresent())
        {
            host["trakt"] = new Dictionary<string, string> { ["provider"] = "jellyfin" };
        }

        if (!string.IsNullOrEmpty(mdblistKey))
        {
            host["mdblist"] = new Dictionary<string, string> { ["apiKey"] = mdblistKey };
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

    private string ResolvePublicUrl(string? configured)
    {
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return configured.Trim().TrimEnd('/');
        }

        try
        {
            var network = ReadNetworkConfiguration();
            var published = network?.GetType().GetProperty("PublishedServerUri")?.GetValue(network)?.ToString();
            if (!string.IsNullOrWhiteSpace(published))
            {
                return published.Trim().TrimEnd('/');
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Could not read PublishedServerUri");
        }

        return "";
    }

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

    private static string? FirstNonEmpty(params string?[] values) =>
        values.FirstOrDefault(value => !string.IsNullOrWhiteSpace(value));

    private List<object> CollectLibraries()
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
            _logger.LogWarning(ex, "Failed to list Jellyfin libraries for Foreseerr");
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

    private string? TryReadMoonbaseMdbListKey()
    {
        try
        {
            var dir = _applicationPaths.PluginConfigurationsPath;
            foreach (var file in Directory.GetFiles(dir, "*.xml"))
            {
                var name = Path.GetFileName(file);
                if (!name.Contains("Moonfin", StringComparison.OrdinalIgnoreCase)
                    && !name.Contains("Moonbase", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                var mdb = XDocument.Load(file).Root?.Element("MdblistApiKey")?.Value;
                if (!string.IsNullOrWhiteSpace(mdb))
                {
                    _logger.LogInformation("Imported MDBList key from {File}", name);
                    return mdb;
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Moonbase config import skipped");
        }

        return null;
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

public static class PluginHmac
{
    public static string Sign(string secret, string jellyfinUserId, long timestamp)
    {
        var message = $"{jellyfinUserId}\n{timestamp}";
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(secret));
        return Convert.ToHexString(hmac.ComputeHash(Encoding.UTF8.GetBytes(message))).ToLowerInvariant();
    }
}
