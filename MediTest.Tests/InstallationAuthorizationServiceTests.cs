using System.Text.Json;
using MediTest.Services;
using Xunit;

namespace MediTest.Tests;

public sealed class InstallationAuthorizationServiceTests : IDisposable
{
    private static readonly DateTimeOffset Now = new(2026, 6, 12, 10, 0, 0, TimeSpan.Zero);
    private static readonly string Token = new('a', 43);
    private readonly string _directory = Path.Combine(Path.GetTempPath(), $"meditest-install-auth-{Guid.NewGuid():N}");

    public InstallationAuthorizationServiceTests()
    {
        Directory.CreateDirectory(_directory);
    }

    [Fact]
    public async Task FindsValidAuthorizationForRequestedPlatform()
    {
        var path = WriteAuthorization("windows-x64", Now.AddHours(1));
        var service = Service();

        var result = await service.FindAsync("windows-x64");

        Assert.NotNull(result);
        Assert.Equal(Token, result.Token);
        Assert.Equal(path, result.FilePath);
    }

    [Fact]
    public async Task IgnoresExpiredAuthorization()
    {
        WriteAuthorization("windows-x64", Now.AddMinutes(-1));

        Assert.Null(await Service().FindAsync("windows-x64"));
    }

    [Fact]
    public async Task IgnoresAuthorizationForAnotherPlatform()
    {
        WriteAuthorization("macos-arm64", Now.AddHours(1));

        Assert.Null(await Service().FindAsync("windows-x64"));
    }

    [Fact]
    public async Task DeletesConsumedAuthorization()
    {
        WriteAuthorization("windows-x64", Now.AddHours(1));
        var service = Service();
        var authorization = await service.FindAsync("windows-x64");

        service.Delete(Assert.IsType<InstallationAuthorization>(authorization));

        Assert.False(File.Exists(authorization!.FilePath));
    }

    private InstallationAuthorizationService Service() =>
        new([_directory], new FixedTimeProvider(Now));

    private string WriteAuthorization(string platform, DateTimeOffset expiresAt)
    {
        var path = Path.Combine(_directory, "Meduvalo-Installationsberechtigung-5.0.7.json");
        File.WriteAllText(path, JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            token = Token,
            platform,
            version = "5.0.7",
            expiresAt
        }));
        return path;
    }

    public void Dispose()
    {
        if (Directory.Exists(_directory))
            Directory.Delete(_directory, recursive: true);
    }

    private sealed class FixedTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
