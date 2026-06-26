using System.Net;
using MediTest.Dtos;
using static MediTest.AppSupport;

namespace MediTest;

internal static class SystemEndpoints
{
    public static IEndpointRouteBuilder MapSystemEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/system/shutdown", (HttpContext context, IHostApplicationLifetime lifetime) =>
        {
            var remoteIp = context.Connection.RemoteIpAddress;
            if (remoteIp is not null && !IPAddress.IsLoopback(remoteIp))
                return Results.Forbid();

            _ = Task.Run(async () =>
            {
                await Task.Delay(250);
                lifetime.StopApplication();
            });

            return Results.Ok(new { shuttingDown = true });
        });

        app.MapPost("/api/system/open-url", (HttpContext context, OpenUrlRequest request) =>
        {
            var remoteIp = context.Connection.RemoteIpAddress;
            if (remoteIp is not null && !IPAddress.IsLoopback(remoteIp))
                return Results.Forbid();

            var url = (request.Url ?? string.Empty).Trim();
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
                (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
                return Results.BadRequest(new { error = "Ungültige URL." });

            OpenBrowser(url);
            return Results.Ok(new { opened = true });
        });

        app.MapGet("/api/system/update", async (IConfiguration cfg, IHttpClientFactory httpClientFactory, CancellationToken ct) =>
        {
            return Results.Ok(await CheckForUpdateAsync(cfg, httpClientFactory, ct));
        });

        app.MapGet("/api/app/info", (IConfiguration cfg) =>
        {
            return Results.Ok(new
            {
                version = AppVersion(),
                productName = cfg["Product:ProductName"] ?? "Meduvalo"
            });
        });

        return app;
    }
}

internal sealed record OpenUrlRequest(string? Url);
