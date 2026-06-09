using MediTest.Models;
using MediTest.Services;
using Xunit;

namespace MediTest.Tests;

public sealed class LicensePolicyTests
{
    private static readonly DateTime Now = new(2026, 6, 9, 10, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void LoggedInUserWithActiveLicenseIsValid()
    {
        var result = LicensePolicy.Evaluate(License("Subscription", "active"), User(), true, Now);
        Assert.True(result.IsValid);
        Assert.Equal("Lizenz aktiv.", result.Message);
    }

    [Fact]
    public void MissingFirebaseUserIsRejected()
    {
        var result = LicensePolicy.Evaluate(License("Subscription", "active"), null, true, Now);
        Assert.False(result.IsValid);
        Assert.Contains("Kein eingeloggter", result.Message);
    }

    [Fact]
    public void ExpiredLicenseIsRejected()
    {
        var result = LicensePolicy.Evaluate(License("Subscription", "active", Now.AddMinutes(-1)), User(), true, Now);
        Assert.False(result.IsValid);
        Assert.Equal("expired", result.Status);
    }

    [Fact]
    public void BlockedLicenseIsRejected()
    {
        var result = LicensePolicy.Evaluate(License("Lifetime", "blocked"), User(), true, Now);
        Assert.False(result.IsValid);
        Assert.Equal("blocked", result.Status);
    }

    [Fact]
    public void BlockedUserIsRejected()
    {
        var result = LicensePolicy.Evaluate(License("Lifetime", "active"), User(blocked: true), true, Now);
        Assert.False(result.IsValid);
        Assert.Contains("gesperrt", result.Message);
    }

    [Theory]
    [InlineData("Trial", "trial")]
    [InlineData("Free", "active")]
    [InlineData("Student", "active")]
    public void SupportedLicenseTypesAreValid(string type, string status)
    {
        var result = LicensePolicy.Evaluate(License(type, status), User(), true, Now);
        Assert.True(result.IsValid);
    }

    [Fact]
    public void DeviceLimitIsReported()
    {
        var license = License("Subscription", "active");
        license.CurrentDeviceCount = 2;
        license.MaxDevices = 2;
        var result = LicensePolicy.Evaluate(license, User(), false, Now);
        Assert.False(result.CanActivateDevice);
        Assert.Contains("Maximale Geräteanzahl", result.Message);
    }

    [Fact]
    public void ExistingDeviceIsAccepted()
    {
        var result = LicensePolicy.Evaluate(License("Student", "active"), User(), true, Now);
        Assert.True(result.DeviceActivated);
        Assert.True(result.IsValid);
    }

    [Fact]
    public void NewDeviceCanBeActivatedWhenSlotIsFree()
    {
        var license = License("Student", "active");
        license.CurrentDeviceCount = 1;
        license.MaxDevices = 2;
        var result = LicensePolicy.Evaluate(license, User(), false, Now);
        Assert.True(result.CanActivateDevice);
        Assert.Contains("nicht für diese Lizenz aktiviert", result.Message);
    }

    [Fact]
    public void MissingTermsAcceptanceIsDetected()
    {
        Assert.True(LicensePolicy.RequiresTermsAcceptance(null, Config()));
    }

    [Fact]
    public void NewTermsVersionRequiresAcceptance()
    {
        var acceptance = Acceptance();
        acceptance.TermsVersion = "4.9";
        Assert.True(LicensePolicy.RequiresTermsAcceptance(acceptance, Config()));
    }

    [Fact]
    public void NewPrivacyVersionRequiresAcceptance()
    {
        var acceptance = Acceptance();
        acceptance.PrivacyVersion = "4.9";
        Assert.True(LicensePolicy.RequiresTermsAcceptance(acceptance, Config()));
    }

    [Fact]
    public void CurrentTermsAndPrivacyAreAccepted()
    {
        Assert.False(LicensePolicy.RequiresTermsAcceptance(Acceptance(), Config()));
    }

    [Fact]
    public void OfflineModeWorksWithinAllowedDays()
    {
        var cache = Cache(Now.AddDays(-2));
        var result = LicensePolicy.EvaluateOffline(cache, "user-1", "device-1", Now);
        Assert.True(result.IsValid);
        Assert.False(result.RequiresOnlineCheck);
    }

    [Fact]
    public void OfflineModeExpiresAfterAllowedDays()
    {
        var cache = Cache(Now.AddDays(-8));
        var result = LicensePolicy.EvaluateOffline(cache, "user-1", "device-1", Now);
        Assert.False(result.IsValid);
        Assert.True(result.RequiresOnlineCheck);
    }

    private static UserLicenseStatus User(bool blocked = false) => new()
    {
        UserId = "user-1",
        Email = "user@example.test",
        IsBlocked = blocked
    };

    private static LicenseInfo License(string type, string status, DateTime? end = null) => new()
    {
        UserId = "user-1",
        UserEmail = "user@example.test",
        LicenseType = type,
        LicenseStatus = status,
        LicenseStartDate = Now.AddDays(-1),
        LicenseEndDate = end ?? Now.AddDays(30),
        MaxDevices = 2,
        CurrentDeviceCount = 1,
        ServerValidationRequired = false
    };

    private static AppConfig Config() => new()
    {
        CurrentTermsVersion = "5.0",
        CurrentPrivacyVersion = "5.0",
        AllowedOfflineDays = 7
    };

    private static TermsAcceptance Acceptance() => new()
    {
        UserId = "user-1",
        TermsVersion = "5.0",
        PrivacyVersion = "5.0",
        DeviceId = "device-1",
        AcceptedAt = Now
    };

    private static LicenseCacheEntry Cache(DateTime checkedAt) => new()
    {
        LastSuccessfulOnlineCheck = checkedAt,
        Snapshot = new LicenseAccessSnapshot
        {
            AppConfig = Config(),
            User = User(),
            License = License("Student", "active"),
            Device = new DeviceActivation { DeviceId = "device-1" },
            TermsAcceptance = Acceptance(),
            Result = new LicenseCheckResult { DeviceActivated = true }
        }
    };
}
