using System.Reflection;
using System.Runtime.Loader;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Newtonsoft.Json.Linq;

namespace Foreseerr.Jellyfin;

public class FileTransformationHostedService : IHostedService
{
    private readonly ILogger<FileTransformationHostedService> _logger;

    public FileTransformationHostedService(ILogger<FileTransformationHostedService> logger)
    {
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            RegisterTransformation();
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Foreseerr: failed to register File Transformation");
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private void RegisterTransformation()
    {
        var payload = new JObject
        {
            { "id", "a7c3e2f1-0001-4e8a-8c1f-2b6d9e0f4a11" },
            { "fileNamePattern", "index.html" },
            { "callbackAssembly", GetType().Assembly.FullName },
            { "callbackClass", typeof(TransformationPatches).FullName },
            { "callbackMethod", nameof(TransformationPatches.IndexHtml) },
        };

        var ftAssembly = AssemblyLoadContext.All
            .SelectMany(context => context.Assemblies)
            .FirstOrDefault(assembly => assembly.FullName?.Contains(".FileTransformation") == true);

        if (ftAssembly == null)
        {
            _logger.LogWarning(
                "Foreseerr: File Transformation plugin not found. Install it to get a Jellyfin Web header button. {Url}",
                "https://github.com/IAmParadox27/jellyfin-plugin-file-transformation");
            return;
        }

        var pluginInterfaceType = ftAssembly.GetType("Jellyfin.Plugin.FileTransformation.PluginInterface");
        pluginInterfaceType?.GetMethod("RegisterTransformation")
            ?.Invoke(null, [payload]);
        _logger.LogInformation("Foreseerr: registered index.html transformation");
    }
}

public static class TransformationPatches
{
    public static string IndexHtml(PatchRequestPayload payload)
    {
        if (string.IsNullOrEmpty(payload.Contents))
        {
            return payload.Contents ?? string.Empty;
        }

        var stream = Assembly.GetExecutingAssembly()
            .GetManifestResourceStream("Foreseerr.Jellyfin.Web.inject.html");
        string inject;
        if (stream == null)
        {
            inject = "<script src=\"../ForeseerrPlugin/loader.js\" defer></script>";
        }
        else
        {
            using var reader = new StreamReader(stream);
            inject = reader.ReadToEnd();
        }

        return Regex.Replace(payload.Contents, "(</head>)", $"{inject}$1", RegexOptions.IgnoreCase);
    }
}

public class PatchRequestPayload
{
    public string? Contents { get; set; }
}
