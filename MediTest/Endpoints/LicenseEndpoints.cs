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

public static class LicenseEndpoints
{
    public static IEndpointRouteBuilder MapLicenseEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/license/status", async (HttpContext context, IConfiguration cfg, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            var state = await store.GetLicenseStateAsync(BillingTrialDays(cfg), ct);
            return Results.Ok(ToLicenseStatusDto(state, context, cfg));
        });

        app.MapGet("/api/legal-license/status", async (ProductInfoService productInfo, LicenseAccessService licenseAccess, CancellationToken ct) =>
        {
            var access = await licenseAccess.CheckAsync(ct);
            return Results.Ok(new LegalLicenseStatusDto(productInfo.GetLegalInfo(), access));
        });

        app.MapPost("/api/legal-license/check", async (LicenseAccessService licenseAccess, CancellationToken ct) =>
        {
            return Results.Ok(await licenseAccess.CheckAsync(ct, force: true));
        });

        app.MapPost("/api/legal-license/device", async (LicenseAccessService licenseAccess, CancellationToken ct) =>
        {
            return Results.Ok(await licenseAccess.ActivateDeviceAsync(ct));
        });

        app.MapPost("/api/legal-license/terms", async (AcceptTermsRequest req, LicenseAccessService licenseAccess, CancellationToken ct) =>
        {
            return Results.Ok(await licenseAccess.AcceptTermsAsync(req, ct));
        });

        app.MapPost("/api/license/redeem-premium-code", async (RedeemPremiumCodeRequest req, HttpContext context, IConfiguration cfg, FirestoreUserDataStore store, IHttpClientFactory httpClientFactory, CancellationToken ct) =>
        {
            var normalizedCode = NormalizePremiumCode(req.Code);
            if (string.IsNullOrWhiteSpace(normalizedCode))
                return Results.BadRequest(new { error = "Bitte gib einen Premium-Code ein." });

            var functionUrl = FirebaseFunctionUrl(cfg, "Billing:PremiumCodeRedemptionFunctionUrl", "meditestRedeemPremiumCode");
            var functionResult = await SendProtectedFirebaseFunctionAsync(
                httpClientFactory,
                context,
                HttpMethod.Post,
                functionUrl,
                new { code = req.Code },
                "Der Premium-Code konnte nicht eingelöst werden.",
                ct);
            if (functionResult.Error != null) return functionResult.Error;
            functionResult.Json?.Dispose();

            var state = await store.GetLicenseStateAsync(BillingTrialDays(cfg), ct);
            return Results.Ok(ToLicenseStatusDto(state, context, cfg));
        });

        app.MapPost("/api/license/redeem-catalog-code", async (RedeemCatalogCodeRequest req, HttpContext context, IConfiguration cfg, FirestoreUserDataStore store, IHttpClientFactory httpClientFactory, CancellationToken ct) =>
        {
            var normalizedCode = NormalizePremiumCode(req.Code);
            if (string.IsNullOrWhiteSpace(normalizedCode))
                return Results.BadRequest(new { error = "Bitte gib einen Gratis-Katalog-Code ein." });

            var functionUrl = FirebaseFunctionUrl(cfg, "Billing:CatalogCodeRedemptionFunctionUrl", "meditestRedeemCatalogCode");
            var functionResult = await SendProtectedFirebaseFunctionAsync(
                httpClientFactory,
                context,
                HttpMethod.Post,
                functionUrl,
                new { code = req.Code },
                "Der Gratis-Katalog-Code konnte nicht eingelöst werden.",
                ct);
            if (functionResult.Error != null) return functionResult.Error;

            var state = await store.GetLicenseStateAsync(BillingTrialDays(cfg), ct);
            return Results.Ok(ToLicenseStatusDto(state, context, cfg));
        });

        app.MapDelete("/api/account", async (HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, CancellationToken ct) =>
        {
            var functionUrl = FirebaseFunctionUrl(cfg, "Auth:Firebase:DeleteAccountFunctionUrl", "meditestDeleteAccount");
            var functionResult = await SendProtectedFirebaseFunctionAsync(
                httpClientFactory,
                context,
                HttpMethod.Delete,
                functionUrl,
                null,
                "Das Konto konnte nicht gelöscht werden.",
                ct);
            if (functionResult.Error != null) return functionResult.Error;
            return Results.Ok(new { deleted = true, message = "Konto und zugehörige Nutzerdaten wurden gelöscht." });
        });

        app.MapPost("/api/license/checkout/subscription", async (HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, CancellationToken ct) =>
        {
            var functionUrl = FirebaseFunctionUrl(cfg, "Billing:CheckoutFunctionUrl", "meditestCreateCheckout");
            var functionResult = await SendProtectedFirebaseFunctionAsync(
                httpClientFactory,
                context,
                HttpMethod.Post,
                functionUrl,
                new { kind = "subscription" },
                "Der Stripe-Checkout konnte nicht gestartet werden.",
                ct);
            if (functionResult.Error != null) return functionResult.Error;
            using var json = functionResult.Json;
            return Results.Ok(ParseCheckoutLink(json, "Weiterleitung zum Abo-Checkout."));
        });

        app.MapPost("/api/license/portal", async (HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, CancellationToken ct) =>
        {
            var functionUrl = FirebaseFunctionUrl(cfg, "Billing:StripePortalFunctionUrl", "meditestStripePortal");
            var functionResult = await SendProtectedFirebaseFunctionAsync(
                httpClientFactory,
                context,
                HttpMethod.Post,
                functionUrl,
                new
                {
                    returnUrl = "http://127.0.0.1:55000/pages/license.html"
                },
                "Das Stripe-Kundenportal konnte nicht geöffnet werden.",
                ct);
            if (functionResult.Error != null) return functionResult.Error;
            using var json = functionResult.Json;
            return Results.Ok(ParseCheckoutLink(json, "Weiterleitung zum Stripe-Kundenportal."));
        });

        return app;
    }
}
