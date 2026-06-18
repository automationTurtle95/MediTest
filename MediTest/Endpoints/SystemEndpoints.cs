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

public static class SystemEndpoints
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

        return app;
    }
}
