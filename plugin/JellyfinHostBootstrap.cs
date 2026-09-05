using System.Reflection;
using System.Runtime.Loader;
using System.Security.Cryptography;
using System.Text;
using System.Xml.Linq;
using Jellyfin.Data.Enums;
using MediaBrowser.Common.Configuration;
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

    public string ConfigDirectory =>
        Path.Combine(ForeseerrPlugin.Instance?.DataFolderPath ?? "foreseerr", "foreseerr");

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

        var moonbase = TryReadMoonbaseKeys();
        var mdblistKey = FirstNonEmpty(config?.MdblistApiKey, moonbase.MdbListApiKey);
        var tmdbKey = FirstNonEmpty(config?.TmdbApiKey, moonbase.TmdbApiKey);
        var webhookSecret = config?.WebhookSecret ?? "";
        var webhookUrl = $"http://127.0.0.1:{GetHttpPort()}/ForeseerrPlugin/Webhook";

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
                ["urlBase"] = "",
                ["externalHostname"] = publicUrl,
                ["serverId"] = _appHost.SystemId,
                ["apiKey"] = apiKey ?? config?.ApiKeyToken ?? "",
                ["libraries"] = CollectLibraries(),
            },
            ["webhook"] = new Dictionary<string, string>
            {
                ["url"] = webhookUrl,
                ["secret"] = webhookSecret,
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

        if (!string.IsNullOrEmpty(tmdbKey))
        {
            host["tmdb"] = new Dictionary<string, string> { ["apiKey"] = tmdbKey };
        }

        var admin = _userManager.Users.FirstOrDefault(user =>
        {
            try
            {
                return user.HasPermission(PermissionKind.IsAdministrator);
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
                ["jellyfinUserId"] = admin.Id.ToString("D"),
                ["jellyfinUsername"] = admin.Username,
                ["email"] = string.IsNullOrWhiteSpace(admin.Username)
                    ? admin.Id.ToString("D")
                    : admin.Username,
            };
        }

        var path = Path.Combine(ConfigDirectory, "jellyfin-host.json");
        File.WriteAllText(
            path,
            JsonConvert.SerializeObject(host, Formatting.Indented));
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

    private (string? MdbListApiKey, string? TmdbApiKey) TryReadMoonbaseKeys()
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

                var doc = XDocument.Load(file);
                var root = doc.Root;
                if (root == null)
                {
                    continue;
                }

                var mdb = root.Element("MdblistApiKey")?.Value;
                var tmdb = root.Element("TmdbApiKey")?.Value;
                if (!string.IsNullOrWhiteSpace(mdb) || !string.IsNullOrWhiteSpace(tmdb))
                {
                    _logger.LogInformation("Imported rating keys from {File}", name);
                    return (string.IsNullOrWhiteSpace(mdb) ? null : mdb, string.IsNullOrWhiteSpace(tmdb) ? null : tmdb);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Moonbase config import skipped");
        }

        return (null, null);
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

    private object? ReadNetworkConfiguration()
    {
        var configManager = _services.GetService<IServerConfigurationManager>();
        if (configManager == null)
        {
            return null;
        }

        foreach (var method in configManager.GetType().GetMethods())
        {
            if (method.Name != "GetNetworkConfiguration" || method.GetParameters().Length != 0)
            {
                continue;
            }

            return method.Invoke(configManager, null);
        }

        var getGeneric = configManager.GetType().GetMethods()
            .FirstOrDefault(method =>
                method.Name == "GetConfiguration"
                && method.IsGenericMethodDefinition
                && method.GetParameters().Length == 0);
        if (getGeneric == null)
        {
            return null;
        }

        foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies())
        {
            var networkType = assembly.GetType("Jellyfin.Networking.Configuration.NetworkConfiguration")
                ?? assembly.GetType("MediaBrowser.Model.Configuration.NetworkConfiguration");
            if (networkType == null)
            {
                continue;
            }

            return getGeneric.MakeGenericMethod(networkType).Invoke(configManager, null);
        }

        return null;
    }
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
