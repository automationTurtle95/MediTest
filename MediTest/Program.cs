using System.Diagnostics;
using System.Net;
using System.Globalization;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediTest.Dtos;
using MediTest.Models;
using MediTest.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.IdentityModel.Tokens;

var installedContentRoot = Directory.Exists(Path.Combine(AppContext.BaseDirectory, "wwwroot"))
    ? AppContext.BaseDirectory
    : Directory.GetCurrentDirectory();
Directory.SetCurrentDirectory(installedContentRoot);

var builder = WebApplication.CreateBuilder(new WebApplicationOptions
{
    Args = args,
    ContentRootPath = installedContentRoot
});

if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("ASPNETCORE_URLS")) &&
    string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("DOTNET_URLS")))
{
    builder.WebHost.UseUrls("http://127.0.0.1:55000");
}

var maxUploadMb = builder.Configuration.GetValue<int?>("Upload:MaxFileSizeMb") ?? 100;
var maxUploadBytes = maxUploadMb * 1024L * 1024L;

builder.WebHost.ConfigureKestrel(options =>
{
    options.Limits.MaxRequestBodySize = maxUploadBytes;
});

builder.Services.Configure<FormOptions>(options =>
{
    options.MultipartBodyLengthLimit = maxUploadBytes;
});

builder.Services.AddScoped<ITextExtractionService, TextExtractionService>();
builder.Services.AddScoped<FirestoreUserDataStore>();
builder.Services.AddHttpContextAccessor();
builder.Services.AddHttpClient();
builder.Services.AddHttpClient<IQuestionGenerationService, OpenAiQuestionService>(client =>
{
    client.Timeout = TimeSpan.FromMinutes(5);
});
var firebaseProjectId = FirebaseProjectId(builder.Configuration);
var firebaseAuthConfigured = !string.IsNullOrWhiteSpace(firebaseProjectId);
if (firebaseAuthConfigured)
{
    builder.Services
        .AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
        .AddJwtBearer(options =>
        {
            options.Authority = $"https://securetoken.google.com/{firebaseProjectId}";
            options.TokenValidationParameters = new TokenValidationParameters
            {
                ValidateIssuer = true,
                ValidIssuer = $"https://securetoken.google.com/{firebaseProjectId}",
                ValidateAudience = true,
                ValidAudience = firebaseProjectId,
                ValidateLifetime = true
            };
        });
}
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddCors(options => options.AddDefaultPolicy(p => p.AllowAnyHeader().AllowAnyMethod().AllowAnyOrigin()));

var app = builder.Build();
app.UseCors();
app.Use(async (context, next) =>
{
    try
    {
        await next();
    }
    catch (Exception ex)
    {
        var logger = context.RequestServices.GetRequiredService<ILoggerFactory>().CreateLogger("GlobalExceptionHandler");
        logger.LogError(ex, "Unhandled request error");
        context.Response.StatusCode = StatusCodes.Status500InternalServerError;
        context.Response.ContentType = "application/json; charset=utf-8";
        await context.Response.WriteAsJsonAsync(new { error = ex.Message });
    }
});
if (firebaseAuthConfigured)
{
    app.UseAuthentication();
}
app.Use(async (context, next) =>
{
    if (IsPublicRequest(context))
    {
        await next();
        return;
    }

    if (IsApiRequest(context))
    {
        if (context.User.Identity?.IsAuthenticated == true)
        {
            context.Items["CurrentUser"] = ToFirebaseUserDto(context.User, app.Configuration);
            await next();
            return;
        }

        context.Response.StatusCode = StatusCodes.Status401Unauthorized;
        context.Response.ContentType = "application/json; charset=utf-8";
        await context.Response.WriteAsJsonAsync(new { error = "Bitte melde dich zuerst an." });
        return;
    }

    await next();
});
app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx =>
    {
        var path = ctx.File.PhysicalPath ?? ctx.Context.Request.Path.Value ?? string.Empty;
        ctx.Context.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate, max-age=0";
        ctx.Context.Response.Headers.Pragma = "no-cache";
        ctx.Context.Response.Headers.Expires = "0";

        if (path.EndsWith(".html", StringComparison.OrdinalIgnoreCase))
            ctx.Context.Response.ContentType = "text/html; charset=utf-8";
        else if (path.EndsWith(".js", StringComparison.OrdinalIgnoreCase))
            ctx.Context.Response.ContentType = "application/javascript; charset=utf-8";
        else if (path.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
            ctx.Context.Response.ContentType = "text/css; charset=utf-8";
    }
});

app.Lifetime.ApplicationStarted.Register(() =>
{
    if (Environment.GetEnvironmentVariable("MEDITEST_NO_BROWSER") == "1") return;

    var url = app.Urls.FirstOrDefault(u => u.StartsWith("http://127.0.0.1", StringComparison.OrdinalIgnoreCase))
        ?? app.Urls.FirstOrDefault()
        ?? "http://127.0.0.1:55000";
    OpenBrowser(url.TrimEnd('/') + "/pages/documents.html?v=4060");
});

static void OpenBrowser(string url)
{
    try
    {
        Process.Start(new ProcessStartInfo { FileName = url, UseShellExecute = true });
    }
    catch { }
}

static bool AllowedFile(IFormFile file)
{
    var ext = Path.GetExtension(file.FileName).ToLowerInvariant();
    return ext is ".pdf" or ".pptx" or ".txt";
}

static bool IsPublicRequest(HttpContext context)
{
    var path = context.Request.Path;
    if (path.Equals("/api/auth/config")) return true;
    if (path.StartsWithSegments("/api/system/shutdown")) return true;
    if (path.StartsWithSegments("/api/system/update")) return true;
    if (path.StartsWithSegments("/css")) return true;
    if (path.StartsWithSegments("/js")) return true;
    if (path.StartsWithSegments("/assets")) return true;
    if (path.Equals("/favicon.ico")) return true;
    if (path.Equals("/pages/login.html")) return true;
    return false;
}

static bool IsApiRequest(HttpContext context)
{
    return context.Request.Path.StartsWithSegments("/api");
}

static string FirebaseProjectId(IConfiguration cfg)
{
    return (cfg["Auth:Firebase:ProjectId"] ?? string.Empty).Trim();
}

static AuthConfigDto ToAuthConfigDto(IConfiguration cfg)
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

static FirebaseConfigDto? ToFirebaseConfigDto(IConfiguration cfg)
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
        (cfg["Auth:Firebase:MeasurementId"] ?? string.Empty).Trim());
}

static AuthUserDto ToFirebaseUserDto(ClaimsPrincipal principal, IConfiguration cfg)
{
    var userId = FirstClaim(principal, "user_id", ClaimTypes.NameIdentifier, "sub");
    var email = FirstClaim(principal, "email", ClaimTypes.Email);
    var displayName = FirstClaim(principal, "name", "displayName");
    if (string.IsNullOrWhiteSpace(displayName)) displayName = email.Split('@', 2)[0];
    if (string.IsNullOrWhiteSpace(displayName)) displayName = "MediTest Nutzer";

    var expiresAt = DateTime.UtcNow.AddHours(1);
    var exp = FirstClaim(principal, "exp");
    if (long.TryParse(exp, out var expSeconds))
        expiresAt = DateTimeOffset.FromUnixTimeSeconds(expSeconds).UtcDateTime;

    var subscriptionActive = IsTruthy(FirstClaim(principal, "subscriptionActive", "subscribed", "paid"));
    var admin = IsTruthy(FirstClaim(principal, "admin", "isAdmin"));
    var plan = subscriptionActive || admin ? "Pro" : "Testphase";
    var licenseStatus = subscriptionActive || admin ? "Aktiv" : "Testphase";

    return new AuthUserDto(
        string.IsNullOrWhiteSpace(userId) ? email : userId,
        email,
        displayName,
        plan,
        licenseStatus,
        (cfg["Auth:Mode"] ?? "firebase").Trim().ToLowerInvariant(),
        expiresAt);
}

