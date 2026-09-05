using MediaBrowser.Model.Plugins;

namespace Foreseerr.Jellyfin;

public class PluginConfiguration : BasePluginConfiguration
{
    public string? PublicServerUrl { get; set; }

    public string? ApiKeyToken { get; set; }

    public string? PluginSecret { get; set; }

    public string? WebhookSecret { get; set; }

    public string? TmdbApiKey { get; set; }

    public string? MdblistApiKey { get; set; }

    public int SidecarPort { get; set; } = 5055;

    public string? LastError { get; set; }

    public bool EnsureSecrets()
    {
        var changed = false;
        if (string.IsNullOrEmpty(PluginSecret))
        {
            PluginSecret = Convert.ToHexString(Guid.NewGuid().ToByteArray())
                + Convert.ToHexString(Guid.NewGuid().ToByteArray());
            changed = true;
        }

        if (string.IsNullOrEmpty(WebhookSecret))
        {
            WebhookSecret = Convert.ToHexString(Guid.NewGuid().ToByteArray()).ToLowerInvariant();
            changed = true;
        }

        return changed;
    }
}
