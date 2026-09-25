using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Foreseerr.Jellyfin;

/// <summary>One owned child process, started after Jellyfin and awaited on shutdown.</summary>
public sealed class SidecarSupervisor(
    JellyfinHostBootstrap bootstrap,
    IHostApplicationLifetime lifetime,
    IHttpClientFactory clients,
    ILogger<SidecarSupervisor> logger) : BackgroundService
{
    private readonly object _restartLock = new();
    private CancellationTokenSource? _restart;
    public int Port { get; private set; }
    public string Origin => $"http://127.0.0.1:{Port}";
    public int? Pid { get; private set; }
    public bool IsRunning => Pid != null;
    public bool IsReady { get; private set; }
    public string? LastError { get; private set; }
    public Guid Generation { get; private set; }

    public void RequestRestart()
    {
        lock (_restartLock) _restart?.Cancel();
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // A plugin must not hold up Jellyfin's HTTP listener while booting its child.
        var started = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        using var registration = lifetime.ApplicationStarted.Register(() => started.TrySetResult());
        await started.Task.WaitAsync(stoppingToken).ConfigureAwait(false);
        var retry = TimeSpan.FromSeconds(2);
        while (!stoppingToken.IsCancellationRequested)
        {
            using var cycle = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            lock (_restartLock) _restart = cycle;
            try
            {
                await RunProcessAsync(cycle.Token).ConfigureAwait(false);
                retry = TimeSpan.FromSeconds(2);
            }
            catch (OperationCanceledException) when (cycle.IsCancellationRequested)
            {
                // Requested restart or host shutdown. The owned process is stopped below.
            }
            catch (Exception ex)
            {
                LastError = ex.Message;
                logger.LogError(ex, "Foreseerr sidecar failed; retrying in {Seconds}s", retry.TotalSeconds);
            }
            finally
            {
                lock (_restartLock) _restart = null;
            }
            if (stoppingToken.IsCancellationRequested) break;
            if (cycle.IsCancellationRequested) continue;
            await Task.Delay(retry, stoppingToken).ConfigureAwait(false);
            retry = TimeSpan.FromSeconds(Math.Min(retry.TotalSeconds * 2, 60));
        }
    }

    private async Task RunProcessAsync(CancellationToken cancellationToken)
    {
        bootstrap.WriteHostFile();
        var binary = ResolveBinaryPath() ?? throw new InvalidOperationException(
            "No Foreseerr sidecar binary for this OS/architecture in the plugin sidecar directory.");
        var config = ForeseerrPlugin.Instance?.Configuration
            ?? throw new InvalidOperationException("Plugin configuration is unavailable.");
        if (config.SidecarPort is < 0 or > 65535) throw new InvalidOperationException("Sidecar port must be 0–65535.");
        if (string.IsNullOrEmpty(config.PluginSecret)) throw new InvalidOperationException("Plugin secret is unavailable.");
        if (!OperatingSystem.IsWindows())
            File.SetUnixFileMode(binary, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute
                | UnixFileMode.GroupRead | UnixFileMode.GroupExecute);

        var generation = Guid.NewGuid();
        var start = new ProcessStartInfo(binary)
        {
            WorkingDirectory = Path.GetDirectoryName(binary)!,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        start.Environment["FORESEERR_PLUGIN"] = "1";
        start.Environment["FORESEERR_PLUGIN_SECRET"] = config.PluginSecret;
        start.Environment["FORESEERR_PLUGIN_INSTANCE"] = generation.ToString("N");
        start.Environment["FORESEERR_BASE_PATH"] = "/Foreseerr";
        start.Environment["FORESEERR_PUBLIC_BASE_PATH"] = bootstrap.GetBasePath() + "/Foreseerr";
        start.Environment["CONFIG_DIRECTORY"] = bootstrap.ConfigDirectory;
        start.Environment["HOST"] = "127.0.0.1";
        start.Environment["PORT"] = config.SidecarPort.ToString(System.Globalization.CultureInfo.InvariantCulture);
        start.Environment["NODE_ENV"] = "production";
        start.Environment.Remove("FORESEERR_RUNTIME");

        using var process = new Process { StartInfo = start };
        var listening = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        process.OutputDataReceived += (_, args) =>
        {
            if (args.Data?.StartsWith("FORESEERR_PLUGIN_READY ", StringComparison.Ordinal) == true)
            {
                try
                {
                    using var message = JsonDocument.Parse(args.Data["FORESEERR_PLUGIN_READY ".Length..]);
                    if (message.RootElement.GetProperty("instance").GetString() == generation.ToString("N"))
                    {
                        var port = message.RootElement.GetProperty("port").GetInt32();
                        if (port is > 0 and <= 65535) listening.TrySetResult(port);
                    }
                }
                catch (JsonException) { }
                return;
            }
            if (!string.IsNullOrEmpty(args.Data)) logger.LogInformation("[foreseerr] {Line}", args.Data);
        };
        process.ErrorDataReceived += (_, args) =>
        {
            if (!string.IsNullOrEmpty(args.Data)) logger.LogWarning("[foreseerr] {Line}", args.Data);
        };
        try
        {
            if (!process.Start()) throw new InvalidOperationException("Could not start Foreseerr.");
            Pid = process.Id;
            Generation = generation;
            Port = 0;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            var exit = process.WaitForExitAsync(cancellationToken);
            using var startup = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            startup.CancelAfter(TimeSpan.FromSeconds(60));
            var bound = listening.Task.WaitAsync(startup.Token);
            if (await Task.WhenAny(bound, exit).ConfigureAwait(false) == exit)
                throw new InvalidOperationException("Foreseerr exited before opening its listener.");
            Port = await bound.ConfigureAwait(false);
            var health = clients.CreateClient(PluginServiceRegistrator.SidecarHttpClient);
            using var request = new HttpRequestMessage(HttpMethod.Get, Origin + "/Foreseerr/api/v1/status");
            request.Headers.Add("X-Foreseerr-Plugin-Secret", config.PluginSecret);
            using var response = await health.SendAsync(request, startup.Token).ConfigureAwait(false);
            response.EnsureSuccessStatusCode();
            if (process.HasExited) throw new InvalidOperationException("Foreseerr exited during startup.");
            IsReady = true;
            LastError = null;
            logger.LogInformation("Foreseerr sidecar ready on {Origin}", Origin);
            await exit.ConfigureAwait(false);
            throw new InvalidOperationException($"Foreseerr exited with code {process.ExitCode}.");
        }
        finally
        {
            IsReady = false;
            if (Pid != null)
            {
                try
                {
                    if (!process.HasExited)
                    {
                        process.Kill(entireProcessTree: true);
                        // Bounded reap even when the cycle was cancelled.
                        await process.WaitForExitAsync(CancellationToken.None)
                            .WaitAsync(TimeSpan.FromSeconds(5), CancellationToken.None).ConfigureAwait(false);
                    }
                }
                catch (Exception ex) when (ex is InvalidOperationException or TimeoutException)
                {
                    logger.LogWarning("Foreseerr sidecar {Pid} did not stop cleanly: {Message}", Pid, ex.Message);
                }
                Pid = null;
            }
            Port = 0;
        }
    }

    private static string? ResolveBinaryPath()
    {
        var directory = Path.GetDirectoryName(typeof(SidecarSupervisor).Assembly.Location);
        var name = (OperatingSystem.IsWindows(), OperatingSystem.IsLinux(), RuntimeInformation.ProcessArchitecture) switch
        {
            (true, _, Architecture.X64) => "foreseerr-windows-x64.exe",
            (_, true, Architecture.X64) => "foreseerr-linux-x64",
            (_, true, Architecture.Arm64) => "foreseerr-linux-arm64",
            _ => null,
        };
        if (directory == null || name == null) return null;
        var path = Path.Combine(directory, "sidecar", name);
        return File.Exists(path) ? path : null;
    }
}