static string FirstClaim(ClaimsPrincipal principal, params string[] names)
{
    foreach (var name in names)
    {
        var value = principal.FindFirst(name)?.Value;
        if (!string.IsNullOrWhiteSpace(value)) return value.Trim();
    }

    return string.Empty;
}

static string AppVersion()
{
    var assembly = Assembly.GetExecutingAssembly();
    var informational = assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion;
    if (!string.IsNullOrWhiteSpace(informational)) return informational.Split('+', 2)[0].Trim();
    return assembly.GetName().Version?.ToString(3) ?? "0.0.0";
}

static string CurrentUpdatePlatform()
{
    var arch = RuntimeInformation.ProcessArchitecture;
    if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows) && arch == Architecture.X64) return "windows-x64";
    if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX) && arch == Architecture.Arm64) return "macos-arm64";
    if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX) && arch == Architecture.X64) return "macos-x64";
    if (RuntimeInformation.IsOSPlatform(OSPlatform.Windows)) return $"windows-{arch.ToString().ToLowerInvariant()}";
    if (RuntimeInformation.IsOSPlatform(OSPlatform.OSX)) return $"macos-{arch.ToString().ToLowerInvariant()}";
    return $"{RuntimeInformation.OSDescription}-{arch}".ToLowerInvariant().Replace(' ', '-');
}

static string UpdateManifestUrl(IConfiguration cfg)
{
    if (!(cfg.GetValue<bool?>("Updates:Enabled") ?? false)) return string.Empty;

    var manifestUrl = (cfg["Updates:ManifestUrl"] ?? string.Empty).Trim();
    if (!string.IsNullOrWhiteSpace(manifestUrl)) return manifestUrl;

    var repo = (cfg["Updates:GitHubRepository"] ?? string.Empty).Trim().Trim('/');
    if (string.IsNullOrWhiteSpace(repo)) return string.Empty;
    return $"https://api.github.com/repos/{repo}/releases/latest";
}

static async Task<UpdateCheckDto> CheckForUpdateAsync(IConfiguration cfg, IHttpClientFactory httpClientFactory, CancellationToken ct)
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
        request.Headers.TryAddWithoutValidation("User-Agent", $"MediTest/{currentVersion}");

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
            : $"MediTest ist aktuell ({currentVersion}).";

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

static UpdateManifest ParseUpdateManifest(JsonElement root)
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

static UpdateDownloadDto ParseDownload(string platform, JsonElement element)
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

static string PlatformFromFileName(string fileName)
{
    fileName = (fileName ?? string.Empty).ToLowerInvariant();
    if (fileName.EndsWith(".msi") && fileName.Contains("win-x64")) return "windows-x64";
    if (fileName.Contains("macos-arm64")) return "macos-arm64";
    if (fileName.Contains("macos-x64")) return "macos-x64";
    return string.Empty;
}

static string FileNameFromUrl(string url)
{
    if (Uri.TryCreate(url, UriKind.Absolute, out var uri))
        return Uri.UnescapeDataString(Path.GetFileName(uri.LocalPath));
    return Path.GetFileName(url.Split('?', 2)[0]);
}

static string JsonText(JsonElement element, string propertyName)
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

static long JsonLong(JsonElement element, string propertyName)
{
    if (!element.TryGetProperty(propertyName, out var value)) return 0;
    if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var parsed)) return parsed;
    if (value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return parsed;
    return 0;
}

static int CompareVersions(string left, string right)
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

static List<int> VersionParts(string value)
{
    value = (value ?? string.Empty).Trim().TrimStart('v', 'V').Split('+', 2)[0].Split('-', 2)[0];
    return value.Split('.', StringSplitOptions.RemoveEmptyEntries)
        .Select(part => int.TryParse(part, NumberStyles.Integer, CultureInfo.InvariantCulture, out var number) ? number : 0)
        .ToList();
}

app.MapPost("/api/system/shutdown", (HttpContext context, IHostApplicationLifetime lifetime) =>
{
    var remoteIp = context.Connection.RemoteIpAddress;
    if (remoteIp is not null && !IPAddress.IsLoopback(remoteIp))
        return Results.Forbid();

    _ = Task.Run(async () =>
    {
        await Task.Delay(300);
        lifetime.StopApplication();
    });

    return Results.Ok(new { shuttingDown = true });
});

app.MapGet("/api/system/update", async (IConfiguration cfg, IHttpClientFactory httpClientFactory, CancellationToken ct) =>
{
    return Results.Ok(await CheckForUpdateAsync(cfg, httpClientFactory, ct));
});

app.MapGet("/api/auth/config", (IConfiguration cfg) =>
{
    return Results.Ok(ToAuthConfigDto(cfg));
});

app.MapPost("/api/auth/register", () =>
{
    return Results.BadRequest(new { error = "Registrierung läuft über Firebase Authentication im Browser." });
});

app.MapPost("/api/auth/login", () =>
{
    return Results.BadRequest(new { error = "Anmeldung läuft über Firebase Authentication im Browser." });
});

app.MapGet("/api/auth/me", async (HttpContext context, IConfiguration cfg, FirestoreUserDataStore store, CancellationToken ct) =>
{
    if (context.User.Identity?.IsAuthenticated != true) return Results.Unauthorized();

    var state = await store.GetLicenseStateAsync(BillingTrialDays(cfg), ct);
    var user = ToFirebaseUserDto(context.User, cfg);
    if (state.PremiumActive)
        user = user with { Plan = "Premium", LicenseStatus = "Aktiv" };
    else if (state.SubscriptionActive)
        user = user with { Plan = "Pro", LicenseStatus = "Aktiv" };
    return Results.Ok(new AuthResponse(user));
});

app.MapPost("/api/auth/logout", () =>
{
    return Results.Ok(new { loggedOut = true });
});

app.MapGet("/api/settings", async (FirestoreUserDataStore store, CancellationToken ct) =>
{
    var settings = await store.GetSettingsAsync(ct);
    return Results.Ok(ToProgramSettingsDto(settings));
});

app.MapPut("/api/settings", async (UpdateProgramSettingsRequest req, FirestoreUserDataStore store, CancellationToken ct) =>
{
    var settings = await store.GetSettingsAsync(ct);
    settings.DisplayName = TrimTo(req.DisplayName, 200);
    settings.MatriculationNumber = TrimTo(req.MatriculationNumber, 80);
    settings.StudyProgram = TrimTo(req.StudyProgram, 200);
    settings.University = TrimTo(req.University, 200);
    settings.Semester = TrimTo(req.Semester, 80);
    settings.Email = TrimTo(req.Email, 240);
    settings.Theme = NormalizeTheme(req.Theme);
    settings.DefaultGenerateQuestionCount = NormalizeQuestionCount(req.DefaultGenerateQuestionCount, 25);
    settings.DefaultTestQuestionCount = NormalizeQuestionCount(req.DefaultTestQuestionCount, 25);
    ApplyFixedAiSettings(settings);
    settings.UpdatedAt = DateTime.UtcNow;

    await store.SaveSettingsAsync(settings, ct);
    return Results.Ok(ToProgramSettingsDto(settings));
});

app.MapGet("/api/license/status", async (HttpContext context, IConfiguration cfg, FirestoreUserDataStore store, CancellationToken ct) =>
{
    var state = await store.GetLicenseStateAsync(BillingTrialDays(cfg), ct);
    return Results.Ok(ToLicenseStatusDto(state, context, cfg));
});

