using System.Text;
using MediTest.Services;

namespace MediTest.Endpoints;

public static class StatsEndpoints
{
    public static IEndpointRouteBuilder MapStatsEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/stats/overview", async (int? testSessionId, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            return Results.Ok(await store.BuildStatsAsync(testSessionId, ct));
        });

        app.MapGet("/api/stats/export/tests", async (FirestoreUserDataStore store, CancellationToken ct) =>
        {
            var tests = await store.ListTestsAsync(ct);
            var completed = tests.Where(t => t.SubmittedAt.HasValue).ToList();
            var csv = new StringBuilder();
            csv.AppendLine("Testname;Dokument;Datum;Richtig;Fragen;Prozent;Bestanden");
            foreach (var t in completed.OrderBy(t => t.SubmittedAt))
                csv.AppendLine($"{CsvEsc(t.TestName)};{CsvEsc(t.DocumentName)};{t.SubmittedAt!.Value.ToLocalTime():dd.MM.yyyy HH:mm};{t.Score};{t.QuestionCount};{t.Percent:0.0};{(t.Passed ? "Ja" : "Nein")}");
            return CsvResult(csv, "Meduvalo-Testverlauf.csv");
        });

        app.MapGet("/api/stats/export/topics", async (FirestoreUserDataStore store, CancellationToken ct) =>
        {
            var stats = await store.BuildStatsAsync(null, ct);
            var csv = new StringBuilder();
            csv.AppendLine("Thema;Versuche;Richtig;Fehler;Fehlerquote %;Fragen im Pool;Fragenpool-Anzahl");
            foreach (var t in stats.TopicPerformance.OrderBy(t => t.Topic))
                csv.AppendLine($"{CsvEsc(t.Topic)};{t.Attempts};{t.Correct};{t.Errors};{t.Percent:0.0};{t.QuestionCount};{t.DocumentCount}");
            return CsvResult(csv, "Meduvalo-Themen.csv");
        });

        app.MapGet("/api/stats/export/weak-questions", async (FirestoreUserDataStore store, CancellationToken ct) =>
        {
            var stats = await store.BuildStatsAsync(null, ct);
            var csv = new StringBuilder();
            csv.AppendLine("Frage;Thema;Schwierigkeit;Dokument;Versuche;Fehler;Fehlerquote %;Zuletzt beantwortet");
            foreach (var q in stats.WeakQuestions)
                csv.AppendLine($"{CsvEsc(q.QuestionText)};{CsvEsc(q.Topic)};{CsvEsc(q.Difficulty)};{CsvEsc(q.DocumentName)};{q.Attempts};{q.Errors};{q.ErrorRate:0.0};{(q.LastAnsweredAt.HasValue ? q.LastAnsweredAt.Value.ToLocalTime().ToString("dd.MM.yyyy HH:mm") : "-")}");
            return CsvResult(csv, "Meduvalo-SchwacheFragen.csv");
        });

        app.MapGet("/api/dashboard/stats", async (FirestoreUserDataStore store, CancellationToken ct) =>
        {
            return Results.Ok(await store.GetDashboardStatsAsync(ct));
        });

        return app;
    }

    private static IResult CsvResult(StringBuilder csv, string filename)
    {
        var bytes = Encoding.UTF8.GetPreamble().Concat(Encoding.UTF8.GetBytes(csv.ToString())).ToArray();
        return Results.File(bytes, "text/csv; charset=utf-8", filename);
    }

    private static string CsvEsc(string? value)
    {
        value ??= string.Empty;
        return $"\"{value.Replace("\"", "\"\"")}\"";
    }
}
