using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Microsoft.Extensions.DependencyInjection;

namespace Foreseerr.Jellyfin;

public class ForeseerrPlugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public static ForeseerrPlugin? Instance { get; private set; }

    public const string PluginGuid = "a7c3e2f1-9b4d-4e8a-8c1f-2b6d9e0f4a11";

    /// <summary>
    /// Set from DI after the host is built. Jellyfin only constructs the plugin
    /// with (IApplicationPaths, IXmlSerializer).
    /// </summary>
    public static IServiceProvider? Services { get; set; }

    public ForeseerrPlugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        try
        {
            if (Configuration.EnsureSecrets())
            {
                SaveConfiguration();
            }
        }
        catch
        {
            // Constructor must not throw; Jellyfin will disable the plugin.
        }
    }

    public override string Name => "Foreseerr";

    public override string Description =>
        "Runs Foreseerr as a localhost sidecar and opens it from Jellyfin Web with SSO.";

    public override Guid Id => Guid.Parse(PluginGuid);

    public new string DataFolderPath =>
        Path.Combine(ApplicationPaths.PluginConfigurationsPath, "Foreseerr");

    public override void UpdateConfiguration(BasePluginConfiguration configuration)
    {
        var previousPort = Configuration.SidecarPort;
        base.UpdateConfiguration(configuration);
        Configuration.EnsureSecrets();
        SaveConfiguration();
        try
        {
            Services?.GetService<JellyfinHostBootstrap>()?.WriteHostFile();
        }
        catch
        {
            // Saving config must succeed even if the sidecar is down.
        }

        if (previousPort != Configuration.SidecarPort)
        {
            var supervisor = Services?.GetService<SidecarSupervisor>();
            if (supervisor != null)
            {
                _ = supervisor.RestartAsync();
            }
        }
    }

    public IEnumerable<PluginPageInfo> GetPages()
    {
        return
        [
            new PluginPageInfo
            {
                Name = Name,
                EmbeddedResourcePath = GetType().Namespace + ".Pages.configPage.html",
                EnableInMainMenu = true,
            },
        ];
    }
}