app.MapPost("/api/license/redeem-premium-code", async (RedeemPremiumCodeRequest req, HttpContext context, IConfiguration cfg, FirestoreUserDataStore store, CancellationToken ct) =>
{
    var normalizedCode = NormalizePremiumCode(req.Code);
    if (string.IsNullOrWhiteSpace(normalizedCode))
        return Results.BadRequest(new { error = "Bitte gib einen Premium-Code ein." });

    if (!BillingPremiumCodesConfigured(cfg))
    {
        return Results.Json(new { error = "Premium-Codes sind noch nicht konfiguriert." }, statusCode: StatusCodes.Status501NotImplemented);
    }

    if (!BillingPremiumCodeMatches(cfg, normalizedCode))
    {
        return Results.BadRequest(new { error = "Dieser Premium-Code ist ungültig." });
    }

    var state = await store.GetLicenseStateAsync(BillingTrialDays(cfg), ct);
    var now = DateTime.UtcNow;
    state.PremiumActive = true;
    state.PremiumGrantedAt ??= now;
    state.PremiumProvider = "premium-code";
    state.PremiumCodeHash = PremiumCodeHash(normalizedCode);
    await store.SaveLicenseStateAsync(state, ct);

    return Results.Ok(ToLicenseStatusDto(state, context, cfg));
});

app.MapPost("/api/license/redeem-catalog-code", async (RedeemCatalogCodeRequest req, HttpContext context, IConfiguration cfg, FirestoreUserDataStore store, CancellationToken ct) =>
{
    var normalizedCode = NormalizePremiumCode(req.Code);
    if (string.IsNullOrWhiteSpace(normalizedCode))
        return Results.BadRequest(new { error = "Bitte gib einen Gratis-Katalog-Code ein." });

    if (!BillingFreeCatalogCodesConfigured(cfg))
    {
        return Results.Json(new { error = "Gratis-Katalog-Codes sind noch nicht konfiguriert." }, statusCode: StatusCodes.Status501NotImplemented);
    }

    if (!BillingFreeCatalogCodeMatches(cfg, normalizedCode))
    {
        return Results.BadRequest(new { error = "Dieser Gratis-Katalog-Code ist ungültig." });
    }

    var state = await store.GetLicenseStateAsync(BillingTrialDays(cfg), ct);
    if (!string.IsNullOrWhiteSpace(state.FreeCatalogCreditRedeemedCatalogId))
    {
        return Results.BadRequest(new { error = "Der Gratis-Katalog-Code wurde für dieses Konto bereits verwendet." });
    }

    var now = DateTime.UtcNow;
    state.FreeCatalogCreditActive = true;
    state.FreeCatalogCreditGrantedAt ??= now;
    state.FreeCatalogCreditCodeHash = PremiumCodeHash(normalizedCode);
    await store.SaveLicenseStateAsync(state, ct);

    return Results.Ok(ToLicenseStatusDto(state, context, cfg));
});

app.MapPost("/api/license/checkout/subscription", async (IConfiguration cfg) =>
{
    var url = (cfg["Billing:SubscriptionCheckoutUrl"] ?? string.Empty).Trim();
    if (string.IsNullOrWhiteSpace(url))
    {
        return Results.Json(new CheckoutLinkDto(false, null, "Checkout ist noch nicht konfiguriert. Lege in Stripe ein Abo-Produkt für 5,99 EUR/Monat mit 7 Tagen Testphase an und trage die Checkout-URL serverseitig ein."), statusCode: StatusCodes.Status501NotImplemented);
    }

    return Results.Ok(new CheckoutLinkDto(true, url, "Weiterleitung zum Abo-Checkout."));
});

app.MapPost("/api/documents/upload", async (HttpRequest request, FirestoreUserDataStore store, ITextExtractionService extractor, IConfiguration cfg, CancellationToken ct) =>
{
    if (!request.HasFormContentType) return Results.BadRequest(new { error = "Multipart/Form-Data erwartet." });
    var form = await request.ReadFormAsync(ct);
    var file = form.Files.GetFile("file");
    if (file == null || file.Length == 0) return Results.BadRequest(new { error = "Keine Datei hochgeladen." });
    if (!AllowedFile(file)) return Results.BadRequest(new { error = "Nur PDF, PPTX und TXT sind erlaubt." });

    var maxMb = cfg.GetValue<int?>("Upload:MaxFileSizeMb") ?? 100;
    if (file.Length > maxMb * 1024L * 1024L) return Results.BadRequest(new { error = $"Datei ist zu groß. Maximum: {maxMb} MB." });

    var text = await extractor.ExtractTextAsync(file, ct);
    if (string.IsNullOrWhiteSpace(text)) return Results.BadRequest(new { error = "Aus der Datei konnte kein Text extrahiert werden." });

    var doc = new UploadedDocument
    {
        FileName = Path.GetFileName(file.FileName),
        ContentType = file.ContentType ?? string.Empty,
        ExtractedText = text,
        CreatedAt = DateTime.UtcNow
    };
    await store.SaveDocumentAsync(doc, ct);
    return Results.Ok(new { doc.Id, doc.FileName, textLength = doc.ExtractedText.Length });
});

app.MapGet("/api/documents", async (FirestoreUserDataStore store, CancellationToken ct) =>
{
    return Results.Ok(await store.ListDocumentsAsync(ct));
});

app.MapGet("/api/catalog/tests", async (HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, FirestoreUserDataStore store, CancellationToken ct) =>
{
    var client = httpClientFactory.CreateClient();
    var tests = new List<CatalogTestDto>();
    var seenIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    IResult? firstError = null;
    var trialDays = BillingTrialDays(cfg);
    var currency = BillingCurrency(cfg);
    var enforcePurchases = BillingEnforcesCatalogPurchases(cfg);
    var canPublish = UserCanPublishCatalog(context, cfg);
    var licenseState = await store.GetLicenseStateAsync(trialDays, ct);
    var freeCatalogCreditAvailable = FreeCatalogCreditAvailable(licenseState);

    foreach (var collection in CatalogCollections())
    {
        var (json, error) = await SendFirestoreAsync(client, cfg, context, HttpMethod.Get, $"documents/{collection}?pageSize=100", null, "Firestore-Katalog konnte nicht geladen werden.", ct);
        if (error != null)
        {
            firstError ??= error;
            continue;
        }

        using var payload = json!;
        if (!payload.RootElement.TryGetProperty("documents", out var documents) || documents.ValueKind != JsonValueKind.Array) continue;
        foreach (var document in documents.EnumerateArray())
        {
            if (!document.TryGetProperty("fields", out var fields)) continue;
            var id = FirestoreDocumentId(document);
            var title = FirestoreString(fields, "title");
            if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(title)) continue;
            if (!seenIds.Add(id)) continue;
            var questionCount = FirestoreInt(fields, "questionCount");
            if (questionCount <= 0) questionCount = DeserializeCatalogQuestions(FirestoreString(fields, "questionsJson")).Count;
            var priceCents = BillingCatalogTestPriceCents(cfg, questionCount);
            var purchased = licenseState.PremiumActive || licenseState.PurchasedCatalogTestIds.Contains(id, StringComparer.OrdinalIgnoreCase);

            tests.Add(new CatalogTestDto(
                id,
                title,
                FirestoreString(fields, "description"),
                FirestoreString(fields, "topic"),
                FirestoreString(fields, "difficulty"),
                questionCount,
                FirestoreString(fields, "appVersion"),
                FirestoreTimestamp(fields, "publishedAt"),
                priceCents,
                currency,
                purchased,
                enforcePurchases && !canPublish && !purchased));
        }
    }

    if (tests.Count == 0 && firstError != null) return firstError;

    tests = tests
        .OrderByDescending(t => t.PublishedAt ?? DateTime.MinValue)
        .ThenBy(t => t.Title)
        .ToList();

    return Results.Ok(new CatalogListDto(
        canPublish,
        freeCatalogCreditAvailable,
        !string.IsNullOrWhiteSpace(licenseState.FreeCatalogCreditRedeemedCatalogId),
        licenseState.FreeCatalogCreditRedeemedCatalogId,
        tests));
});

