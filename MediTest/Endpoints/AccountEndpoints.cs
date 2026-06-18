using System.Globalization;
using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediTest;
using MediTest.Dtos;
using MediTest.Models;
using MediTest.Services;
using static MediTest.AppSupport;

namespace MediTest.Endpoints;

public static class AccountEndpoints
{
    public static IEndpointRouteBuilder MapAccountEndpoints(this IEndpointRouteBuilder app)
    {
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
            else if (state.BaseProductPurchased && state.TrialEndsAt is { } trialEnd && trialEnd > DateTime.UtcNow)
                user = user with { Plan = "Testphase", LicenseStatus = "Aktiv" };
            else if (state.BaseProductPurchased)
                user = user with { Plan = "Basis", LicenseStatus = "Eingeschränkt" };
            else
                user = user with { Plan = "Nicht gekauft", LicenseStatus = "Inaktiv" };
            return Results.Ok(new AuthResponse(user));
        });

        app.MapGet("/api/app/info", (IConfiguration cfg) =>
        {
            return Results.Ok(new
            {
                version = AppVersion(),
                productName = cfg["Product:ProductName"] ?? "Meduvalo"
            });
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
            settings.DailyGoalQuestions = Math.Clamp(req.DailyGoalQuestions, 1, 500);
            ApplyFixedAiSettings(settings);
            if (UserOnboardingPolicy.IsProfileComplete(settings))
                settings.ProfileCompletedAt ??= DateTime.UtcNow;
            settings.UpdatedAt = DateTime.UtcNow;

            await store.SaveSettingsAsync(settings, ct);
            return Results.Ok(ToProgramSettingsDto(settings));
        });

        app.MapPost("/api/profile/complete", async (
            CompleteProfileRequest req,
            HttpContext context,
            FirestoreUserDataStore store,
            CancellationToken ct) =>
        {
            var settings = await store.GetSettingsAsync(ct);
            settings.DisplayName = TrimTo(req.DisplayName, 200);
            settings.MatriculationNumber = TrimTo(req.MatriculationNumber, 80);
            settings.StudyProgram = TrimTo(req.StudyProgram, 200);
            settings.University = TrimTo(req.University, 200);
            settings.Semester = TrimTo(req.Semester, 80);
            settings.Email = TrimTo(FirstClaim(context.User, "email", ClaimTypes.Email), 240);

            if (!UserOnboardingPolicy.IsProfileComplete(settings))
            {
                return Results.BadRequest(new
                {
                    error = "Bitte fülle Name, Studiengang, Hochschule beziehungsweise Universität und Semester vollständig aus."
                });
            }

            settings.ProfileCompletedAt ??= DateTime.UtcNow;
            await store.SaveSettingsAsync(settings, ct);
            return Results.Ok(ToProgramSettingsDto(settings));
        });

        app.MapPost("/api/trial-feedback", async (
            TrialFeedbackRequest req,
            IConfiguration cfg,
            FirestoreUserDataStore store,
            CancellationToken ct) =>
        {
            var now = DateTime.UtcNow;
            var settings = await store.GetSettingsAsync(ct);
            var license = await store.GetLicenseStateAsync(BillingTrialDays(cfg), ct);
            if (!UserOnboardingPolicy.ShouldRequestTrialFeedback(license, settings, now))
                return Results.BadRequest(new { error = "Für dieses Konto ist derzeit keine Feedbackanfrage offen." });

            var action = (req.Action ?? string.Empty).Trim().ToLowerInvariant();
            settings.TrialFeedbackPromptedAt = now;
            if (action == "later")
            {
                settings.TrialFeedbackNextPromptAt = now.AddDays(7);
                await store.SaveSettingsAsync(settings, ct);
                return Results.Ok(new { submitted = false, nextPromptAt = settings.TrialFeedbackNextPromptAt });
            }

            if (action != "submit")
                return Results.BadRequest(new { error = "Ungültige Feedbackaktion." });
            if (req.Rating is null or < 1 or > 5)
                return Results.BadRequest(new { error = "Bitte wähle eine Bewertung zwischen 1 und 5." });

            settings.TrialFeedbackRating = req.Rating;
            settings.TrialFeedbackComment = TrimTo(req.Comment, 2000);
            settings.TrialFeedbackSubmittedAt = now;
            settings.TrialFeedbackNextPromptAt = null;
            await store.SaveSettingsAsync(settings, ct);
            return Results.Ok(new { submitted = true, message = "Vielen Dank. Dein Feedback wurde in deinem Konto gespeichert und nicht per E-Mail versendet." });
        });

        app.MapPost("/api/support", async (
            SupportRequest req,
            HttpContext context,
            IConfiguration cfg,
            IHttpClientFactory httpClientFactory,
            CancellationToken ct) =>
        {
            var category = TrimTo(req.Category, 40);
            var subject = TrimTo(req.Subject, 160);
            var message = TrimTo(req.Message, 5000);
            if (string.IsNullOrWhiteSpace(subject))
                return Results.BadRequest(new { error = "Bitte gib einen Betreff ein." });
            if (message.Length < 10)
                return Results.BadRequest(new { error = "Bitte beschreibe dein Anliegen mit mindestens 10 Zeichen." });

            var functionUrl = FirebaseFunctionUrl(cfg, "Product:SupportFunctionUrl", "meditestSupportRequest");
            var functionResult = await SendProtectedFirebaseFunctionAsync(
                httpClientFactory,
                context,
                HttpMethod.Post,
                functionUrl,
                new
                {
                    category,
                    subject,
                    message,
                    diagnostics = req.IncludeDiagnostics
                        ? new
                        {
                            appVersion = AppVersion(),
                            currentPage = TrimTo(req.CurrentPage, 500),
                            userAgent = TrimTo(req.UserAgent, 500)
                        }
                        : null
                },
                "Die Supportanfrage konnte nicht übermittelt werden.",
                ct);
            if (functionResult.Error != null) return functionResult.Error;
            using var json = functionResult.Json;
            var supportEmail = string.IsNullOrWhiteSpace(cfg["Product:SupportEmail"])
                ? "support@meduvalo.at"
                : cfg["Product:SupportEmail"]!.Trim();
            return json == null
                ? Results.Ok(new { submitted = true, message = $"Deine Supportanfrage wurde an {supportEmail} übermittelt." })
                : Results.Ok(json.RootElement.Clone());
        });

        return app;
    }
}
