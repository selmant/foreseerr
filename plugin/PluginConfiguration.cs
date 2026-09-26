using System.Security.Cryptography;
using System.Text.Json.Serialization;
using MediaBrowser.Model.Plugins;

namespace Foreseerr.Jellyfin;

public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>
    /// The address browsers use for Jellyfin. Notification links are built from it.
    /// </summary>
    public string? PublicServerUrl { get; set; }

    // Managed by the plugin. Persisted in the XML file but never sent to or
    // accepted from the dashboard page.
    [JsonIgnore]
    public string? ApiKeyToken { get; set; }

    [JsonIgnore]
    public string? PluginSecret { get; set; }

    public bool EnsureSecrets()
    {
        var changed = false;
        if (string.IsNullOrEmpty(PluginSecret))
        {
            PluginSecret = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            changed = true;
        }

        return changed;
    }

    /// <summary>Returns the URL without a trailing slash, or null when empty.</summary>
    /// <exception cref="ArgumentException">The value is not an http(s) URL.</exception>
    public static string? NormalizePublicServerUrl(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        if (!Uri.TryCreate(value.Trim(), UriKind.Absolute, out var uri)
            || (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp)
            || uri.UserInfo.Length > 0 || uri.Query.Length > 0 || uri.Fragment.Length > 0)
        {
            throw new ArgumentException(
                "Public server URL must be an http or https address, for example https://jellyfin.example.com.",
                nameof(value));
        }

        return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
    }
}
