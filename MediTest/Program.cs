using System.Diagnostics;
using MediTest;
using MediTest.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.IdentityModel.Tokens;
using static MediTest.AppSupport;

using var singleInstanceMutex = new Mutex(true, SingleInstanceName(), out var ownsSingleInstance);
if (!ownsSingleInstance)
{
    return;
}

Process? managedBrowserProcess = null;

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
builder.Services.AddSingleton<ProductInfoService>();
builder.Services.AddSingleton<DeviceIdentityService>();
builder.Services.AddSingleton<InstallationAuthorizationService>();
builder.Services.AddSingleton<LicenseCacheStore>();
builder.Services.AddScoped<LicenseAccessService>();
builder.Services.AddDataProtection().SetApplicationName("MediTest");
builder.Services.AddMemoryCache();
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
            options.MapInboundClaims = false;
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
        await context.Response.WriteAsJsonAsync(new { error = "Ein unerwarteter Fehler ist aufgetreten. Bitte versuche es erneut." });
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
            if (!FirebaseEmailVerified(context.User))
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                context.Response.ContentType = "application/json; charset=utf-8";
                await context.Response.WriteAsJsonAsync(new
                {
                    error = "Bitte bestätige zuerst deine E-Mail-Adresse.",
                    emailVerificationRequired = true
                });
                return;
            }

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
app.Use(async (context, next) =>
{
    if (!RequiresLicenseGate(context))
    {
        await next();
        return;
    }

    var access = await context.RequestServices.GetRequiredService<LicenseAccessService>()
        .CheckAsync(context.RequestAborted);
    if (access.Result.RequiresTermsAcceptance)
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        await context.Response.WriteAsJsonAsync(new
        {
            error = "Bitte akzeptiere zuerst die aktuellen Nutzungsbedingungen und die Datenschutzerklärung.",
            termsAcceptanceRequired = true
        });
        return;
    }
    if (!access.Result.IsValid)
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        await context.Response.WriteAsJsonAsync(new
        {
            error = access.Result.Message,
            licenseRequired = true,
            licenseStatus = access.Result.Status
        });
        return;
    }
    if (access.Result.Status.Equals("restricted", StringComparison.OrdinalIgnoreCase) &&
        !RestrictedAccessPolicy.Allows(context.Request.Method, context.Request.Path))
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        await context.Response.WriteAsJsonAsync(new
        {
            error = "Diese Funktion ist nach der 7-tägigen Testphase im Monatsabo verfügbar. Vorhandene Tests bleiben weiterhin nutzbar.",
            subscriptionRequired = true,
            restrictedMode = true,
            licenseStatus = access.Result.Status
        });
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
    managedBrowserProcess = OpenBrowser(url.TrimEnd('/') + "/index.html?v=5015");
});

app.Lifetime.ApplicationStopping.Register(() =>
{
    CloseManagedBrowser(managedBrowserProcess);
    CloseOtherMediTestInstances();
});

app.MapSystemEndpoints();
app.MapAccountEndpoints();
app.MapLicenseEndpoints();
app.MapDocumentEndpoints();
app.MapCatalogEndpoints();
app.MapTestEndpoints();
app.MapStatsEndpoints();
app.MapAdminEndpoints();

app.Run();
