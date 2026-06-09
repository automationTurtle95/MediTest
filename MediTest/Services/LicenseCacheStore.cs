using System.Text.Json;
using MediTest.Models;
using Microsoft.AspNetCore.DataProtection;

namespace MediTest.Services;

public sealed class LicenseCacheStore
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly IDataProtector _protector;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public LicenseCacheStore(IDataProtectionProvider provider)
    {
        _protector = provider.CreateProtector("MediTest.LicenseCache.v1");
    }

    public async Task SaveAsync(LicenseCacheEntry entry, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var path = CachePath();
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var protectedValue = _protector.Protect(JsonSerializer.Serialize(entry, JsonOptions));
            await File.WriteAllTextAsync(path, protectedValue, ct);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<LicenseCacheEntry?> ReadAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var path = CachePath();
            if (!File.Exists(path)) return null;
            var protectedValue = await File.ReadAllTextAsync(path, ct);
            var json = _protector.Unprotect(protectedValue);
            return JsonSerializer.Deserialize<LicenseCacheEntry>(json, JsonOptions);
        }
        catch
        {
            return null;
        }
        finally
        {
            _gate.Release();
        }
    }

    private static string CachePath() =>
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "MediTest",
            "license-cache.dat");
}