app.MapPost("/api/catalog/tests/{catalogId}/download", async (string catalogId, CatalogDownloadRequest req, HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, FirestoreUserDataStore store, CancellationToken ct) =>
{
    catalogId = (catalogId ?? string.Empty).Trim();
    if (string.IsNullOrWhiteSpace(catalogId)) return Results.BadRequest(new { error = "Katalog-ID fehlt." });

    var client = httpClientFactory.CreateClient();
    JsonDocument? loadedPayload = null;
    IResult? firstError = null;
    foreach (var collection in CatalogCollections())
    {
        var path = $"documents/{collection}/{Uri.EscapeDataString(catalogId)}";
        var (json, error) = await SendFirestoreAsync(client, cfg, context, HttpMethod.Get, path, null, "Firestore-Test konnte nicht heruntergeladen werden.", ct);
        if (error != null)
        {
            firstError ??= error;
            continue;
        }

        loadedPayload = json;
        break;
    }

    if (loadedPayload == null) return firstError ?? Results.NotFound(new { error = "Firestore-Test nicht gefunden." });
    using var payload = loadedPayload;

    if (!payload.RootElement.TryGetProperty("fields", out var fields))
        return Results.BadRequest(new { error = "Firestore-Test enthält keine gültigen Felder." });

    var title = FirestoreString(fields, "title");
    var questionsJson = FirestoreString(fields, "questionsJson");
    var questions = DeserializeCatalogQuestions(questionsJson);
    if (questions.Count == 0) return Results.BadRequest(new { error = "Firestore-Test enthält keine gültigen Fragen." });

    var canPublish = UserCanPublishCatalog(context, cfg);
    var licenseState = await store.GetLicenseStateAsync(BillingTrialDays(cfg), ct);
    var purchased = licenseState.PremiumActive || licenseState.PurchasedCatalogTestIds.Contains(catalogId, StringComparer.OrdinalIgnoreCase);
    var consumeFreeCatalogCredit = false;
    if (BillingEnforcesCatalogPurchases(cfg) && !canPublish && !purchased)
    {
        if (FreeCatalogCreditAvailable(licenseState))
        {
            consumeFreeCatalogCredit = true;
        }
        else
        {
            return Results.Json(
                new
                {
                    error = "Dieser Katalogtest muss zuerst gekauft werden.",
                    checkoutRequired = true,
                    priceCents = BillingCatalogTestPriceCents(cfg, questions.Count),
                    currency = BillingCurrency(cfg)
                },
                statusCode: StatusCodes.Status402PaymentRequired);
        }
    }

    var documentName = TrimTo(req.DocumentName, 200);
    if (string.IsNullOrWhiteSpace(documentName)) documentName = title;
    if (string.IsNullOrWhiteSpace(documentName)) documentName = "Firestore-Test";

    var doc = new UploadedDocument
    {
        FileName = documentName,
        ContentType = "firestore/catalog-test",
        ExtractedText = $"Aus Firestore heruntergeladener Test: {documentName}",
        CreatedAt = DateTime.UtcNow
    };
    await store.SaveDocumentAsync(doc, ct);

    foreach (var item in questions)
    {
        await store.SaveQuestionAsync(doc.Id, new Question
        {
            UploadedDocumentId = doc.Id,
            QuestionText = item.QuestionText.Trim(),
            CorrectOptionIndex = Math.Clamp(item.CorrectOptionIndex, 0, item.Options.Count - 1),
            Explanation = string.IsNullOrWhiteSpace(item.Explanation) ? "Aus Firestore importierte Frage." : item.Explanation.Trim(),
            Topic = TopicLabel(item.Topic),
            Difficulty = DifficultyLabel(item.Difficulty),
            IsAiGenerated = false,
            CreatedAt = DateTime.UtcNow,
            Options = item.Options.Select((text, index) => new AnswerOption { Text = text.Trim(), OptionIndex = index }).ToList()
        }, ct);
    }

    if (consumeFreeCatalogCredit)
    {
        licenseState.FreeCatalogCreditActive = false;
        licenseState.FreeCatalogCreditRedeemedCatalogId = catalogId;
        licenseState.FreeCatalogCreditRedeemedAt = DateTime.UtcNow;
        licenseState.PurchasedCatalogTestIds.Add(catalogId);
        await store.SaveLicenseStateAsync(licenseState, ct);
    }

    return Results.Ok(new CatalogDownloadResult(doc.Id, doc.FileName, questions.Count));
});

app.MapPost("/api/catalog/tests/{catalogId}/checkout", (string catalogId, IConfiguration cfg) =>
{
    catalogId = (catalogId ?? string.Empty).Trim();
    if (string.IsNullOrWhiteSpace(catalogId)) return Results.BadRequest(new { error = "Katalog-ID fehlt." });

    var url = (cfg["Billing:CatalogCheckoutUrl"] ?? string.Empty).Trim();
    if (string.IsNullOrWhiteSpace(url))
    {
        return Results.Json(new CheckoutLinkDto(false, null, "Checkout ist noch nicht konfiguriert. Lege serverseitig den Zahlungsanbieter und die Webhook-Zuordnung für Katalogkäufe an."), statusCode: StatusCodes.Status501NotImplemented);
    }

    url = url.Replace("{catalogId}", Uri.EscapeDataString(catalogId), StringComparison.OrdinalIgnoreCase);
    return Results.Ok(new CheckoutLinkDto(true, url, "Weiterleitung zum Katalogtest-Checkout."));
});

app.MapPost("/api/catalog/tests/publish", async (CatalogPublishRequest req, HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, FirestoreUserDataStore store, CancellationToken ct) =>
{
    if (!UserCanPublishCatalog(context, cfg))
    {
        return Results.Json(new { error = "Nur Admin-Konten dürfen neue Firestore-Tests veröffentlichen." }, statusCode: StatusCodes.Status403Forbidden);
    }

    var doc = await store.GetDocumentAsync(req.DocumentId, ct, includeQuestions: true, includeText: false);
    if (doc == null) return Results.NotFound(new { error = "Lokaler Fragenpool nicht gefunden." });

    var questions = BuildCatalogQuestions(doc);
    if (questions.Count == 0) return Results.BadRequest(new { error = "Dieser Fragenpool enthält keine veröffentlichbaren Fragen." });

    var title = TrimTo(req.Title, 200);
    if (string.IsNullOrWhiteSpace(title)) title = doc.FileName;
    var description = TrimTo(req.Description, 600);
    var topic = TopicLabel(req.Topic);
    var difficulty = DifficultyLabel(req.Difficulty);
    var now = DateTime.UtcNow;
    var documentId = $"{Slugify(title)}-{now:yyyyMMddHHmmss}";
    var user = ToFirebaseUserDto(context.User, cfg);
    var questionsJson = JsonSerializer.Serialize(questions, new JsonSerializerOptions(JsonSerializerDefaults.Web));
    if (Encoding.UTF8.GetByteCount(questionsJson) > 900_000)
    {
        return Results.BadRequest(new { error = "Dieser Fragenpool ist für einen einzelnen Firestore-Katalogeintrag zu groß. Bitte teile ihn in kleinere Tests auf." });
    }

    var body = new
    {
        fields = new Dictionary<string, object>
        {
            ["title"] = FirestoreValue(title),
            ["description"] = FirestoreValue(description),
            ["topic"] = FirestoreValue(topic),
            ["difficulty"] = FirestoreValue(difficulty),
            ["questionCount"] = FirestoreIntValue(questions.Count),
            ["schemaVersion"] = FirestoreIntValue(1),
            ["appVersion"] = FirestoreValue("4.0.6"),
            ["questionsJson"] = FirestoreValue(questionsJson),
            ["createdByUid"] = FirestoreValue(user.UserId),
            ["createdByEmail"] = FirestoreValue(user.Email),
            ["publishedAt"] = FirestoreTimestampValue(now),
            ["updatedAt"] = FirestoreTimestampValue(now)
        }
    };

    var client = httpClientFactory.CreateClient();
    var path = $"documents/catalogTests/{Uri.EscapeDataString(documentId)}";
    var (_, error) = await SendFirestoreAsync(client, cfg, context, HttpMethod.Patch, path, body, "Firestore-Test konnte nicht veröffentlicht werden.", ct);
    if (error != null) return error;

    return Results.Ok(new CatalogPublishResult(documentId, title, questions.Count));
});

