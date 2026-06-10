using MediTest.Models;

namespace MediTest.Services;

public static class LicensePolicy
{
    private static readonly HashSet<string> ActiveTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "Free", "Base", "Trial", "Student", "Lifetime", "Subscription", "Admin"
    };

    public static LicenseCheckResult Evaluate(
        LicenseInfo? license,
        UserLicenseStatus? user,
        bool deviceActivated,
        DateTime utcNow)
    {
        if (user == null || string.IsNullOrWhiteSpace(user.UserId))
            return Invalid("inactive", "Kein eingeloggter Firebase-Nutzer.");

        if (user.IsBlocked)
            return Invalid("blocked", "Konto wurde gesperrt. Bitte Support kontaktieren.");

        if (license == null || string.IsNullOrWhiteSpace(license.UserId))
            return Invalid("inactive", "Keine gültige Lizenz gefunden.");

        if (!ActiveTypes.Contains(license.LicenseType))
            return Invalid("inactive", "Keine gültige Lizenz gefunden.");

        var status = (license.LicenseStatus ?? string.Empty).Trim().ToLowerInvariant();
        if (status == "blocked")
            return Invalid("blocked", "Konto wurde gesperrt. Bitte Support kontaktieren.");
        if (status == "expired" || license.LicenseEndDate is { } end && end <= utcNow)
            return Invalid("expired", "Lizenz abgelaufen.", license.LicenseEndDate);
        if (status is not ("active" or "trial" or "restricted"))
            return Invalid(status.Length == 0 ? "inactive" : status, "Keine gültige Lizenz gefunden.");

        if (!deviceActivated)
        {
            var canActivate = license.CurrentDeviceCount < Math.Max(1, license.MaxDevices);
            return new LicenseCheckResult
            {
                IsValid = false,
                Status = status,
                Message = canActivate
                    ? "Dieses Gerät ist nicht für diese Lizenz aktiviert."
                    : "Maximale Geräteanzahl erreicht.",
                ValidUntil = license.LicenseEndDate,
                DeviceActivated = false,
                CanActivateDevice = canActivate
            };
        }

        var message = status == "trial"
            ? $"Testversion aktiv bis {license.LicenseEndDate?.ToLocalTime():dd.MM.yyyy}."
            : status == "restricted"
                ? "Testphase beendet. Vorhandene Tests bleiben nutzbar."
                : "Lizenz aktiv.";
        return new LicenseCheckResult
        {
            IsValid = true,
            Status = status,
            Message = message,
            ValidUntil = license.LicenseEndDate,
            DeviceActivated = true,
            CanActivateDevice = true
        };
    }

    public static bool RequiresTermsAcceptance(
        TermsAcceptance? acceptance,
        AppConfig config)
    {
        return acceptance == null ||
               !string.Equals(acceptance.TermsVersion, config.CurrentTermsVersion, StringComparison.Ordinal) ||
               !string.Equals(acceptance.PrivacyVersion, config.CurrentPrivacyVersion, StringComparison.Ordinal);
    }

    public static LicenseCheckResult EvaluateOffline(
        LicenseCacheEntry? cache,
        string userId,
        string deviceId,
        DateTime utcNow)
    {
        if (cache == null)
            return OnlineRequired();

        var snapshot = cache.Snapshot;
        var allowedDays = Math.Clamp(snapshot.AppConfig.AllowedOfflineDays, 0, 30);
        if (cache.LastSuccessfulOnlineCheck.AddDays(allowedDays) < utcNow)
            return OnlineRequired();
        if (!string.Equals(snapshot.User.UserId, userId, StringComparison.Ordinal) ||
            !string.Equals(snapshot.Device?.DeviceId, deviceId, StringComparison.Ordinal))
            return OnlineRequired();

        var result = Evaluate(snapshot.License, snapshot.User, snapshot.Result.DeviceActivated, utcNow);
        result.RequiresTermsAcceptance = RequiresTermsAcceptance(snapshot.TermsAcceptance, snapshot.AppConfig);
        result.RequiresOnlineCheck = snapshot.License.ServerValidationRequired;
        if (result.RequiresOnlineCheck)
        {
            result.IsValid = false;
            result.Message = "Online-Prüfung erforderlich. Bitte mit dem Internet verbinden.";
        }
        return result;
    }

    private static LicenseCheckResult Invalid(string status, string message, DateTime? validUntil = null) =>
        new()
        {
            IsValid = false,
            Status = status,
            Message = message,
            ValidUntil = validUntil
        };

    private static LicenseCheckResult OnlineRequired() =>
        new()
        {
            IsValid = false,
            Status = "offline-check-required",
            Message = "Online-Prüfung erforderlich. Bitte mit dem Internet verbinden.",
            RequiresOnlineCheck = true
        };
}
