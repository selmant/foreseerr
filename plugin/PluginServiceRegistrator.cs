using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Foreseerr.Jellyfin;

public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public const string SidecarHttpClient = "foreseerr-sidecar";

    public void RegisterServices(
        IServiceCollection serviceCollection,
        IServerApplicationHost applicationHost)
    {
        serviceCollection.AddHttpClient(SidecarHttpClient)
            .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
            {
                UseCookies = false,
                AllowAutoRedirect = false,
            });
        serviceCollection.AddSingleton<SidecarSupervisor>();
        serviceCollection.AddSingleton<JellyfinHostBootstrap>();
        serviceCollection.AddSingleton<SidecarSessionService>();
        serviceCollection.AddHostedService<BindPluginServicesHostedService>();
        serviceCollection.AddHostedService(sp => sp.GetRequiredService<SidecarSupervisor>());
        serviceCollection.AddHostedService<FileTransformationHostedService>();
    }
}

internal sealed class BindPluginServicesHostedService : IHostedService
{
    public BindPluginServicesHostedService(IServiceProvider services)
    {
        ForeseerrPlugin.Services = services;
    }

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
