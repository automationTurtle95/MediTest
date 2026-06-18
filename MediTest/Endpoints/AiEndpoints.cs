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

public static class AiEndpoints
{
    public static IEndpointRouteBuilder MapAiEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/ai/status", async (HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, CancellationToken ct) =>
        {
            var token = FirebaseBearerToken(context);
            if (string.IsNullOrWhiteSpace(token)) return Results.Unauthorized();

            var statusUrl = cfg["AI:FirebaseStatusFunctionUrl"];
            if (string.IsNullOrWhiteSpace(statusUrl)) statusUrl = AiProviderCatalog.FirebaseStatusFunctionUrl;

            using var request = new HttpRequestMessage(HttpMethod.Get, statusUrl);
            request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {token}");
            using var response = await httpClientFactory.CreateClient().SendAsync(request, ct);
            var raw = await response.Content.ReadAsStringAsync(ct);
            return Results.Content(raw, "application/json; charset=utf-8", Encoding.UTF8, (int)response.StatusCode);
        });

        return app;
    }
}
