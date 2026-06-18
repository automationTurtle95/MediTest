using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediTest.Dtos;
using MediTest.Models;
using MediTest.Services;

namespace MediTest;

internal static class AppSupport
{
    internal static Process? OpenBrowser(string url)
    {
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows))
        {
            var edgePaths = new[]
            {
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Microsoft", "Edge", "Application", "msedge.exe"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Edge", "Application", "msedge.exe")
            };
            var edgePath = edgePaths.FirstOrDefault(File.Exists);
            if (!string.IsNullOrWhiteSpace(edgePath))
            {
                try
                {
                    var profilePath = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "MediTest",
                        "BrowserProfile");
                    Directory.CreateDirectory(profilePath);

                    var startInfo = new ProcessStartInfo
                    {
                        FileName = edgePath,
                        UseShellExecute = false,
                        CreateNoWindow = true
                    };
                    startInfo.ArgumentList.Add($"--app={url}");
                    startInfo.ArgumentList.Add($"--user-data-dir={profilePath}");
                    startInfo.ArgumentList.Add("--no-first-run");
                    startInfo.ArgumentList.Add("--disable-session-crashed-bubble");
                    return Process.Start(startInfo);
                }
                catch
                {
                    // Fall through to the system browser.
                }
            }
        }

        try
        {
            Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
        }
        catch { }
        return null;
    }

    internal static void CloseManagedBrowser(Process? browserProcess)
    {
        if (browserProcess == null) return;
        try
        {
            if (browserProcess.HasExited) return;
            browserProcess.Kill(entireProcessTree: true);
            browserProcess.WaitForExit(3000);
        }
        catch { }
        finally
        {
            browserProcess.Dispose();
        }
    }

    internal static void CloseOtherMediTestInstances()
    {
        using var current = Process.GetCurrentProcess();
        string? currentPath;
        try
        {
            currentPath = current.MainModule?.FileName;
        }
        catch
        {
            return;
        }

        if (string.IsNullOrWhiteSpace(currentPath)) return;
        foreach (var process in Process.GetProcessesByName(current.ProcessName))
        {
            using (process)
            {
                if (process.Id == current.Id) continue;
                try
                {
                    var processPath = process.MainModule?.FileName;
                    if (!string.Equals(processPath, currentPath, StringComparison.OrdinalIgnoreCase)) continue;
                    process.Kill(entireProcessTree: true);
                    process.WaitForExit(3000);
                }
                catch { }
            }
        }
    }

    internal static string SingleInstanceName()
    {
        var path = Path.GetFullPath(AppContext.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(path)))[..16];
        return $"MediTest.SingleInstance.{hash}";
    }

    internal static bool AllowedFile(IFormFile file)
    {
        var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
        return ext is ".pdf" or ".pptx" or ".txt";
    }

    internal static bool IsPublicRequest(HttpContext context)
    {
        var path = context.Request.Path;
        if (path.Equals("/api/auth/config")) return true;
        if (path.Equals("/api/app/info")) return true;
        if (path.StartsWithSegments("/api/system/shutdown")) return true;
        if (path.StartsWithSegments("/api/system/update")) return true;
        if (path.StartsWithSegments("/css")) return true;
        if (path.StartsWithSegments("/js")) return true;
        if (path.StartsWithSegments("/assets")) return true;
        if (path.Equals("/favicon.ico")) return true;
        if (path.Equals("/pages/login.html")) return true;
        return false;
    }

    internal static bool IsApiRequest(HttpContext context)
    {
        return context.Request.Path.StartsWithSegments("/api");
    }

    internal static bool RequiresLicenseGate(HttpContext context)
    {
        if (!IsApiRequest(context) || context.User.Identity?.IsAuthenticated != true) return false;
        var path = context.Request.Path;
        return !path.StartsWithSegments("/api/auth") &&
               !path.StartsWithSegments("/api/legal-license") &&
               !path.StartsWithSegments("/api/license") &&
               !path.StartsWithSegments("/api/account") &&
               !path.StartsWithSegments("/api/trial-feedback") &&
               !path.StartsWithSegments("/api/support") &&
               !path.StartsWithSegments("/api/system");
    }

    internal static string FirebaseProjectId(IConfiguration cfg)
    {
        return (cfg["Auth:Firebase:ProjectId"] ?? string.Empty).Trim();
    }

    internal static AuthConfigDto ToAuthConfigDto(IConfiguration cfg)
    {
        var mode = (cfg["Auth:Mode"] ?? "firebase").Trim().ToLowerInvariant();
        var sessionPersistence = (cfg["Auth:SessionPersistence"] ?? "session").Trim().ToLowerInvariant();
        if (sessionPersistence != "session") sessionPersistence = "session";

        var firebase = ToFirebaseConfigDto(cfg);
        return new AuthConfigDto(
            mode,
            firebase != null,
            cfg.GetValue<bool?>("Auth:RegistrationEnabled") ?? true,
            sessionPersistence,
            firebase);
    }

    internal static FirebaseConfigDto? ToFirebaseConfigDto(IConfiguration cfg)
    {
        var apiKey = (cfg["Auth:Firebase:ApiKey"] ?? string.Empty).Trim();
        var projectId = FirebaseProjectId(cfg);
        if (string.IsNullOrWhiteSpace(apiKey) || string.IsNullOrWhiteSpace(projectId)) return null;

        return new FirebaseConfigDto(
            apiKey,
            (cfg["Auth:Firebase:AuthDomain"] ?? string.Empty).Trim(),
            projectId,
            (cfg["Auth:Firebase:StorageBucket"] ?? string.Empty).Trim(),
            (cfg["Auth:Firebase:MessagingSenderId"] ?? string.Empty).Trim(),
            (cfg["Auth:Firebase:AppId"] ?? string.Empty).Trim(),
            (cfg["Auth:Firebase:MeasurementId"] ?? string.Empty).Trim(),
            cfg.GetValue<bool?>("Auth:Firebase:GoogleEnabled") ?? false,
            cfg.GetValue<bool?>("Auth:Firebase:AppleEnabled") ?? false);
    }

    internal static AuthUserDto ToFirebaseUserDto(ClaimsPrincipal principal, IConfiguration cfg)
    {
        var userId = FirstClaim(principal, "user_id", ClaimTypes.NameIdentifier, "sub");
        var email = FirstClaim(principal, "email", ClaimTypes.Email);
        var displayName = FirstClaim(principal, "name", "displayName");
        if (string.IsNullOrWhiteSpace(displayName)) displayName = email.Split('@', 2)[0];
        if (string.IsNullOrWhiteSpace(displayName)) displayName = $"{Brand.ProductName} Nutzer";

        var expiresAt = DateTime.UtcNow.AddHours(1);
        var exp = FirstClaim(principal, "exp");
        if (long.TryParse(exp, out var expSeconds))
            expiresAt = DateTimeOffset.FromUnixTimeSeconds(expSeconds).UtcDateTime;

        var subscriptionActive = IsTruthy(FirstClaim(principal, "subscriptionActive", "subscribed", "paid"));
        var admin = IsTruthy(FirstClaim(principal, "admin", "isAdmin"));
        var plan = subscriptionActive || admin ? "Premium" : "Testphase";
        var licenseStatus = subscriptionActive || admin ? "Aktiv" : "Testphase";

        return new AuthUserDto(
            string.IsNullOrWhiteSpace(userId) ? email : userId,
            email,
            displayName,
            plan,
            licenseStatus,
            (cfg["Auth:Mode"] ?? "firebase").Trim().ToLowerInvariant(),
            FirebaseEmailVerified(principal),
            expiresAt);
    }

    internal static bool FirebaseEmailVerified(ClaimsPrincipal principal)
    {
        return IsTruthy(FirstClaim(principal, "email_verified", "emailVerified"));
    }

    internal static string FirstClaim(ClaimsPrincipal principal, params string[] names)
    {
        foreach (var name in names)
        {
            var value = principal.FindFirst(name)?.Value;
            if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
        }

        return string.Empty;
    }

    internal static string AppVersion()
    {
        var assembly = Assembly.GetExecutingAssembly();
        var informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
        if (!string.IsNullOrWhiteSpace(informational)) return informational.Split('+', 2)[0].Trim();
        return assembly.GetName().Version?.ToString(3) ?? "0.0.0";
    }

    internal static string CurrentUpdatePlatform()
    {
        var arch = RuntimeInformation.ProcessArchitecture;
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows) && arch == Architecture.X64) return "windows-x64";
        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX) && arch == Architecture.Arm64) return "macos-arm64";
        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX) && arch == Architecture.X64) return "macos-x64";
        if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return $"windows-{arch.ToString().ToLowerInvariant()}";
        if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX)) return $"macos-{arch.ToString().ToLowerInvariant()}";
        return $"{RuntimeInformation.OSDescription}-{arch}".ToLowerInvariant().Replace(' ', '-');
    }

    internal static string UpdateManifestUrl(IConfiguration cfg)
    {
        if (!(cfg.GetValue<bool?>("Updates:Enabled") ?? false)) return string.Empty;

        var manifestUrl = (cfg["Updates:ManifestUrl"] ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(manifestUrl)) return manifestUrl;

        var repo = (cfg["Updates:GitHubRepository"] ?? string.Empty).Trim().Trim('/');
        if (string.IsNullOrWhiteSpace(repo)) return string.Empty;
        return $"https://api.github.com/repos/{repo}/releases/latest";
    }

    internal static async Task<UpdateCheckDto> CheckForUpdateAsync(IConfiguration cfg, IHttpClientFactory httpClientFactory, CancellationToken ct)
    {
        var currentVersion = AppVersion();
        var currentPlatform = CurrentUpdatePlatform();
        var manifestUrl = UpdateManifestUrl(cfg);
        if (string.IsNullOrWhiteSpace(manifestUrl))
        {
            return new UpdateCheckDto(
                false,
                currentVersion,
                currentPlatform,
                null,
                false,
                null,
                null,
                null,
                null,
                [],
                "Update-Prüfung ist noch nicht konfiguriert.");
        }

        try
        {
            var client = httpClientFactory.CreateClient();
            using var request = new HttpRequestMessage(HttpMethod.Get, manifestUrl);
            request.Headers.TryAddWithoutValidation("Accept", "application/json");
            request.Headers.TryAddWithoutValidation("User-Agent", $"{Brand.ProductName}/{currentVersion}");

            using var response = await client.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                return new UpdateCheckDto(
                    true,
                    currentVersion,
                    currentPlatform,
                    null,
                    false,
                    null,
                    null,
                    null,
                    null,
                    [],
                    $"Update-Quelle konnte nicht gelesen werden (HTTP {(int)response.StatusCode}).");
            }

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            using var json = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
            var manifest = ParseUpdateManifest(json.RootElement);
            if (string.IsNullOrWhiteSpace(manifest.Version))
            {
                return new UpdateCheckDto(
                    true,
                    currentVersion,
                    currentPlatform,
                    null,
                    false,
                    null,
                    null,
                    manifest.ReleaseUrl,
                    null,
                    manifest.Downloads,
                    "Update-Quelle enthält keine Versionsnummer.");
            }

            var recommended = manifest.Downloads.FirstOrDefault(d => string.Equals(d.Platform, currentPlatform, StringComparison.OrdinalIgnoreCase))
                ?? manifest.Downloads.FirstOrDefault();
            var updateAvailable = CompareVersions(manifest.Version, currentVersion) > 0;
            var message = updateAvailable
                ? $"Version {manifest.Version} ist verfügbar."
                : $"{Brand.ProductName} ist aktuell ({currentVersion}).";

            return new UpdateCheckDto(
                true,
                currentVersion,
                currentPlatform,
                manifest.Version,
                updateAvailable,
                manifest.ReleaseDate,
                manifest.Notes,
                manifest.ReleaseUrl,
                recommended,
                manifest.Downloads,
                message);
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or UriFormatException)
        {
            return new UpdateCheckDto(
                true,
                currentVersion,
                currentPlatform,
                null,
                false,
                null,
                null,
                null,
                null,
                [],
                $"Update-Prüfung fehlgeschlagen: {ex.Message}");
        }
    }

    internal static UpdateManifest ParseUpdateManifest(JsonElement root)
    {
        var version = JsonText(root, "version");
        if (string.IsNullOrWhiteSpace(version)) version = JsonText(root, "tag_name").TrimStart('v', 'V');

        var releaseDate = JsonText(root, "releaseDate");
        if (string.IsNullOrWhiteSpace(releaseDate)) releaseDate = JsonText(root, "published_at");

        var notes = JsonText(root, "notes");
        if (string.IsNullOrWhiteSpace(notes)) notes = JsonText(root, "body");

        var releaseUrl = JsonText(root, "releaseUrl");
        if (string.IsNullOrWhiteSpace(releaseUrl)) releaseUrl = JsonText(root, "html_url");

        var downloads = new List<UpdateDownloadDto>();
        if (root.TryGetProperty("downloads", out var downloadsElement) && downloadsElement.ValueKind == JsonValueKind.Object)
        {
            foreach (var download in downloadsElement.EnumerateObject())
                downloads.Add(ParseDownload(download.Name, download.Value));
        }

        if (downloads.Count == 0 && root.TryGetProperty("assets", out var assetsElement) && assetsElement.ValueKind == JsonValueKind.Array)
        {
            foreach (var asset in assetsElement.EnumerateArray())
            {
                var fileName = JsonText(asset, "name");
                var url = JsonText(asset, "browser_download_url");
                var platform = PlatformFromFileName(fileName);
                if (!string.IsNullOrWhiteSpace(platform) && !string.IsNullOrWhiteSpace(url))
                    downloads.Add(new UpdateDownloadDto(platform, url, fileName, string.Empty, JsonLong(asset, "size")));
            }
        }

        return new UpdateManifest(version.TrimStart('v', 'V'), releaseDate, notes, releaseUrl, downloads);
    }

    internal static UpdateDownloadDto ParseDownload(string platform, JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.String)
        {
            var url = element.GetString() ?? string.Empty;
            return new UpdateDownloadDto(platform, url, FileNameFromUrl(url), string.Empty, 0);
        }

        if (element.ValueKind != JsonValueKind.Object)
            return new UpdateDownloadDto(platform, string.Empty, string.Empty, string.Empty, 0);

        var urlValue = JsonText(element, "url");
        if (string.IsNullOrWhiteSpace(urlValue)) urlValue = JsonText(element, "browserDownloadUrl");
        if (string.IsNullOrWhiteSpace(urlValue)) urlValue = JsonText(element, "downloadUrl");

        var fileName = JsonText(element, "fileName");
        if (string.IsNullOrWhiteSpace(fileName)) fileName = JsonText(element, "name");
        if (string.IsNullOrWhiteSpace(fileName)) fileName = FileNameFromUrl(urlValue);

        var sha256 = JsonText(element, "sha256");
        if (string.IsNullOrWhiteSpace(sha256)) sha256 = JsonText(element, "sha256sum");

        return new UpdateDownloadDto(platform, urlValue, fileName, sha256, JsonLong(element, "sizeBytes"));
    }

    internal static string PlatformFromFileName(string fileName)
    {
        fileName = (fileName ?? string.Empty).ToLowerInvariant();
        if (fileName.EndsWith(".msi") && fileName.Contains("win-x64")) return "windows-x64";
        if (fileName.Contains("macos-arm64")) return "macos-arm64";
        if (fileName.Contains("macos-x64")) return "macos-x64";
        return string.Empty;
    }

    internal static string FileNameFromUrl(string url)
    {
        if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
            return Uri.UnescapeDataString(Path.GetFileName(uri.LocalPath));
        return Path.GetFileName(url.Split('?', 2)[0]);
    }

    internal static string JsonText(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value)) return string.Empty;
        return value.ValueKind switch
        {
            JsonValueKind.String => value.GetString() ?? string.Empty,
            JsonValueKind.Number => value.GetRawText(),
            JsonValueKind.True => "true",
            JsonValueKind.False => "false",
            _ => string.Empty
        };
    }

    internal static long JsonLong(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var value)) return 0;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var parsed)) return parsed;
        if (value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return parsed;
        return 0;
    }

    internal static int CompareVersions(string left, string right)
    {
        var leftParts = VersionParts(left);
        var rightParts = VersionParts(right);
        for (var i = 0; i < Math.Max(leftParts.Count, rightParts.Count); i++)
        {
            var l = i < leftParts.Count ? leftParts[i] : 0;
            var r = i < rightParts.Count ? rightParts[i] : 0;
            if (l != r) return l.CompareTo(r);
        }

        return 0;
    }

    internal static List<int> VersionParts(string value)
    {
        value = (value ?? string.Empty).Trim().TrimStart('v', 'V').Split('+', 2)[0].Split('-', 2)[0];
        return value.Split('.', StringSplitOptions.RemoveEmptyEntries)
            .Select(part => int.TryParse(part, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) ? number : 0)
            .ToList();
    }

    internal static bool ApplyFixedAiSettings(ProgramSettings settings)
    {
        var changed = false;
        if (settings.AiProvider != AiProviderCatalog.FirebaseProvider)
        {
            settings.AiProvider = AiProviderCatalog.FirebaseProvider;
            changed = true;
        }
        if (settings.OpenAiModel != AiProviderCatalog.DefaultModel)
        {
            settings.OpenAiModel = AiProviderCatalog.DefaultModel;
            changed = true;
        }
        if (settings.AiApiBaseUrl != AiProviderCatalog.FirebaseFunctionUrl)
        {
            settings.AiApiBaseUrl = AiProviderCatalog.FirebaseFunctionUrl;
            changed = true;
        }
        if (!string.IsNullOrWhiteSpace(settings.OpenAiApiKey))
        {
            settings.OpenAiApiKey = string.Empty;
            changed = true;
        }
        if (settings.AllowLocalFallback)
        {
            settings.AllowLocalFallback = false;
            changed = true;
        }
        return changed;
    }

    internal static ProgramSettingsDto ToProgramSettingsDto(ProgramSettings settings)
    {
        var provider = AiProviderCatalog.NormalizeProvider(settings.AiProvider);
        var model = AiProviderCatalog.NormalizeModel(provider, settings.OpenAiModel);
        var providers = AiProviderCatalog.Options
            .Select(p => new AiProviderOptionDto(
                p.Id,
                p.Label,
                p.UsesCustomBaseUrl,
                p.Models.Select(m => new AiModelOptionDto(m.Value, m.Label)).ToList()))
            .ToList();

        return new ProgramSettingsDto(
            settings.DisplayName,
            settings.MatriculationNumber,
            settings.StudyProgram,
            settings.University,
            settings.Semester,
            settings.Email,
            settings.Theme,
            settings.DefaultGenerateQuestionCount,
            settings.DefaultTestQuestionCount,
            !string.IsNullOrWhiteSpace(settings.OpenAiApiKey),
            MaskApiKey(settings.OpenAiApiKey),
            model,
            provider,
            model,
            settings.AiApiBaseUrl,
            providers,
            settings.AllowLocalFallback,
            UserOnboardingPolicy.IsProfileComplete(settings),
            settings.ProfileCompletedAt,
            settings.TrialFeedbackPromptedAt,
            settings.TrialFeedbackNextPromptAt,
            settings.TrialFeedbackSubmittedAt,
            settings.UpdatedAt,
            settings.DailyGoalQuestions);
    }

    internal static LicenseStatusDto ToLicenseStatusDto(UserLicenseState state, HttpContext context, IConfiguration cfg)
    {
        var claimSubscription = IsTruthy(FirstClaim(context.User, "subscriptionActive", "subscribed", "paid"));
        var claimPremium = IsTruthy(FirstClaim(context.User, "premiumActive", "premium"));
        var admin = UserCanPublishCatalog(context, cfg);
        var premiumActive = claimPremium || state.PremiumActive;
        var subscriptionActive = admin || premiumActive || claimSubscription || state.SubscriptionActive;
        var now = DateTime.UtcNow;
        var trialActive = state.BaseProductPurchased && state.TrialEndsAt is { } trialEnd && now < trialEnd;
        var daysRemaining = trialActive && state.TrialEndsAt is { } activeTrialEnd
            ? Math.Max(0, (int)Math.Ceiling((activeTrialEnd - now).TotalDays))
            : 0;
        var accessActive = subscriptionActive || trialActive;
        var restrictedMode = state.BaseProductPurchased && !accessActive;
        var status = premiumActive ? "premium" :
            subscriptionActive ? "active" :
            trialActive ? "trial" :
            restrictedMode ? "restricted" : "inactive";
        var plan = premiumActive ? "Premium" :
            subscriptionActive ? "Premium" :
            trialActive ? "Testphase" :
            restrictedMode ? "Basis" : "Nicht gekauft";
        var checkoutConfigured = cfg.GetValue<bool?>("Billing:StripeEnabled") ?? false;
        var message = status switch
        {
            "premium" => "Premium aktiv. Katalogtests bleiben separate Kaufartikel.",
            "active" => $"Monatsabo aktiv. Alle {Brand.ProductName}-Funktionen sind verfügbar.",
            "trial" => $"7-tägige Testphase aktiv: noch {daysRemaining} Tag(e).",
            "restricted" => "Testphase beendet. Tests und Lernrunden aus vorhandenen Fragenpools bleiben ausführbar; alle anderen Funktionen benötigen ein Abo.",
            _ => $"{Brand.ProductName} wurde für dieses Konto noch nicht gekauft."
        };

        return new LicenseStatusDto(
            plan,
            status,
            accessActive,
            restrictedMode,
            state.BaseProductPurchased,
            state.BaseProductPurchasedAt,
            subscriptionActive,
            premiumActive,
            state.TrialStartedAt,
            state.TrialEndsAt,
            daysRemaining,
            state.ProductPriceCents > 0 ? state.ProductPriceCents : BillingProductPriceCents(cfg),
            state.MonthlyPriceCents > 0 ? state.MonthlyPriceCents : BillingMonthlyPriceCents(cfg),
            BillingCatalogExamplePriceCents(cfg),
            BillingCatalogQuestionPriceCents(cfg),
            BillingCatalogPriceEndingCents(cfg),
            BillingCatalogExampleQuestionCount(cfg),
            string.IsNullOrWhiteSpace(state.Currency) ? BillingCurrency(cfg) : state.Currency.Trim().ToUpperInvariant(),
            checkoutConfigured,
            FreeCatalogCreditAvailable(state),
            !string.IsNullOrWhiteSpace(state.FreeCatalogCreditRedeemedCatalogId),
            state.FreeCatalogCreditRedeemedCatalogId,
            state.FreeCatalogCreditGrantedAt,
            state.FreeCatalogCreditRedeemedAt,
            message);
    }

    internal static string TrimTo(string? value, int maxLength)
    {
        value = (value ?? string.Empty).Trim();
        return value.Length <= maxLength ? value : value[..maxLength];
    }

    internal static string NormalizeTheme(string? theme)
    {
        theme = (theme ?? "system").Trim().ToLowerInvariant();
        return theme is "light" or "dark" or "system" ? theme : "system";
    }

    internal static string TopicLabel(string? topic)
    {
        topic = (topic ?? string.Empty).Trim();
        return string.IsNullOrWhiteSpace(topic) ? "Allgemein" : topic;
    }

    internal static string CatalogCategory(string? category)
    {
        category = (category ?? string.Empty).Trim();
        return category.Equals("MedAT", StringComparison.OrdinalIgnoreCase) ? "MedAT" : "Allgemein";
    }

    internal static string CatalogFolderPath(string category, string? folderPath, string? topic)
    {
        var root = CatalogCategory(category);
        var rawSegments = (folderPath ?? string.Empty)
            .Replace('\\', '/')
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var segments = rawSegments
            .Select(segment => Regex.Replace(segment, @"\s+", " ").Trim())
            .Where(segment => !string.IsNullOrWhiteSpace(segment) && segment is not "." and not "..")
            .Select(segment => TrimTo(segment, 80))
            .Take(5)
            .ToList();

        if (segments.Count > 0 &&
            (segments[0].Equals(root, StringComparison.OrdinalIgnoreCase) ||
             (root == "Allgemein" && segments[0].Equals("Weitere Tests", StringComparison.OrdinalIgnoreCase))))
        {
            segments.RemoveAt(0);
        }

        if (segments.Count == 0)
        {
            var topicSegment = TopicLabel(topic);
            if (!topicSegment.Equals("Allgemein", StringComparison.OrdinalIgnoreCase))
                segments.Add(TrimTo(topicSegment, 80));
        }

        return string.Join('/', new[] { root }.Concat(segments));
    }

    internal static string DocumentFolderPath(string? folderPath)
    {
        var segments = (folderPath ?? string.Empty)
            .Replace('\\', '/')
            .Split('/', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(segment => Regex.Replace(segment, @"\s+", " ").Trim())
            .Where(segment => !string.IsNullOrWhiteSpace(segment) && segment is not "." and not "..")
            .Select(segment => TrimTo(segment, 80))
            .Take(6);
        return string.Join('/', segments);
    }

    internal static string DifficultyLabel(string? difficulty)
    {
        difficulty = (difficulty ?? "mittel").Trim().ToLowerInvariant();
        return difficulty is "leicht" or "mittel" or "schwer" ? difficulty : "mittel";
    }

    internal static int NormalizeQuestionCount(int value, int fallback)
    {
        return Math.Clamp(value <= 0 ? fallback : value, 1, 100);
    }

    internal static string? ValidateQuestionImage(string? imageDataUrl)
    {
        imageDataUrl = (imageDataUrl ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(imageDataUrl)) return null;

        var match = Regex.Match(imageDataUrl, "^data:(image\\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\\r\\n]+)$", RegexOptions.IgnoreCase);
        if (!match.Success) return "Das Bild muss PNG, JPEG, WebP oder GIF sein.";

        try
        {
            var rawBytes = Convert.FromBase64String(match.Groups[2].Value);
            if (rawBytes.Length > 600 * 1024) return "Das Bild ist zu groß. Maximum: 600 KB.";
        }
        catch
        {
            return "Das Bild konnte nicht gelesen werden.";
        }

        return null;
    }

    internal static string? EmptyToNull(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;

    internal static int BillingTrialDays(IConfiguration cfg) => Math.Clamp(cfg.GetValue<int?>("Billing:TrialDays") ?? 7, 1, 60);
    internal static int BillingProductPriceCents(IConfiguration cfg) => Math.Max(0, cfg.GetValue<int?>("Billing:ProductPriceCents") ?? CommercialPricing.ProductPriceCents);
    internal static int BillingMonthlyPriceCents(IConfiguration cfg) => Math.Max(0, cfg.GetValue<int?>("Billing:MonthlyPriceCents") ?? CommercialPricing.MonthlyPriceCents);
    internal static int BillingCatalogQuestionPriceCents(IConfiguration cfg) => Math.Max(0, cfg.GetValue<int?>("Billing:CatalogQuestionPriceCents") ?? 10);
    internal static int BillingCatalogPriceEndingCents(IConfiguration cfg) => Math.Max(0, cfg.GetValue<int?>("Billing:CatalogPriceEndingCents") ?? 9);
    internal static int BillingCatalogExampleQuestionCount(IConfiguration cfg) => Math.Clamp(cfg.GetValue<int?>("Billing:CatalogPriceExampleQuestionCount") ?? 25, 1, 1000);
    internal static int BillingCatalogExamplePriceCents(IConfiguration cfg) => BillingCatalogTestPriceCents(cfg, "Allgemein", BillingCatalogExampleQuestionCount(cfg));
    internal static int BillingMedAtCatalogPriceCents(IConfiguration cfg) => Math.Max(0, cfg.GetValue<int?>("Billing:MedAtCatalogPriceCents") ?? 4999);
    internal static int BillingCatalogTestPriceCents(IConfiguration cfg, string category, int questionCount)
    {
        if (string.Equals(category, "MedAT", StringComparison.OrdinalIgnoreCase))
            return BillingMedAtCatalogPriceCents(cfg);
        if (questionCount <= 0) return 0;
        var cents = (long)questionCount * BillingCatalogQuestionPriceCents(cfg) + BillingCatalogPriceEndingCents(cfg);
        return cents > int.MaxValue ? int.MaxValue : (int)cents;
    }
    internal static string BillingCurrency(IConfiguration cfg) => string.IsNullOrWhiteSpace(cfg["Billing:Currency"]) ? CommercialPricing.Currency : cfg["Billing:Currency"]!.Trim().ToUpperInvariant();
    internal static bool BillingEnforcesCatalogPurchases(IConfiguration cfg) => cfg.GetValue<bool?>("Billing:EnforceCatalogPurchases") ?? true;

    internal static bool FreeCatalogCreditAvailable(UserLicenseState state)
    {
        return state.FreeCatalogCreditActive && string.IsNullOrWhiteSpace(state.FreeCatalogCreditRedeemedCatalogId);
    }

    internal static string NormalizePremiumCode(string? code)
    {
        return Regex.Replace((code ?? string.Empty).Trim().ToUpperInvariant(), "[^A-Z0-9]", string.Empty);
    }

    internal static string FirebaseFunctionUrl(IConfiguration cfg, string configKey, string functionName)
    {
        var configured = (cfg[configKey] ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(configured)) return configured;
        return $"https://europe-west3-{FirebaseProjectId(cfg)}.cloudfunctions.net/{functionName}";
    }

    internal static CheckoutLinkDto ParseCheckoutLink(JsonDocument? json, string fallbackMessage)
    {
        if (json == null) return new CheckoutLinkDto(false, null, fallbackMessage);
        var root = json.RootElement;
        var available = root.TryGetProperty("available", out var availableElement) && availableElement.ValueKind == JsonValueKind.True;
        var url = root.TryGetProperty("url", out var urlElement) ? urlElement.GetString() : null;
        var message = root.TryGetProperty("message", out var messageElement)
            ? messageElement.GetString() ?? fallbackMessage
            : fallbackMessage;
        return new CheckoutLinkDto(available && !string.IsNullOrWhiteSpace(url), url, message);
    }

    internal static async Task<(JsonDocument? Json, IResult? Error)> SendProtectedFirebaseFunctionAsync(
        IHttpClientFactory httpClientFactory,
        HttpContext context,
        HttpMethod method,
        string url,
        object? body,
        string fallbackError,
        CancellationToken ct)
    {
        var token = FirebaseBearerToken(context);
        if (string.IsNullOrWhiteSpace(token))
            return (null, Results.Unauthorized());

        using var request = new HttpRequestMessage(method, url);
        request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
        if (body != null)
            request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");

        var response = await httpClientFactory.CreateClient().SendAsync(request, ct);
        var raw = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            var message = FirebaseFunctionError(raw, fallbackError);
            return (null, Results.Json(new { error = message }, statusCode: (int)response.StatusCode));
        }

        if (string.IsNullOrWhiteSpace(raw)) return (null, null);
        return (JsonDocument.Parse(raw), null);
    }

    internal static string FirebaseFunctionError(string raw, string fallback)
    {
        try
        {
            using var json = JsonDocument.Parse(raw);
            if (json.RootElement.TryGetProperty("error", out var error))
            {
                if (error.ValueKind == JsonValueKind.String) return error.GetString() ?? fallback;
                if (error.TryGetProperty("message", out var message)) return message.GetString() ?? fallback;
            }
        }
        catch (JsonException) { }
        return string.IsNullOrWhiteSpace(raw) ? fallback : raw;
    }

    internal static async Task<(JsonDocument? Json, IResult? Error)> SendFirestoreAsync(
        HttpClient client,
        IConfiguration cfg,
        HttpContext context,
        HttpMethod method,
        string pathAndQuery,
        object? body,
        string fallbackError,
        CancellationToken ct,
        bool allowNotFound = false)
    {
        var projectId = FirebaseProjectId(cfg);
        if (string.IsNullOrWhiteSpace(projectId))
            return (null, Results.BadRequest(new { error = "Firebase ProjectId ist nicht konfiguriert." }));

        var token = FirebaseBearerToken(context);
        if (string.IsNullOrWhiteSpace(token))
            return (null, Results.Unauthorized());

        var url = $"https://firestore.googleapis.com/v1/projects/{Uri.EscapeDataString(projectId)}/databases/(default)/{pathAndQuery.TrimStart('/')}";
        using var request = new HttpRequestMessage(method, url);
        request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
        if (body != null)
        {
            request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        }

        using var response = await client.SendAsync(request, ct);
        if (allowNotFound && response.StatusCode == HttpStatusCode.NotFound)
            return (null, null);
        if (!response.IsSuccessStatusCode)
            return (null, await FirestoreErrorResultAsync(response, fallbackError, ct));

        var raw = await response.Content.ReadAsStringAsync(ct);
        if (string.IsNullOrWhiteSpace(raw))
            return (null, null);
        var json = JsonDocument.Parse(raw);
        return (json, null);
    }

    internal static string FirebaseBearerToken(HttpContext context)
    {
        if (!context.Request.Headers.TryGetValue("Authorization", out var values)) return string.Empty;
        var authorization = values.ToString();
        const string prefix = "Bearer ";
        return authorization.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? authorization[prefix.Length..].Trim()
            : string.Empty;
    }

    internal static async Task<IResult> FirestoreErrorResultAsync(HttpResponseMessage response, string fallback, CancellationToken ct)
    {
        var raw = await response.Content.ReadAsStringAsync(ct);
        var detail = FirestoreErrorMessage(raw);
        var message = response.StatusCode switch
        {
            HttpStatusCode.Forbidden when fallback.Contains("veröffentlicht", StringComparison.OrdinalIgnoreCase) =>
                "Keine Berechtigung im Firestore-Katalog. Für Veröffentlichungen braucht das Konto den Firebase Custom Claim admin=true.",
            HttpStatusCode.Forbidden =>
                "Keine Berechtigung im Firestore-Katalog. Bitte melde dich neu an und prüfe, ob die Firestore-Regeln veröffentlicht sind.",
            HttpStatusCode.NotFound => "Firestore-Test nicht gefunden.",
            _ => fallback
        };

        if (!string.IsNullOrWhiteSpace(detail)) message += $" ({detail})";
        return Results.Json(new { error = message }, statusCode: (int)response.StatusCode);
    }

    internal static string FirestoreErrorMessage(string raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return string.Empty;
        try
        {
            using var doc = JsonDocument.Parse(raw);
            if (doc.RootElement.TryGetProperty("error", out var error) &&
                error.TryGetProperty("message", out var message))
                return message.GetString() ?? string.Empty;
        }
        catch { }

        return raw.Length <= 240 ? raw : raw[..240];
    }

    internal static string FirestoreDocumentId(JsonElement document)
    {
        if (!document.TryGetProperty("name", out var nameElement)) return string.Empty;
        var name = nameElement.GetString() ?? string.Empty;
        var slash = name.LastIndexOf('/');
        return slash >= 0 ? Uri.UnescapeDataString(name[(slash + 1)..]) : name;
    }

    internal static string FirestoreString(JsonElement fields, string fieldName)
    {
        if (!fields.TryGetProperty(fieldName, out var field)) return string.Empty;
        if (field.TryGetProperty("stringValue", out var stringValue)) return stringValue.GetString() ?? string.Empty;
        if (field.TryGetProperty("integerValue", out var integerValue)) return integerValue.GetString() ?? string.Empty;
        if (field.TryGetProperty("timestampValue", out var timestampValue)) return timestampValue.GetString() ?? string.Empty;
        return string.Empty;
    }

    internal static int FirestoreInt(JsonElement fields, string fieldName)
    {
        if (!fields.TryGetProperty(fieldName, out var field)) return 0;
        if (field.TryGetProperty("integerValue", out var integerValue))
        {
            var raw = integerValue.GetString();
            if (int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)) return parsed;
        }

        if (field.TryGetProperty("doubleValue", out var doubleValue) && doubleValue.TryGetDouble(out var number))
            return (int)Math.Round(number);

        return 0;
    }

    internal static bool FirestoreBool(JsonElement fields, string fieldName, bool fallback = false)
    {
        if (!fields.TryGetProperty(fieldName, out var field)) return fallback;
        return field.TryGetProperty("booleanValue", out var booleanValue) &&
               (booleanValue.ValueKind is JsonValueKind.True or JsonValueKind.False)
            ? booleanValue.GetBoolean()
            : fallback;
    }

    internal static DateTime? FirestoreTimestamp(JsonElement fields, string fieldName)
    {
        var raw = FirestoreString(fields, fieldName);
        if (DateTime.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed))
            return parsed;
        return null;
    }

    internal static object FirestoreValue(string? value) => new Dictionary<string, object>
    {
        ["stringValue"] = value ?? string.Empty
    };

    internal static object FirestoreIntValue(int value) => new Dictionary<string, object>
    {
        ["integerValue"] = value.ToString(CultureInfo.InvariantCulture)
    };

    internal static object FirestoreBoolValue(bool value) => new Dictionary<string, object>
    {
        ["booleanValue"] = value
    };

    internal static object FirestoreTimestampValue(DateTime value) => new Dictionary<string, object>
    {
        ["timestampValue"] = value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture)
    };

    internal static bool UserCanPublishCatalog(HttpContext context, IConfiguration cfg)
    {
        if (context.User.Identity?.IsAuthenticated != true) return false;
        if (IsTruthy(FirstClaim(context.User, "admin", "isAdmin"))) return true;

        var roleValues = context.User.FindAll("role")
            .Concat(context.User.FindAll("roles"))
            .Select(c => c.Value)
            .SelectMany(v => v.Split([',', ';', ' '], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
        if (roleValues.Any(v => string.Equals(v, "admin", StringComparison.OrdinalIgnoreCase))) return true;

        var email = FirstClaim(context.User, "email", ClaimTypes.Email);
        if (string.IsNullOrWhiteSpace(email)) return false;

        var configuredEmails = cfg.GetSection("Auth:AdminEmails")
            .GetChildren()
            .Select(c => c.Value ?? string.Empty)
            .Concat((cfg["Auth:AdminEmails"] ?? string.Empty).Split([',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));

        return configuredEmails.Any(e => string.Equals(e, email, StringComparison.OrdinalIgnoreCase));
    }

    internal static bool IsTruthy(string? value)
    {
        value = (value ?? string.Empty).Trim();
        return value.Equals("true", StringComparison.OrdinalIgnoreCase) ||
               value.Equals("1", StringComparison.OrdinalIgnoreCase) ||
               value.Equals("yes", StringComparison.OrdinalIgnoreCase);
    }

    internal static string[] CatalogCollections() => ["catalogTests", "thematicTests"];

    internal static List<CatalogQuestionPayload> BuildCatalogQuestions(UploadedDocument doc)
    {
        var result = new List<CatalogQuestionPayload>();
        foreach (var question in doc.Questions.OrderBy(q => q.Id))
        {
            var options = question.Options
                .OrderBy(o => o.OptionIndex)
                .Select(o => o.Text.Trim())
                .ToList();
            if (options.Count < 2 || options.Any(string.IsNullOrWhiteSpace)) continue;

            result.Add(new CatalogQuestionPayload(
                question.QuestionText.Trim(),
                options,
                Math.Clamp(question.CorrectOptionIndex, 0, options.Count - 1),
                string.IsNullOrWhiteSpace(question.Explanation) ? $"Aus {Brand.ProductName} veröffentlichte Frage." : question.Explanation.Trim(),
                TopicLabel(question.Topic),
                DifficultyLabel(question.Difficulty),
                question.IsAiGenerated));
        }

        return result;
    }

    internal static List<CatalogQuestionPayload> DeserializeCatalogQuestions(string questionsJson)
    {
        if (string.IsNullOrWhiteSpace(questionsJson)) return [];

        try
        {
            var parsed = JsonSerializer.Deserialize<List<CatalogQuestionPayload>>(questionsJson, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            if (parsed == null) return [];

            return parsed
                .Select(q => new CatalogQuestionPayload(
                    (q.QuestionText ?? string.Empty).Trim(),
                    (q.Options ?? []).Select(o => (o ?? string.Empty).Trim()).ToList(),
                    q.CorrectOptionIndex,
                    (q.Explanation ?? string.Empty).Trim(),
                    TopicLabel(q.Topic),
                    DifficultyLabel(q.Difficulty),
                    q.IsAiGenerated))
                .Where(q => !string.IsNullOrWhiteSpace(q.QuestionText) &&
                            q.Options.Count >= 2 &&
                            q.Options.All(o => !string.IsNullOrWhiteSpace(o)))
                .ToList();
        }
        catch
        {
            return [];
        }
    }

    internal static string Slugify(string value)
    {
        value = (value ?? string.Empty).Trim().ToLowerInvariant()
            .Replace("ä", "ae")
            .Replace("ö", "oe")
            .Replace("ü", "ue")
            .Replace("ß", "ss");
        var slug = Regex.Replace(value, "[^a-z0-9]+", "-").Trim('-');
        if (string.IsNullOrWhiteSpace(slug)) slug = "test";
        return slug.Length <= 80 ? slug : slug[..80].Trim('-');
    }

    internal static string MaskApiKey(string apiKey)
    {
        apiKey = apiKey.Trim();
        if (apiKey.Length == 0) return string.Empty;
        if (apiKey.Length <= 10) return "****";
        return $"{apiKey[..4]}...{apiKey[^4..]}";
    }

    internal static List<(string Question, List<string> Options, int Correct, string Explanation, string Topic, string Difficulty)> ParseImportedQuestions(string content)
    {
        var result = new List<(string, List<string>, int, string, string, string)>();

        string question = string.Empty;
        var options = new List<string>();
        var correct = 0;
        var explanation = "Importierte Frage.";
        var topic = "Import";
        var difficulty = "mittel";

        void Flush()
        {
            if (!string.IsNullOrWhiteSpace(question) && options.Count == 5)
            {
                var d = difficulty is "leicht" or "mittel" or "schwer" ? difficulty : "mittel";
                result.Add((question, options.ToList(), Math.Clamp(correct, 0, 4),
                    string.IsNullOrWhiteSpace(explanation) ? "Importierte Frage." : explanation,
                    string.IsNullOrWhiteSpace(topic) ? "Import" : topic,
                    d));
            }

            question = string.Empty;
            options.Clear();
            correct = 0;
            explanation = "Importierte Frage.";
            topic = "Import";
            difficulty = "mittel";
        }

        foreach (var raw in content.Replace("\r", "").Split('\n'))
        {
            var line = raw.Trim();
            if (string.IsNullOrWhiteSpace(line)) continue;

            var qMatch = Regex.Match(line, "^\\d+\\.\\s*(.+)$");
            if (qMatch.Success)
            {
                Flush();
                question = qMatch.Groups[1].Value.Trim();
                continue;
            }

            if (string.IsNullOrWhiteSpace(question)) continue;

            var oMatch = Regex.Match(line, "^[a-eA-E][\\)\\.\\:]\\s*(.+)$");
            if (oMatch.Success)
            {
                if (options.Count < 5) options.Add(oMatch.Groups[1].Value.Trim());
                continue;
            }

            var correctMatch = Regex.Match(line, "^Richtig\\s*:\\s*([a-eA-E1-5])$");
            if (correctMatch.Success)
            {
                var v = correctMatch.Groups[1].Value.ToLowerInvariant();
                correct = v[0] switch { 'a' => 0, 'b' => 1, 'c' => 2, 'd' => 3, 'e' => 4, '1' => 0, '2' => 1, '3' => 2, '4' => 3, '5' => 4, _ => 0 };
                continue;
            }

            if (line.StartsWith("Thema:", StringComparison.OrdinalIgnoreCase)) { topic = line[6..].Trim(); continue; }
            if (line.StartsWith("Schwierigkeit:", StringComparison.OrdinalIgnoreCase)) { difficulty = line[14..].Trim().ToLowerInvariant(); continue; }
            if (line.StartsWith("Erklärung:", StringComparison.OrdinalIgnoreCase) || line.StartsWith("Erklaerung:", StringComparison.OrdinalIgnoreCase))
            {
                explanation = line[(line.IndexOf(':') + 1)..].Trim();
                continue;
            }
        }

        Flush();
        return result;
    }

    internal static byte[] BuildTestPdf(TestSession session, ProgramSettings settings)
    {
        var writer = new SimplePdfWriter();
        var title = string.IsNullOrWhiteSpace(session.TestName) ? $"Test {session.Id}" : session.TestName;
        var documentName = session.Document?.FileName ?? "(unbekannt)";
        var submitted = session.SubmittedAt != null;
        var answered = session.Answers.Count(a => a.SelectedAnswerOptionId != null);

        writer.AddTitle($"{Brand.ProductName} Testprotokoll");
        writer.AddLine("Profil", 13, bold: true);
        writer.AddLine($"Name: {EmptyDash(settings.DisplayName)}");
        writer.AddLine($"Matrikelnummer: {EmptyDash(settings.MatriculationNumber)}");
        writer.AddLine($"Semester: {EmptyDash(settings.Semester)}");
        writer.AddLine($"Studiengang: {EmptyDash(settings.StudyProgram)}");
        writer.AddLine($"Hochschule/Universität: {EmptyDash(settings.University)}");
        writer.AddLine($"E-Mail: {EmptyDash(settings.Email)}");
        writer.AddGap();
        writer.AddLine("Test", 13, bold: true);
        writer.AddLine($"Name: {title} (#{session.Id})");
        writer.AddLine($"Dokument: {documentName}");
        writer.AddLine($"Gestartet: {session.StartedAt.ToLocalTime():dd.MM.yyyy HH:mm}");
        if (submitted)
        {
            writer.AddLine($"Abgegeben: {session.SubmittedAt!.Value.ToLocalTime():dd.MM.yyyy HH:mm}");
            writer.AddLine($"Ergebnis: {session.Score}/{session.QuestionCount} ({session.Percent:0.0} %) - {(session.Passed ? "Bestanden" : "Nicht bestanden")}");
        }
        else
        {
            writer.AddLine($"Status: Noch nicht abgegeben, {answered}/{session.QuestionCount} beantwortet");
        }
        writer.AddGap();

        var orderedAnswers = session.Answers.OrderBy(a => a.DisplayOrder).ToList();
        foreach (var answer in orderedAnswers)
        {
            var q = answer.Question;
            if (q == null) continue;

            writer.AddLine($"Frage {answer.DisplayOrder}", 12, bold: true);
            writer.AddWrapped(q.QuestionText, 104);
            writer.AddLine($"Thema: {q.Topic} | Schwierigkeit: {q.Difficulty}", 9);

            var optionIds = JsonSerializer.Deserialize<List<int>>(answer.ShuffledOptionIdsJson) ?? [];
            var optionsById = q.Options.ToDictionary(o => o.Id);
            var displayOptions = optionIds.Where(optionsById.ContainsKey).Select(id => optionsById[id]).ToList();
            if (displayOptions.Count == 0) displayOptions = q.Options.OrderBy(o => o.OptionIndex).ToList();

            foreach (var option in displayOptions)
            {
                var letter = (char)('A' + Math.Clamp(option.OptionIndex, 0, 25));
                var marker = answer.SelectedAnswerOptionId == option.Id ? " [gewählt]" : string.Empty;
                writer.AddWrapped($"{letter}. {option.Text}{marker}", 100, 9, indent: 12);
            }

            if (submitted)
            {
                var selected = q.Options.FirstOrDefault(o => o.Id == answer.SelectedAnswerOptionId)?.Text ?? "Keine Antwort";
                var correct = q.Options.FirstOrDefault(o => o.OptionIndex == q.CorrectOptionIndex)?.Text ?? "Nicht gefunden";
                writer.AddWrapped($"Deine Antwort: {selected}", 100, 9);
                writer.AddWrapped($"Richtig: {correct}", 100, 9);
                writer.AddWrapped($"Erklärung: {q.Explanation}", 100, 9);
            }
            else if (answer.SelectedAnswerOptionId == null)
            {
                writer.AddLine("Auswahl: Noch keine Antwort", 9);
            }

            writer.AddGap(8);
        }

        return writer.Build();
    }

    internal static string EmptyDash(string? value) => string.IsNullOrWhiteSpace(value) ? "-" : value.Trim();

    internal sealed class SimplePdfWriter
    {
        private const double PageWidth = 595.0;
        private const double PageHeight = 842.0;
        private const double Margin = 42.0;
        private const double Bottom = 42.0;
        private readonly List<List<string>> _pages = new();
        private List<string> _commands = new();
        private double _y = PageHeight - Margin;

        public SimplePdfWriter()
        {
            _pages.Add(_commands);
        }

        public void AddTitle(string text) => AddLine(text, 17, bold: true);

        public void AddGap(double amount = 12)
        {
            _y -= amount;
            EnsureSpace(0);
        }

        public void AddLine(string text, int size = 10, bool bold = false, double indent = 0)
        {
            EnsureSpace(size + 5);
            var font = bold ? "F2" : "F1";
            var x = Margin + indent;
            _commands.Add($"BT /{font} {size} Tf 1 0 0 1 {x:0.##} {_y:0.##} Tm {PdfText(text)} Tj ET");
            _y -= size + 4;
        }

        public void AddWrapped(string text, int maxChars, int size = 10, double indent = 0)
        {
            foreach (var line in Wrap(text, maxChars))
                AddLine(line, size, false, indent);
        }

        public byte[] Build()
        {
            var objects = new List<byte[]>();
            objects.Add(Ascii("<< /Type /Catalog /Pages 2 0 R >>"));

            var pageCount = _pages.Count;
            var fontObj = 3 + pageCount * 2;
            var fontBoldObj = fontObj + 1;
            var kids = string.Join(" ", Enumerable.Range(0, pageCount).Select(i => $"{3 + i * 2} 0 R"));
            objects.Add(Ascii($"<< /Type /Pages /Kids [{kids}] /Count {pageCount} >>"));

            for (var i = 0; i < pageCount; i++)
            {
                var pageObj = 3 + i * 2;
                var contentObj = pageObj + 1;
                objects.Add(Ascii($"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {PageWidth:0} {PageHeight:0}] /Resources << /Font << /F1 {fontObj} 0 R /F2 {fontBoldObj} 0 R >> >> /Contents {contentObj} 0 R >>"));
                var streamBytes = Encoding.ASCII.GetBytes(string.Join("\n", _pages[i]));
                objects.Add(Ascii($"<< /Length {streamBytes.Length} >>\nstream\n{Encoding.ASCII.GetString(streamBytes)}\nendstream"));
            }

            objects.Add(Ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"));
            objects.Add(Ascii("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"));

            using var ms = new MemoryStream();
            WriteAscii(ms, "%PDF-1.4\n");
            var offsets = new List<long> { 0 };
            for (var i = 0; i < objects.Count; i++)
            {
                offsets.Add(ms.Position);
                WriteAscii(ms, $"{i + 1} 0 obj\n");
                ms.Write(objects[i]);
                WriteAscii(ms, "\nendobj\n");
            }

            var xref = ms.Position;
            WriteAscii(ms, $"xref\n0 {objects.Count + 1}\n");
            WriteAscii(ms, "0000000000 65535 f \n");
            foreach (var offset in offsets.Skip(1))
                WriteAscii(ms, $"{offset:0000000000} 00000 n \n");
            WriteAscii(ms, $"trailer\n<< /Size {objects.Count + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF");
            return ms.ToArray();
        }

        private void EnsureSpace(double needed)
        {
            if (_y - needed >= Bottom) return;
            _commands = new List<string>();
            _pages.Add(_commands);
            _y = PageHeight - Margin;
        }

        private static IEnumerable<string> Wrap(string? text, int maxChars)
        {
            var words = Regex.Replace(text ?? string.Empty, "\\s+", " ").Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (words.Length == 0) return ["-"];
            var lines = new List<string>();
            var current = "";
            foreach (var word in words)
            {
                if (current.Length == 0)
                {
                    current = word;
                    continue;
                }

                if (current.Length + word.Length + 1 <= maxChars)
                    current += " " + word;
                else
                {
                    lines.Add(current);
                    current = word;
                }
            }
            if (current.Length > 0) lines.Add(current);
            return lines;
        }

        private static string PdfText(string value)
        {
            var bytes = Encoding.Latin1.GetBytes(value);
            return "<" + Convert.ToHexString(bytes) + ">";
        }

        private static byte[] Ascii(string value) => Encoding.ASCII.GetBytes(value);

        private static void WriteAscii(Stream stream, string value)
        {
            var bytes = Encoding.ASCII.GetBytes(value);
            stream.Write(bytes);
        }
    }

    internal sealed record CatalogQuestionPayload(
        string QuestionText,
        List<string> Options,
        int CorrectOptionIndex,
        string Explanation,
        string Topic,
        string Difficulty,
        bool IsAiGenerated = false);

    internal sealed record UpdateManifest(
        string Version,
        string? ReleaseDate,
        string? Notes,
        string? ReleaseUrl,
        List<UpdateDownloadDto> Downloads);
}
