using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Foreseerr.Jellyfin;

public class SidecarSupervisor : IHostedService, IDisposable
{
    private readonly JellyfinHostBootstrap _bootstrap;
    private readonly ILogger<SidecarSupervisor> _logger;
    private Process? _process;
    private readonly HttpClient _health = new() { Timeout = TimeSpan.FromSeconds(2) };
    private CancellationTokenSource? _watchCts;

    public SidecarSupervisor(JellyfinHostBootstrap bootstrap, ILogger<SidecarSupervisor> logger)
    {
        _bootstrap = bootstrap;
        _logger = logger;
    }

    public int Port => ForeseerrPlugin.Instance?.Configuration.SidecarPort is > 0 and var port
        ? port
        : 5055;

    public string Origin => $"http://127.0.0.1:{Port}";

    public int? Pid => _process is { HasExited: false } ? _process.Id : null;

    public string? LastError { get; private set; }

    public bool IsRunning => _process is { HasExited: false };

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        _watchCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        await StartProcessAsync(_watchCts.Token);
        _ = WatchAsync(_watchCts.Token);
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        try
        {
            _watchCts?.Cancel();
        }
        catch
        {
            // ignore
        }

        TryStop();
        return Task.CompletedTask;
    }

    public async Task RestartAsync()
    {
        TryStop();
        await StartProcessAsync(CancellationToken.None);
    }

    public void Dispose()
    {
        try
        {
            _watchCts?.Cancel();
            _watchCts?.Dispose();
        }
        catch
        {
            // ignore
        }

        TryStop();
        _health.Dispose();
        GC.SuppressFinalize(this);
    }

    private async Task WatchAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(2000, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }

            if (_process is { HasExited: false })
            {
                continue;
            }

            _logger.LogWarning("Foreseerr sidecar exited; restarting");
            try
            {
                await StartProcessAsync(cancellationToken);
            }
            catch (Exception ex)
            {
                LastError = ex.Message;
                SaveLastError();
                _logger.LogError(ex, "Foreseerr sidecar restart failed");
            }
        }
    }

    private async Task StartProcessAsync(CancellationToken cancellationToken)
    {
        try
        {
            Directory.CreateDirectory(_bootstrap.ConfigDirectory);
            _bootstrap.WriteHostFile();
            var binary = ResolveBinaryPath();
            if (binary == null)
            {
                LastError = "No Foreseerr sidecar binary for this architecture. Place foreseerr-linux-x64 or foreseerr-linux-arm64 in the plugin sidecar/ folder.";
                _logger.LogError("{Error}", LastError);
                SaveLastError();
                return;
            }

            if (!OperatingSystem.IsWindows())
            {
                File.SetUnixFileMode(
                    binary,
                    UnixFileMode.UserRead
                        | UnixFileMode.UserWrite
                        | UnixFileMode.UserExecute
                        | UnixFileMode.GroupRead
                        | UnixFileMode.GroupExecute
                        | UnixFileMode.OtherRead
                        | UnixFileMode.OtherExecute);
            }

            var secret = ForeseerrPlugin.Instance?.Configuration.PluginSecret ?? Guid.NewGuid().ToString("N");
            var start = new ProcessStartInfo
            {
                FileName = binary,
                WorkingDirectory = _bootstrap.ConfigDirectory,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
            };
            start.Environment["FORESEERR_PLUGIN"] = "1";
            start.Environment["FORESEERR_PLUGIN_SECRET"] = secret;
            start.Environment["FORESEERR_BASE_PATH"] = "/Foreseerr";
            start.Environment["CONFIG_DIRECTORY"] = _bootstrap.ConfigDirectory;
            start.Environment["HOST"] = "127.0.0.1";
            start.Environment["PORT"] = Port.ToString();
            start.Environment["NODE_ENV"] = "production";

            _process = Process.Start(start);
            if (_process == null)
            {
                LastError = "Failed to start Foreseerr process";
                SaveLastError();
                return;
            }

            _process.OutputDataReceived += (_, args) =>
            {
                if (!string.IsNullOrEmpty(args.Data))
                {
                    _logger.LogInformation("[foreseerr] {Line}", args.Data);
                }
            };
            _process.ErrorDataReceived += (_, args) =>
            {
                if (!string.IsNullOrEmpty(args.Data))
                {
                    _logger.LogWarning("[foreseerr] {Line}", args.Data);
                }
            };
            _process.BeginOutputReadLine();
            _process.BeginErrorReadLine();

            var ready = await WaitHealthy(cancellationToken);
            if (!ready)
            {
                LastError = "Foreseerr started but did not become healthy";
                _logger.LogError("{Error}", LastError);
                SaveLastError();
            }
            else
            {
                LastError = null;
                SaveLastError();
                _logger.LogInformation("Foreseerr sidecar healthy on {Origin}", Origin);
            }
        }
        catch (Exception ex)
        {
            LastError = ex.Message;
            SaveLastError();
            _logger.LogError(ex, "Foreseerr sidecar failed to start");
        }
    }

    private void TryStop()
    {
        try
        {
            if (_process is { HasExited: false })
            {
                _process.Kill(entireProcessTree: true);
                _process.WaitForExit(3000);
            }
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Error stopping Foreseerr sidecar");
        }
        finally
        {
            _process?.Dispose();
            _process = null;
        }
    }

    private async Task<bool> WaitHealthy(CancellationToken cancellationToken)
    {
        var deadline = DateTime.UtcNow.AddSeconds(45);
        var url = $"{Origin}/Foreseerr/api/v1/status";
        while (DateTime.UtcNow < deadline && !cancellationToken.IsCancellationRequested)
        {
            if (_process is { HasExited: true })
            {
                return false;
            }

            try
            {
                using var response = await _health.GetAsync(url, cancellationToken);
                if (response.IsSuccessStatusCode)
                {
                    return true;
                }
            }
            catch
            {
                // still starting
            }

            await Task.Delay(400, cancellationToken);
        }

        return false;
    }

    private static string? ResolveBinaryPath()
    {
        var pluginDir = Path.GetDirectoryName(typeof(SidecarSupervisor).Assembly.Location);
        if (pluginDir == null)
        {
            return null;
        }

        var sidecarDir = Path.Combine(pluginDir, "sidecar");
        string name;
        if (OperatingSystem.IsWindows())
        {
            name = "foreseerr-windows-x64.exe";
        }
        else if (RuntimeInformation.ProcessArchitecture == Architecture.Arm64)
        {
            name = "foreseerr-linux-arm64";
        }
        else if (RuntimeInformation.ProcessArchitecture == Architecture.X64)
        {
            name = "foreseerr-linux-x64";
        }
        else
        {
            return null;
        }

        var path = Path.Combine(sidecarDir, name);
        return File.Exists(path) ? path : null;
    }

    private void SaveLastError()
    {
        var plugin = ForeseerrPlugin.Instance;
        if (plugin == null)
        {
            return;
        }

        try
        {
            plugin.Configuration.LastError = LastError;
            plugin.SaveConfiguration();
        }
        catch
        {
            // ignore
        }
    }
}
