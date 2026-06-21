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
