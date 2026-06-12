using System.Security.Cryptography;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;

namespace MediTest.Services;

public sealed record DeviceIdentity(string DeviceId, string DeviceName, string Platform);

public sealed class DeviceIdentityService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private DeviceIdentity? _cached;

    public async Task<DeviceIdentity> GetAsync(CancellationToken ct = default)
    {
        if (_cached != null) return _cached;
        await _gate.WaitAsync(ct);
        try
        {
            if (_cached != null) return _cached;
            var path = IdentityPath();
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var secret = await ReadOrCreateSecretAsync(path, ct);
            var hash = SHA256.HashData(Encoding.UTF8.GetBytes($"MediTest|{secret}"));
            _cached = new DeviceIdentity(
                Convert.ToHexString(hash).ToLowerInvariant(),
                DeviceName(),
                DevicePlatform());
            return _cached;
        }
        finally
        {
            _gate.Release();
        }
    }

    private static async Task<string> ReadOrCreateSecretAsync(string path, CancellationToken ct)
    {
        try
        {
            if (File.Exists(path))
            {
                var json = await File.ReadAllTextAsync(path, ct);
                var data = JsonSerializer.Deserialize<DeviceIdentityFile>(json, JsonOptions);
                if (!string.IsNullOrWhiteSpace(data?.Secret)) return data.Secret;
            }
        }
        catch
        {
            // A damaged identity file is replaced with a fresh random identity.
        }

        var secret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        var payload = JsonSerializer.Serialize(new DeviceIdentityFile { Secret = secret }, JsonOptions);
        await File.WriteAllTextAsync(path, payload, Encoding.UTF8, ct);
        return secret;
    }

    private static string IdentityPath() =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MediTest",
            "device.json");

    private static string DeviceName()
    {
        var os = OperatingSystem.IsWindows() ? "Windows" :
            OperatingSystem.IsMacOS() ? "macOS" :
            OperatingSystem.IsLinux() ? "Linux" : "Gerät";
        return $"{os} · {Environment.MachineName}";
    }

    private static string DevicePlatform()
    {
        var architecture = RuntimeInformation.ProcessArchitecture;
        if (OperatingSystem.IsWindows() && architecture == Architecture.X64) return "windows-x64";
        if (OperatingSystem.IsMacOS() && architecture == Architecture.Arm64) return "macos-arm64";
        if (OperatingSystem.IsMacOS() && architecture == Architecture.X64) return "macos-x64";
        return $"{Environment.OSVersion.Platform}-{architecture}".ToLowerInvariant();
    }

    private sealed class DeviceIdentityFile
    {
        public string Secret { get; set; } = string.Empty;
    }
}
