using MediaBrowser.Model.Plugins;
using System.Security.Cryptography;

namespace Foreseerr.Jellyfin;

public class PluginConfiguration : BasePluginConfiguration
{
    public string? PublicServerUrl { get; set; }

    public string? ApiKeyToken { get; set; }

    public string? PluginSecret { get; set; }

    public string? MdblistApiKey { get; set; }

    public int SidecarPort { get; set; }

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
}
