using System.Net.Mail;
using System.Reflection;
using MediTest.Models;

namespace MediTest.Services;

public sealed class ProductInfoService
{
    private readonly IConfiguration _configuration;

    public ProductInfoService(IConfiguration configuration)
    {
        _configuration = configuration;
    }

    public AppLegalInfo GetLegalInfo()
    {
        var info = new AppLegalInfo();
        _configuration.GetSection("Product").Bind(info);
        _configuration.GetSection("Legal").Bind(info);

        info.ProductName = ValueOr(info.ProductName, global::MediTest.Brand.ProductName);
        info.ProductVersion = ValueOr(info.ProductVersion, AssemblyVersion());
        info.DeveloperName = ValueOr(info.DeveloperName, "Lukas Hofer");
        info.LegalOwner = ValueOr(info.LegalOwner, "Lukas Hofer");
        info.Country = ValueOr(info.Country, "Österreich");
        info.CopyrightText = ValueOr(info.CopyrightText, "© 2026 Lukas Hofer. Alle Rechte vorbehalten.");
        info.ConfigurationWarnings = Validate(info);
        return info;
    }

    public AppConfig GetAppConfig()
    {
        var config = new AppConfig();
        _configuration.GetSection("Licensing").Bind(config);
        var legal = GetLegalInfo();
        config.CurrentAppVersion = ValueOr(config.CurrentAppVersion, legal.ProductVersion);
        config.SupportEmail = ValueOr(config.SupportEmail, legal.SupportEmail);
        config.TermsOfUseUrl = ValueOr(config.TermsOfUseUrl, legal.TermsOfUseUrl);
        config.PrivacyPolicyUrl = ValueOr(config.PrivacyPolicyUrl, legal.PrivacyPolicyUrl);
        config.ImpressumUrl = ValueOr(config.ImpressumUrl, legal.ImpressumUrl);
        config.LicenseAgreementUrl = ValueOr(config.LicenseAgreementUrl, legal.LicenseAgreementUrl);
        config.AllowedOfflineDays = Math.Clamp(config.AllowedOfflineDays, 0, 30);
        config.DefaultMaxDevices = Math.Clamp(config.DefaultMaxDevices, 1, 20);
        config.TrialDurationDays = Math.Clamp(config.TrialDurationDays, 1, 60);
        return config;
    }

    private static List<string> Validate(AppLegalInfo info)
    {
        var warnings = new List<string>();
        ValidateEmail(info.SupportEmail, "Support-E-Mail", warnings);
        ValidateEmail(info.ContactEmail, "Kontakt-E-Mail", warnings);
        ValidateUrl(info.WebsiteUrl, "Website", warnings);
        ValidateUrl(info.ImpressumUrl, "Impressum", warnings);
        ValidateUrl(info.PrivacyPolicyUrl, "Datenschutz", warnings);
        ValidateUrl(info.TermsOfUseUrl, "AGB", warnings);
        ValidateUrl(info.LicenseAgreementUrl, "Lizenzbedingungen", warnings);
        ValidateUrl(info.RefundPolicyUrl, "Rückerstattung", warnings);
        return warnings;
    }

    private static void ValidateEmail(string value, string label, List<string> warnings)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        try
        {
            _ = new MailAddress(value);
        }
        catch
        {
            warnings.Add($"{label} ist ungültig.");
        }
    }

    private static void ValidateUrl(string value, string label, List<string> warnings)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            warnings.Add($"{label}-URL ist ungültig.");
        }
    }

    private static string AssemblyVersion()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var version = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        return string.IsNullOrWhiteSpace(version)
            ? assembly.GetName().Version?.ToString(3) ?? "0.0.0"
            : version.Split('+', 2)[0];
    }

    private static string ValueOr(string? value, string fallback) =>
        string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
}