app.MapGet("/api/documents/{id:int}/questions", async (int id, FirestoreUserDataStore store, CancellationToken ct) =>
{
    var doc = await store.GetDocumentAsync(id, ct, includeQuestions: true, includeText: false);
    if (doc == null) return Results.NotFound(new { error = "Dokument nicht gefunden." });

    var questions = doc.Questions
        .OrderBy(q => q.Id)
        .Select(q => new QuestionListItemDto(
            q.Id,
            q.QuestionText,
            q.Topic,
            q.Difficulty,
            q.IsAiGenerated,
            q.Explanation,
            q.CorrectOptionIndex,
            q.Options
                .OrderBy(o => o.OptionIndex)
                .Select(o => new QuestionOptionListItemDto(o.Id, o.OptionIndex, o.Text, o.OptionIndex == q.CorrectOptionIndex))
                .ToList(),
            EmptyToNull(q.ImageDataUrl),
            EmptyToNull(q.ImageAltText),
            EmptyToNull(q.ImageFileName)))
        .ToList();

    return Results.Ok(new { documentId = doc.Id, documentName = doc.FileName, questionCount = questions.Count, questions });
});

app.MapGet("/api/questions/by-topic", async (string topic, FirestoreUserDataStore store, CancellationToken ct) =>
{
    topic = TopicLabel(topic);
    var rows = await store.GetQuestionsByTopicAsync(topic, ct);

    var questions = rows
        .Select(q => new TopicQuestionItemDto(
            q.Id,
            q.UploadedDocumentId,
            q.Document != null ? q.Document.FileName : "(unbekannt)",
            q.QuestionText,
            q.Topic,
            q.Difficulty,
            q.IsAiGenerated,
            q.Explanation,
            q.CorrectOptionIndex,
            q.Options
                .OrderBy(o => o.OptionIndex)
                .Select(o => new QuestionOptionListItemDto(o.Id, o.OptionIndex, o.Text, o.OptionIndex == q.CorrectOptionIndex))
                .ToList(),
            EmptyToNull(q.ImageDataUrl),
            EmptyToNull(q.ImageAltText),
            EmptyToNull(q.ImageFileName)))
        .ToList();

    return Results.Ok(new TopicQuestionListDto(topic, questions.Count, questions));
});

app.MapPut("/api/questions/{id:int}", async (int id, UpdateQuestionRequest req, FirestoreUserDataStore store, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(req.QuestionText)) return Results.BadRequest(new { error = "Fragetext fehlt." });
    if (req.Options == null || req.Options.Count != 5 || req.Options.Any(string.IsNullOrWhiteSpace))
        return Results.BadRequest(new { error = "Genau 5 Antwortmöglichkeiten sind erforderlich." });
    if (req.CorrectOptionIndex < 0 || req.CorrectOptionIndex > 4)
        return Results.BadRequest(new { error = "Index der richtigen Antwort muss zwischen 0 und 4 liegen." });
    var imageError = ValidateQuestionImage(req.ImageDataUrl);
    if (imageError != null) return Results.BadRequest(new { error = imageError });

    Question question;
    try
    {
        question = await store.UpdateQuestionAsync(id, req, ct);
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound(new { error = "Frage nicht gefunden." });
    }
    return Results.Ok(new { saved = true, questionId = question.Id });
});

app.MapDelete("/api/documents/{id:int}", async (int id, FirestoreUserDataStore store, CancellationToken ct) =>
{
    var doc = await store.GetDocumentAsync(id, ct, includeText: false);
    if (doc == null) return Results.NotFound(new { error = "Dokument nicht gefunden." });

    await store.DeleteDocumentAsync(id, ct);
    return Results.Ok(new { deleted = true, id });
});

app.MapPost("/api/questions/manual", async (CreateManualQuestionRequest req, FirestoreUserDataStore store, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(req.QuestionText)) return Results.BadRequest(new { error = "Fragetext fehlt." });
    if (req.Options == null || req.Options.Count != 5 || req.Options.Any(string.IsNullOrWhiteSpace))
        return Results.BadRequest(new { error = "Genau 5 Antwortmöglichkeiten sind erforderlich." });
    if (req.CorrectOptionIndex < 0 || req.CorrectOptionIndex > 4)
        return Results.BadRequest(new { error = "Index der richtigen Antwort muss zwischen 0 und 4 liegen." });
    var imageError = ValidateQuestionImage(req.ImageDataUrl);
    if (imageError != null) return Results.BadRequest(new { error = imageError });

    UploadedDocument? doc = null;
    if (req.DocumentId.HasValue)
        doc = await store.GetDocumentAsync(req.DocumentId.Value, ct, includeText: false);

    if (doc == null)
    {
        var name = string.IsNullOrWhiteSpace(req.DocumentName) ? "Manueller Fragenpool" : req.DocumentName.Trim();
        doc = new UploadedDocument
        {
            FileName = name,
            ContentType = "manual/question-pool",
            ExtractedText = "Manuell angelegter Fragenpool.",
            CreatedAt = DateTime.UtcNow
        };
        await store.SaveDocumentAsync(doc, ct);
    }

    var difficulty = (req.Difficulty ?? "mittel").Trim().ToLowerInvariant();
    if (difficulty is not ("leicht" or "mittel" or "schwer")) difficulty = "mittel";

    var question = new Question
    {
        UploadedDocumentId = doc.Id,
        QuestionText = req.QuestionText.Trim(),
        CorrectOptionIndex = req.CorrectOptionIndex,
        Explanation = string.IsNullOrWhiteSpace(req.Explanation) ? "Manuell angelegte Frage." : req.Explanation.Trim(),
        Topic = string.IsNullOrWhiteSpace(req.Topic) ? "Manuell" : req.Topic.Trim(),
        Difficulty = difficulty,
        ImageDataUrl = (req.ImageDataUrl ?? string.Empty).Trim(),
        ImageAltText = TrimTo(req.ImageAltText, 240),
        ImageFileName = TrimTo(req.ImageFileName, 200),
        CreatedAt = DateTime.UtcNow,
        Options = req.Options.Select((text, index) => new AnswerOption { Text = text.Trim(), OptionIndex = index }).ToList()
    };

    question = await store.SaveQuestionAsync(doc.Id, question, ct);
    var total = await store.CountQuestionsAsync(doc.Id, ct);
    return Results.Ok(new { questionId = question.Id, documentId = doc.Id, documentName = doc.FileName, totalQuestions = total });
});

