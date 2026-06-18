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

public static class AdminEndpoints
{
    public static IEndpointRouteBuilder MapAdminEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/admin/ai-usage", async (HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, CancellationToken ct) =>
        {
            if (!UserCanPublishCatalog(context, cfg))
                return Results.Json(new { error = "Nur Administratoren dürfen die KI-Nutzung einsehen." }, statusCode: StatusCodes.Status403Forbidden);

            var token = FirebaseBearerToken(context);
            if (string.IsNullOrWhiteSpace(token)) return Results.Unauthorized();

            var usageUrl = cfg["AI:FirebaseUsageFunctionUrl"];
            if (string.IsNullOrWhiteSpace(usageUrl)) usageUrl = AiProviderCatalog.FirebaseUsageFunctionUrl;

            using var request = new HttpRequestMessage(HttpMethod.Get, usageUrl);
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
            using var response = await httpClientFactory.CreateClient().SendAsync(request, ct);
            var raw = await response.Content.ReadAsStringAsync(ct);
            return Results.Content(raw, "application/json; charset=utf-8", Encoding.UTF8, (int)response.StatusCode);
        });

        app.MapPost("/api/admin/stripe-products/validate", async (
            ValidateStripeProductsRequest req,
            HttpContext context,
            IConfiguration cfg,
            IHttpClientFactory httpClientFactory,
            CancellationToken ct) =>
        {
            if (!UserCanPublishCatalog(context, cfg))
                return Results.Json(new { error = "Nur Admin-Konten dürfen Stripe-Produkte prüfen." }, statusCode: StatusCodes.Status403Forbidden);

            var functionUrl = FirebaseFunctionUrl(
                cfg,
                "Billing:StripeProductValidationFunctionUrl",
                "meditestValidateStripeProducts");
            var functionResult = await SendProtectedFirebaseFunctionAsync(
                httpClientFactory,
                context,
                HttpMethod.Post,
                functionUrl,
                new { createMissing = req.CreateMissing },
                "Die Stripe-Produkte konnten nicht validiert werden.",
                ct);
            if (functionResult.Error != null) return functionResult.Error;
            using var json = functionResult.Json;
            return json == null
                ? Results.Ok(new { valid = false, issues = new[] { new { message = "Stripe hat keinen Prüfbericht geliefert." } } })
                : Results.Ok(json.RootElement.Clone());
        });

        return app;
    }
}
