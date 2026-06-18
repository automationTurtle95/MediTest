using System.Text.RegularExpressions;
using MediTest;
using MediTest.Dtos;
using MediTest.Models;
using MediTest.Services;
using static MediTest.AppSupport;

namespace MediTest.Endpoints;

public static class TestEndpoints
{
    public static IEndpointRouteBuilder MapTestEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/tests", async (FirestoreUserDataStore store, CancellationToken ct) =>
        {
            return Results.Ok(await store.ListTestsAsync(ct));
        });

        app.MapGet("/api/tests/sources", async (FirestoreUserDataStore store, CancellationToken ct) =>
        {
            var sources = (await store.ListDocumentsAsync(ct, seedDemo: false))
                .Where(document => document.QuestionCount > 0)
                .Select(document => new
                {
                    documentId = document.Id,
                    documentName = document.FileName,
                    document.QuestionCount
                });
            return Results.Ok(sources);
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

        app.MapPost("/api/tests/start-weak", async (StartWeakTestRequest req, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            try
            {
                return Results.Ok(await store.StartWeakTestAsync(req, ct));
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
            return Results.File(pdf, "application/pdf", $"{safeName}_{Brand.ProductName}.pdf");
        });

        return app;
    }

    private static string TrimTo(string? value, int maxLength)
    {
        value = (value ?? string.Empty).Trim();
        return value.Length <= maxLength ? value : value[..maxLength];
    }
}