app.MapGet("/api/documents/{id:int}/export-txt", async (int id, FirestoreUserDataStore store, CancellationToken ct) =>
{
    var doc = await store.GetDocumentAsync(id, ct, includeQuestions: true, includeText: false);
    if (doc == null) return Results.NotFound(new { error = "Dokument nicht gefunden." });

    var sb = new StringBuilder();
    var questions = doc.Questions.OrderBy(q => q.Id).ToList();
    for (var i = 0; i < questions.Count; i++)
    {
        var q = questions[i];
        var opts = q.Options.OrderBy(o => o.OptionIndex).ToList();
        sb.AppendLine($"{i + 1}. {q.QuestionText}");
        for (var j = 0; j < Math.Min(5, opts.Count); j++)
            sb.AppendLine($"{(char)('a' + j)}. {opts[j].Text}");
        var correctLetter = (char)('a' + Math.Clamp(q.CorrectOptionIndex, 0, 4));
        sb.AppendLine($"Richtig: {correctLetter}");
        sb.AppendLine($"Thema: {q.Topic}");
        sb.AppendLine($"Schwierigkeit: {q.Difficulty}");
        sb.AppendLine($"Erklärung: {q.Explanation}");
        sb.AppendLine();
    }

    var bytes = Encoding.UTF8.GetBytes(sb.ToString());
    var safeName = Regex.Replace(doc.FileName, "[^A-Za-z0-9äöüÄÖÜß _.-]", "_");
    return Results.File(bytes, "text/plain; charset=utf-8", $"{safeName}_Fragenexport.txt");
});

