namespace MediTest.Models;

public sealed class AppLegalInfo
{
    public string ProductName { get; set; } = global::MediTest.Brand.ProductName;
    public string ProductVersion { get; set; } = string.Empty;
    public string BuildNumber { get; set; } = string.Empty;
    public DateTime? ReleaseDate { get; set; }
    public string AppDescription { get; set; } = string.Empty;
    public string WebsiteUrl { get; set; } = string.Empty;
    public string SupportEmail { get; set; } = string.Empty;
    public string DeveloperName { get; set; } = "Lukas Hofer";
    public string BusinessName { get; set; } = string.Empty;
    public string ContactEmail { get; set; } = string.Empty;
    public string CompanyAddress { get; set; } = string.Empty;
    public string VatId { get; set; } = string.Empty;
    public string Country { get; set; } = "Österreich";
    public string CopyrightText { get; set; } = "© 2026 Lukas Hofer. Alle Rechte vorbehalten.";
    public string LegalOwner { get; set; } = "Lukas Hofer";
    public string ImpressumText { get; set; } = string.Empty;
    public string ImpressumUrl { get; set; } = string.Empty;
    public string PrivacyPolicyUrl { get; set; } = string.Empty;
    public string TermsOfUseUrl { get; set; } = string.Empty;
    public string LicenseAgreementUrl { get; set; } = string.Empty;
    public string RefundPolicyUrl { get; set; } = string.Empty;
    public string LegalDisclaimerText { get; set; } = string.Empty;
    public List<string> ConfigurationWarnings { get; set; } = [];
}

public sealed class AppConfig
{
    public string CurrentAppVersion { get; set; } = string.Empty;
    public string CurrentTermsVersion { get; set; } = "5.1";
    public string CurrentPrivacyVersion { get; set; } = "5.1";
    public int AllowedOfflineDays { get; set; } = 7;
    public string SupportEmail { get; set; } = string.Empty;
    public string TermsOfUseUrl { get; set; } = string.Empty;
    public string PrivacyPolicyUrl { get; set; } = string.Empty;
    public string ImpressumUrl { get; set; } = string.Empty;
    public string LicenseAgreementUrl { get; set; } = string.Empty;
    public int DefaultMaxDevices { get; set; } = 2;
    public int TrialDurationDays { get; set; } = 7;
}

public sealed class LicenseInfo
{
    public string UserId { get; set; } = string.Empty;
    public string UserEmail { get; set; } = string.Empty;
    public string LicenseType { get; set; } = "Free";
    public string LicenseStatus { get; set; } = "inactive";
    public DateTime? LicenseStartDate { get; set; }
    public DateTime? LicenseEndDate { get; set; }
    public int MaxDevices { get; set; } = 1;
    public int CurrentDeviceCount { get; set; }
    public DateTime? LastLicenseCheck { get; set; }
    public bool ServerValidationRequired { get; set; } = true;
}

public sealed class UserLicenseStatus
{
    public string UserId { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;
    public string Role { get; set; } = "user";
    public bool IsBlocked { get; set; }
}

public sealed class DeviceActivation
{
    public string DeviceId { get; set; } = string.Empty;
    public string DeviceName { get; set; } = string.Empty;
    public DateTime FirstActivatedAt { get; set; }
    public DateTime LastUsedAt { get; set; }
    public string AppVersion { get; set; } = string.Empty;
}

public sealed class TermsAcceptance
{
    public string UserId { get; set; } = string.Empty;
    public string UserEmail { get; set; } = string.Empty;
    public string TermsVersion { get; set; } = string.Empty;
    public string PrivacyVersion { get; set; } = string.Empty;
    public DateTime AcceptedAt { get; set; }
    public string AppVersion { get; set; } = string.Empty;
    public string DeviceId { get; set; } = string.Empty;
}

public sealed class LicenseCheckResult
{
    public bool IsValid { get; set; }
    public string Status { get; set; } = "inactive";
    public string Message { get; set; } = string.Empty;
    public DateTime? ValidUntil { get; set; }
    public bool RequiresOnlineCheck { get; set; }
    public bool RequiresTermsAcceptance { get; set; }
    public bool DeviceActivated { get; set; }
    public bool CanActivateDevice { get; set; }
}

public sealed class LicenseAccessSnapshot
{
    public AppConfig AppConfig { get; set; } = new();
    public UserLicenseStatus User { get; set; } = new();
    public LicenseInfo License { get; set; } = new();
    public DeviceActivation? Device { get; set; }
    public TermsAcceptance? TermsAcceptance { get; set; }
    public LicenseCheckResult Result { get; set; } = new();
    public bool Online { get; set; } = true;
    public bool IsOfflineMode { get; set; }
    public DateTime? LastSuccessfulOnlineCheck { get; set; }
}

public sealed record AcceptTermsRequest(bool AcceptTerms, bool AcceptPrivacy);

public sealed record LegalLicenseStatusDto(
    AppLegalInfo Legal,
    LicenseAccessSnapshot Access);

public sealed class LicenseCacheEntry
{
    public DateTime LastSuccessfulOnlineCheck { get; set; }
    public LicenseAccessSnapshot Snapshot { get; set; } = new();
}