app.MapPost("/api/documents/import-txt", async (HttpRequest request, FirestoreUserDataStore store, CancellationToken ct) =>
{
    if (!request.HasFormContentType) return Results.BadRequest(new { error = "Multipart/Form-Data erwartet." });
    var form = await request.ReadFormAsync(ct);
    var file = form.Files.GetFile("file");
    if (file == null || file.Length == 0) return Results.BadRequest(new { error = "Keine TXT-Datei hochgeladen." });
    if (Path.GetExtension(file.FileName).ToLowerInvariant() != ".txt") return Results.BadRequest(new { error = "Nur .txt ist für den Import erlaubt." });

    var documentName = form["documentName"].ToString();
    if (string.IsNullOrWhiteSpace(documentName)) documentName = Path.GetFileNameWithoutExtension(file.FileName);

    using var reader = new StreamReader(file.OpenReadStream(), Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
    var content = await reader.ReadToEndAsync(ct);
    var parsed = ParseImportedQuestions(content);
    if (parsed.Count == 0) return Results.BadRequest(new { error = "Keine gültigen Fragen im TXT-Format gefunden." });

    var doc = new UploadedDocument
    {
        FileName = documentName,
        ContentType = "text/imported-question-pool",
        ExtractedText = "Importierter Fragenpool aus TXT.",
        CreatedAt = DateTime.UtcNow
    };
    await store.SaveDocumentAsync(doc, ct);

    var importedQuestions = parsed.Select(p => new Question
    {
        UploadedDocumentId = doc.Id,
        QuestionText = p.Question,
        CorrectOptionIndex = p.Correct,
        Explanation = p.Explanation,
        Topic = p.Topic,
        Difficulty = p.Difficulty,
        IsAiGenerated = false,
        CreatedAt = DateTime.UtcNow,
        Options = p.Options.Select((o, i) => new AnswerOption { Text = o, OptionIndex = i }).ToList()
    }).ToList();
    await store.SaveQuestionsAsync(doc.Id, importedQuestions, ct, finalQuestionCount: importedQuestions.Count);

    return Results.Ok(new { documentId = doc.Id, documentName = doc.FileName, importedQuestions = parsed.Count });
});

app.MapPost("/api/documents/{id:int}/generate-questions", async (int id, GenerateQuestionsRequest req, FirestoreUserDataStore store, IQuestionGenerationService generator, CancellationToken ct) =>
{
    var settings = await store.GetSettingsAsync(ct);
    var defaultCount = settings.DefaultGenerateQuestionCount;
    var count = Math.Clamp(req.Count <= 0 ? defaultCount : req.Count, 1, 100);
    var doc = await store.GetDocumentAsync(id, ct, includeText: true);
    if (doc == null) return Results.NotFound(new { error = "Dokument nicht gefunden." });

    List<GeneratedQuestion> generated;
    try
    {
        generated = await generator.GenerateAsync(doc.ExtractedText, count, ct);
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }

    var addedQuestions = new List<Question>();
    foreach (var g in generated)
    {
        var q = new Question
        {
            UploadedDocumentId = id,
            QuestionText = g.QuestionText,
            CorrectOptionIndex = g.CorrectOptionIndex,
            Explanation = g.Explanation,
            Topic = g.Topic,
            Difficulty = g.Difficulty,
            IsAiGenerated = true,
            Options = g.Options.Select((text, index) => new AnswerOption { Text = text, OptionIndex = index }).ToList()
        };
        q = await store.SaveQuestionAsync(id, q, ct);
        addedQuestions.Add(q);
    }
    return Results.Ok(new
    {
        added = generated.Count,
        total = await store.CountQuestionsAsync(id, ct),
        questionIds = addedQuestions.Select(q => q.Id).ToList()
    });
});

app.MapGet("/api/tests", async (FirestoreUserDataStore store, CancellationToken ct) =>
{
    return Results.Ok(await store.ListTestsAsync(ct));
});

app.MapGet("/api/tests/{id:int}/resume", async (int id, FirestoreUserDataStore store, CancellationToken ct) =>
{
    try
    {
        return Results.Ok(await store.ResumeTestAsync(id, ct));
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound(new { error = "Test nicht gefunden." });
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPut("/api/tests/{id:int}/draft", async (int id, SubmitTestRequest req, FirestoreUserDataStore store, CancellationToken ct) =>
{
    try
    {
        var (answered, total) = await store.SaveDraftAsync(id, req, ct);
        return Results.Ok(new { saved = true, answered, total });
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound(new { error = "Test nicht gefunden." });
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPut("/api/tests/{id:int}/name", async (int id, RenameTestRequest req, FirestoreUserDataStore store, CancellationToken ct) =>
{
    try
    {
        await store.RenameTestAsync(id, req.TestName, ct);
        var session = await store.GetTestAsync(id, ct);
        return Results.Ok(new { saved = true, testSessionId = id, testName = session?.TestName ?? TrimTo(req.TestName, 200) });
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound(new { error = "Test nicht gefunden." });
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapGet("/api/tests/{id:int}/pdf", async (int id, FirestoreUserDataStore store, CancellationToken ct) =>
{
    TestSession session;
    try
    {
        session = await store.GetTestWithGraphAsync(id, ct);
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound(new { error = "Test nicht gefunden." });
    }

    var settings = await store.GetSettingsAsync(ct);
    var pdf = BuildTestPdf(session, settings);
    var safeName = Regex.Replace(string.IsNullOrWhiteSpace(session.TestName) ? $"Test-{session.Id}" : session.TestName, "[^A-Za-z0-9äöüÄÖÜß _.-]", "_");
    return Results.File(pdf, "application/pdf", $"{safeName}_MediTest.pdf");
});

app.MapDelete("/api/tests", async (FirestoreUserDataStore store, CancellationToken ct) =>
{
    var (testsDeleted, answersDeleted) = await store.DeleteAllTestsAsync(ct);
    return Results.Ok(new { reset = true, testsDeleted, answersDeleted });
});

app.MapDelete("/api/tests/{id:int}", async (int id, FirestoreUserDataStore store, CancellationToken ct) =>
{
    try
    {
        var answersDeleted = await store.DeleteOpenTestAsync(id, ct);
        return Results.Ok(new { deleted = true, testSessionId = id, answersDeleted });
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound(new { error = "Test nicht gefunden." });
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapGet("/api/stats/overview", async (int? testSessionId, FirestoreUserDataStore store, CancellationToken ct) =>
{
    return Results.Ok(await store.BuildStatsAsync(testSessionId, ct));
});

app.MapPost("/api/tests/start", async (StartTestRequest req, FirestoreUserDataStore store, CancellationToken ct) =>
{
    try
    {
        return Results.Ok(await store.StartTestAsync(req, ct));
    }
    catch (InvalidOperationException ex) when (ex.Message.StartsWith("Zu wenig Fragen", StringComparison.OrdinalIgnoreCase))
    {
        var available = await store.CountQuestionsAsync(req.DocumentId, ct);
        var settings = await store.GetSettingsAsync(ct);
        var required = Math.Clamp(req.QuestionCount <= 0 ? settings.DefaultTestQuestionCount : req.QuestionCount, 1, 100);
        return Results.BadRequest(new { error = "Zu wenig Fragen vorhanden.", available, required, offerGenerate = true });
    }
    catch (Exception ex) when (ex is KeyNotFoundException or InvalidOperationException)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapPost("/api/tests/{id:int}/submit", async (int id, SubmitTestRequest req, FirestoreUserDataStore store, CancellationToken ct) =>
{
    try
    {
        var session = await store.SubmitTestAsync(id, req, ct);
        return Results.Ok(new { session.Id, session.Score, session.QuestionCount, session.Percent, session.Passed });
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound(new { error = "Test nicht gefunden." });
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.MapGet("/api/tests/{id:int}/review", async (int id, FirestoreUserDataStore store, CancellationToken ct) =>
{
    try
    {
        return Results.Ok(await store.ReviewAsync(id, ct));
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound(new { error = "Test nicht gefunden." });
    }
});

app.Run();

static bool ApplyFixedAiSettings(ProgramSettings settings)
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

static ProgramSettingsDto ToProgramSettingsDto(ProgramSettings settings)
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
        settings.UpdatedAt);
}

static LicenseStatusDto ToLicenseStatusDto(UserLicenseState state, HttpContext context, IConfiguration cfg)
{
    var claimSubscription = IsTruthy(FirstClaim(context.User, "subscriptionActive", "subscribed", "paid"));
    var claimPremium = IsTruthy(FirstClaim(context.User, "premiumActive", "premium"));
    var admin = UserCanPublishCatalog(context, cfg);
    var premiumActive = claimPremium || state.PremiumActive;
    var subscriptionActive = admin || premiumActive || claimSubscription || state.SubscriptionActive;
    var now = DateTime.UtcNow;
    var trialActive = now < state.TrialEndsAt;
    var daysRemaining = Math.Max(0, (int)Math.Ceiling((state.TrialEndsAt - now).TotalDays));
    var accessActive = subscriptionActive || trialActive;
    var status = premiumActive ? "premium" : subscriptionActive ? "active" : trialActive ? "trial" : "expired";
    var plan = premiumActive ? "Premium" : subscriptionActive ? "Pro" : "Testphase";
    var checkoutConfigured = !string.IsNullOrWhiteSpace(cfg["Billing:SubscriptionCheckoutUrl"]);
    var message = status switch
    {
        "premium" => "Premium aktiv: MediTest und alle Katalogtests sind freigeschaltet.",
        "active" => "Abo aktiv.",
        "trial" => $"Testphase aktiv: noch {daysRemaining} Tag(e).",
        _ => "Testphase abgelaufen. Für weitere Nutzung ist ein Abo erforderlich."
    };

    return new LicenseStatusDto(
        plan,
        status,
        accessActive,
        premiumActive,
        state.TrialStartedAt,
        state.TrialEndsAt,
        daysRemaining,
        BillingMonthlyPriceCents(cfg),
        BillingCatalogExamplePriceCents(cfg),
        BillingCatalogQuestionPriceCents(cfg),
        BillingCatalogPriceEndingCents(cfg),
        BillingCatalogExampleQuestionCount(cfg),
        BillingCurrency(cfg),
        checkoutConfigured,
        FreeCatalogCreditAvailable(state),
        !string.IsNullOrWhiteSpace(state.FreeCatalogCreditRedeemedCatalogId),
        state.FreeCatalogCreditRedeemedCatalogId,
        state.FreeCatalogCreditGrantedAt,
        state.FreeCatalogCreditRedeemedAt,
        message);
}

static string TrimTo(string? value, int maxLength)
{
    value = (value ?? string.Empty).Trim();
    return value.Length <= maxLength ? value : value[..maxLength];
}

static string NormalizeTheme(string? theme)
{
    theme = (theme ?? "system").Trim().ToLowerInvariant();
    return theme is "light" or "dark" or "system" ? theme : "system";
}

static string TopicLabel(string? topic)
{
    topic = (topic ?? string.Empty).Trim();
    return string.IsNullOrWhiteSpace(topic) ? "Allgemein" : topic;
}

static string DifficultyLabel(string? difficulty)
{
    difficulty = (difficulty ?? "mittel").Trim().ToLowerInvariant();
    return difficulty is "leicht" or "mittel" or "schwer" ? difficulty : "mittel";
}

static int NormalizeQuestionCount(int value, int fallback)
{
    return Math.Clamp(value <= 0 ? fallback : value, 1, 100);
}

static string? ValidateQuestionImage(string? imageDataUrl)
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

static string? EmptyToNull(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;

static int BillingTrialDays(IConfiguration cfg) => Math.Clamp(cfg.GetValue<int?>("Billing:TrialDays") ?? 7, 1, 60);
static int BillingMonthlyPriceCents(IConfiguration cfg) => Math.Max(0, cfg.GetValue<int?>("Billing:MonthlyPriceCents") ?? 599);
static int BillingCatalogQuestionPriceCents(IConfiguration cfg) => Math.Max(0, cfg.GetValue<int?>("Billing:CatalogQuestionPriceCents") ?? 10);
static int BillingCatalogPriceEndingCents(IConfiguration cfg) => Math.Max(0, cfg.GetValue<int?>("Billing:CatalogPriceEndingCents") ?? 9);
static int BillingCatalogExampleQuestionCount(IConfiguration cfg) => Math.Clamp(cfg.GetValue<int?>("Billing:CatalogExampleQuestionCount") ?? 25, 1, 1000);
static int BillingCatalogExamplePriceCents(IConfiguration cfg) => BillingCatalogTestPriceCents(cfg, BillingCatalogExampleQuestionCount(cfg));
static int BillingCatalogTestPriceCents(IConfiguration cfg, int questionCount)
{
    if (questionCount <= 0) return 0;
    var cents = (long)questionCount * BillingCatalogQuestionPriceCents(cfg) + BillingCatalogPriceEndingCents(cfg);
    return cents > int.MaxValue ? int.MaxValue : (int)cents;
}
static string BillingCurrency(IConfiguration cfg) => string.IsNullOrWhiteSpace(cfg["Billing:Currency"]) ? "EUR" : cfg["Billing:Currency"]!.Trim().ToUpperInvariant();
static bool BillingEnforcesCatalogPurchases(IConfiguration cfg) => cfg.GetValue<bool?>("Billing:EnforceCatalogPurchases") ?? true;

static bool BillingPremiumCodesConfigured(IConfiguration cfg)
{
    return BillingConfigStrings(cfg, "Billing:PremiumCodes").Any() || BillingConfigStrings(cfg, "Billing:PremiumCodeHashes").Any();
}

static bool BillingPremiumCodeMatches(IConfiguration cfg, string normalizedCode)
{
    var codeMatches = BillingConfigStrings(cfg, "Billing:PremiumCodes")
        .Select(NormalizePremiumCode)
        .Any(code => string.Equals(code, normalizedCode, StringComparison.OrdinalIgnoreCase));
    if (codeMatches) return true;

    var codeHash = PremiumCodeHash(normalizedCode);
    return BillingConfigStrings(cfg, "Billing:PremiumCodeHashes")
        .Select(hash => hash.Trim())
        .Any(hash => string.Equals(hash, codeHash, StringComparison.OrdinalIgnoreCase));
}

static bool BillingFreeCatalogCodesConfigured(IConfiguration cfg)
{
    return BillingConfigStrings(cfg, "Billing:FreeCatalogCodes").Any() || BillingConfigStrings(cfg, "Billing:FreeCatalogCodeHashes").Any();
}

static bool BillingFreeCatalogCodeMatches(IConfiguration cfg, string normalizedCode)
{
    var codeMatches = BillingConfigStrings(cfg, "Billing:FreeCatalogCodes")
        .Select(NormalizePremiumCode)
        .Any(code => string.Equals(code, normalizedCode, StringComparison.OrdinalIgnoreCase));
    if (codeMatches) return true;

    var codeHash = PremiumCodeHash(normalizedCode);
    return BillingConfigStrings(cfg, "Billing:FreeCatalogCodeHashes")
        .Select(hash => hash.Trim())
        .Any(hash => string.Equals(hash, codeHash, StringComparison.OrdinalIgnoreCase));
}

static bool FreeCatalogCreditAvailable(UserLicenseState state)
{
    return state.FreeCatalogCreditActive && string.IsNullOrWhiteSpace(state.FreeCatalogCreditRedeemedCatalogId);
}

static List<string> BillingConfigStrings(IConfiguration cfg, string key)
{
    var values = cfg.GetSection(key).Get<string[]>() ?? [];
    if (values.Length == 0 && !string.IsNullOrWhiteSpace(cfg[key]))
    {
        values = cfg[key]!
            .Split([',', ';', '\n', '\r'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
    }

    return values
        .Select(v => (v ?? string.Empty).Trim())
        .Where(v => !string.IsNullOrWhiteSpace(v))
        .ToList();
}

static string NormalizePremiumCode(string? code)
{
    return Regex.Replace((code ?? string.Empty).Trim().ToUpperInvariant(), "[^A-Z0-9]", string.Empty);
}

static string PremiumCodeHash(string normalizedCode)
{
    return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalizedCode)));
}

static async Task<(JsonDocument? Json, IResult? Error)> SendFirestoreAsync(
    HttpClient client,
    IConfiguration cfg,
    HttpContext context,
    HttpMethod method,
    string pathAndQuery,
    object? body,
    string fallbackError,
    CancellationToken ct)
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
    if (!response.IsSuccessStatusCode)
        return (null, await FirestoreErrorResultAsync(response, fallbackError, ct));

    using var stream = await response.Content.ReadAsStreamAsync(ct);
    var json = await JsonDocument.ParseAsync(stream, cancellationToken: ct);
    return (json, null);
}

static string FirebaseBearerToken(HttpContext context)
{
    if (!context.Request.Headers.TryGetValue("Authorization", out var values)) return string.Empty;
    var authorization = values.ToString();
    const string prefix = "Bearer ";
    return authorization.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
        ? authorization[prefix.Length..].Trim()
        : string.Empty;
}

static async Task<IResult> FirestoreErrorResultAsync(HttpResponseMessage response, string fallback, CancellationToken ct)
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

static string FirestoreErrorMessage(string raw)
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

static string FirestoreDocumentId(JsonElement document)
{
    if (!document.TryGetProperty("name", out var nameElement)) return string.Empty;
    var name = nameElement.GetString() ?? string.Empty;
    var slash = name.LastIndexOf('/');
    return slash >= 0 ? Uri.UnescapeDataString(name[(slash + 1)..]) : name;
}

static string FirestoreString(JsonElement fields, string fieldName)
{
    if (!fields.TryGetProperty(fieldName, out var field)) return string.Empty;
    if (field.TryGetProperty("stringValue", out var stringValue)) return stringValue.GetString() ?? string.Empty;
    if (field.TryGetProperty("integerValue", out var integerValue)) return integerValue.GetString() ?? string.Empty;
    if (field.TryGetProperty("timestampValue", out var timestampValue)) return timestampValue.GetString() ?? string.Empty;
    return string.Empty;
}

static int FirestoreInt(JsonElement fields, string fieldName)
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

static DateTime? FirestoreTimestamp(JsonElement fields, string fieldName)
{
    var raw = FirestoreString(fields, fieldName);
    if (DateTime.TryParse(raw, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var parsed))
        return parsed;
    return null;
}

static object FirestoreValue(string? value) => new Dictionary<string, object>
{
    ["stringValue"] = value ?? string.Empty
};

static object FirestoreIntValue(int value) => new Dictionary<string, object>
{
    ["integerValue"] = value.ToString(CultureInfo.InvariantCulture)
};

static object FirestoreTimestampValue(DateTime value) => new Dictionary<string, object>
{
    ["timestampValue"] = value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture)
};

static bool UserCanPublishCatalog(HttpContext context, IConfiguration cfg)
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

static bool IsTruthy(string? value)
{
    value = (value ?? string.Empty).Trim();
    return value.Equals("true", StringComparison.OrdinalIgnoreCase) ||
           value.Equals("1", StringComparison.OrdinalIgnoreCase) ||
           value.Equals("yes", StringComparison.OrdinalIgnoreCase);
}

static string[] CatalogCollections() => ["catalogTests", "thematicTests"];

static List<CatalogQuestionPayload> BuildCatalogQuestions(UploadedDocument doc)
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
            string.IsNullOrWhiteSpace(question.Explanation) ? "Aus MediTest veröffentlichte Frage." : question.Explanation.Trim(),
            TopicLabel(question.Topic),
            DifficultyLabel(question.Difficulty),
            false));
    }

    return result;
}

static List<CatalogQuestionPayload> DeserializeCatalogQuestions(string questionsJson)
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
                false))
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

static string Slugify(string value)
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

static string MaskApiKey(string apiKey)
{
    apiKey = apiKey.Trim();
    if (apiKey.Length == 0) return string.Empty;
    if (apiKey.Length <= 10) return "****";
    return $"{apiKey[..4]}...{apiKey[^4..]}";
}

static List<(string Question, List<string> Options, int Correct, string Explanation, string Topic, string Difficulty)> ParseImportedQuestions(string content)
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

static byte[] BuildTestPdf(TestSession session, ProgramSettings settings)
{
    var writer = new SimplePdfWriter();
    var title = string.IsNullOrWhiteSpace(session.TestName) ? $"Test {session.Id}" : session.TestName;
    var documentName = session.Document?.FileName ?? "(unbekannt)";
    var submitted = session.SubmittedAt != null;
    var answered = session.Answers.Count(a => a.SelectedAnswerOptionId != null);

    writer.AddTitle("MediTest Testprotokoll");
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

static string EmptyDash(string? value) => string.IsNullOrWhiteSpace(value) ? "-" : value.Trim();

sealed class SimplePdfWriter
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

sealed record CatalogQuestionPayload(
    string QuestionText,
    List<string> Options,
    int CorrectOptionIndex,
    string Explanation,
    string Topic,
    string Difficulty,
    bool IsAiGenerated = false);

sealed record UpdateManifest(
    string Version,
    string? ReleaseDate,
    string? Notes,
    string? ReleaseUrl,
    List<UpdateDownloadDto> Downloads);

