using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
namespace MediTest.Services;

public sealed class GeneratedQuestion
{
    public string QuestionText { get; set; } = string.Empty;
    public List<string> Options { get; set; } = new();
    public int CorrectOptionIndex { get; set; }
    public string Explanation { get; set; } = string.Empty;
    public string Topic { get; set; } = string.Empty;
    public string Difficulty { get; set; } = "mittel";
}

public interface IQuestionGenerationService
{
    Task<List<GeneratedQuestion>> GenerateAsync(string sourceText, int count, CancellationToken cancellationToken);
}

public sealed class OpenAiQuestionService : IQuestionGenerationService
{
    private readonly HttpClient _http;
    private readonly IConfiguration _configuration;
    private readonly ILogger<OpenAiQuestionService> _logger;
    private readonly IHttpContextAccessor _httpContextAccessor;

    public OpenAiQuestionService(HttpClient http, IConfiguration configuration, ILogger<OpenAiQuestionService> logger, IHttpContextAccessor httpContextAccessor)
    {
        _http = http;
        _configuration = configuration;
        _logger = logger;
        _httpContextAccessor = httpContextAccessor;
    }

    public async Task<List<GeneratedQuestion>> GenerateAsync(string sourceText, int count, CancellationToken cancellationToken)
    {
        var provider = AiProviderCatalog.FirebaseProvider;
        var authToken = provider == "firebase" ? GetCurrentBearerToken() : GetConfiguredAiApiKey(provider);
        if (string.IsNullOrWhiteSpace(authToken) ||
            authToken.Equals("HIER_DEINEN_OPENAI_API_KEY_EINFUEGEN", StringComparison.OrdinalIgnoreCase) ||
            authToken.Equals("sk-...", StringComparison.OrdinalIgnoreCase))
        {
            var message = provider == "firebase"
                ? "Anmeldedaten fehlen. Melde dich erneut an, damit die KI-Generierung gestartet werden kann."
                : "KI-Zugangsdaten fehlen oder sind ungültig.";
            throw new InvalidOperationException(message);
        }

        var primaryModel = AiProviderCatalog.DefaultModel;
        var customApiBaseUrl = _configuration["AI:FirebaseFunctionUrl"];
        if (string.IsNullOrWhiteSpace(customApiBaseUrl))
            customApiBaseUrl = AiProviderCatalog.FirebaseFunctionUrl;
        var chatUrl = AiProviderCatalog.BuildChatCompletionsUrl(provider, customApiBaseUrl);
        if (string.IsNullOrWhiteSpace(chatUrl))
            throw new InvalidOperationException("Der KI-Dienst ist nicht vollständig konfiguriert.");

        var models = provider == AiProviderCatalog.FirebaseProvider
            ? new List<string> { primaryModel }
            : AiProviderCatalog.GetModelFallbacks(provider, primaryModel);
        var limits = provider == AiProviderCatalog.FirebaseProvider
            ? new[] { count <= 10 ? 22000 : 36000 }
            : count <= 10 ? new[] { 22000, 14000 } : new[] { 36000, 24000, 16000 };
        var allowLocalFallback = _configuration.GetValue<bool>("OpenAI:AllowLocalFallback");

        var lastError = "";
        foreach (var model in models)
        {
            foreach (var maxChars in limits)
            {
                var prompt = BuildPrompt(sourceText, count, maxChars);
                var (ok, questions, errorMessage, retryable) = await TryGenerateViaAiProvider(provider, chatUrl, authToken, model, prompt, count, cancellationToken);
                if (ok && questions.Count > 0)
                    return questions.Take(count).ToList();

                lastError = errorMessage;
                if (!retryable)
                    break;
            }
        }

        if (allowLocalFallback)
        {
            _logger.LogWarning("KI-Generierung fehlgeschlagen, verwende lokalen Fallback. Letzter Fehler: {Error}", lastError);
            var fallback = GenerateLocalFallback(sourceText, count);
            if (fallback.Count > 0) return fallback;
        }

        throw new InvalidOperationException(string.IsNullOrWhiteSpace(lastError)
            ? "Die KI konnte keine Fragen erstellen. Lokaler Fallback ist deaktiviert, damit keine minderwertigen Platzhalterfragen entstehen."
            : "KI-Generierung fehlgeschlagen: " + lastError);
    }

    private string GetConfiguredAiApiKey(string provider)
    {
        var apiKey = Environment.GetEnvironmentVariable("MEDITEST_AI_API_KEY");
        if (string.IsNullOrWhiteSpace(apiKey) && provider == "openai") apiKey = Environment.GetEnvironmentVariable("OPENAI_API_KEY");
        if (string.IsNullOrWhiteSpace(apiKey)) apiKey = _configuration["AI:ApiKey"];
        if (string.IsNullOrWhiteSpace(apiKey) && provider == "openai") apiKey = _configuration["OpenAI:ApiKey"];
        return apiKey?.Trim() ?? string.Empty;
    }

    private string GetCurrentBearerToken()
    {
        var authorization = _httpContextAccessor.HttpContext?.Request.Headers.Authorization.ToString() ?? string.Empty;
        const string bearerPrefix = "Bearer ";
        return authorization.StartsWith(bearerPrefix, StringComparison.OrdinalIgnoreCase)
            ? authorization[bearerPrefix.Length..].Trim()
            : string.Empty;
    }

    private async Task<(bool ok, List<GeneratedQuestion> questions, string errorMessage, bool retryable)> TryGenerateViaAiProvider(string provider, string chatUrl, string apiKey, string model, string prompt, int questionCount, CancellationToken cancellationToken)
    {
        var result = await SendChatRequest(provider, chatUrl, apiKey, model, prompt, questionCount, includeResponseFormat: true, cancellationToken);
        if (!result.ok && result.errorMessage.Contains("response_format", StringComparison.OrdinalIgnoreCase))
            return await SendChatRequest(provider, chatUrl, apiKey, model, prompt, questionCount, includeResponseFormat: false, cancellationToken);

        return result;
    }

    private async Task<(bool ok, List<GeneratedQuestion> questions, string errorMessage, bool retryable)> SendChatRequest(
        string provider,
        string chatUrl,
        string apiKey,
        string model,
        string prompt,
        int questionCount,
        bool includeResponseFormat,
        CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, chatUrl);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey);
        if (provider == "openrouter")
        {
            request.Headers.TryAddWithoutValidation("HTTP-Referer", "http://127.0.0.1:55000");
            request.Headers.TryAddWithoutValidation("X-Title", global::MediTest.Brand.ProductName);
        }

        var messages = new object[]
        {
            new { role = "system", content = "Du erzeugst prüfungsnahe Multiple-Choice-Fragen für das Medizinstudium. Antworte ausschließlich als valides JSON." },
            new { role = "user", content = prompt }
        };

        var payload = includeResponseFormat
            ? JsonSerializer.Serialize(new
            {
                model,
                temperature = 0.2,
                questionCount,
                response_format = new { type = "json_object" },
                messages
            })
            : JsonSerializer.Serialize(new
            {
                model,
                temperature = 0.2,
                questionCount,
                messages
            });

        request.Content = new StringContent(payload, Encoding.UTF8, "application/json");

        HttpResponseMessage response;
        string body;
        try
        {
            response = await _http.SendAsync(request, cancellationToken);
            body = await response.Content.ReadAsStringAsync(cancellationToken);
        }
        catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return (false, new List<GeneratedQuestion>(), "Zeitlimit erreicht: Der KI-Dienst hat nicht innerhalb von 5 Minuten geantwortet. Versuche weniger Fragen.", false);
        }
        catch (HttpRequestException)
        {
            return (false, new List<GeneratedQuestion>(), "Verbindung zum KI-Dienst fehlgeschlagen. Bitte versuche es später erneut.", true);
        }

        using (response)
        {
            if (!response.IsSuccessStatusCode)
            {
                var message = ParseAiError(body);
                var retryable = (int)response.StatusCode == 429 || (int)response.StatusCode >= 500 || message.Contains("rate", StringComparison.OrdinalIgnoreCase) || message.Contains("quota", StringComparison.OrdinalIgnoreCase);
                _logger.LogWarning("KI-Anbieter Fehler {Status} ({Provider}, {Model}): {Message}", response.StatusCode, provider, model, message);
                return (false, new List<GeneratedQuestion>(), message, retryable);
            }
        }

        using var outer = JsonDocument.Parse(body);
        var contentElement = outer.RootElement.GetProperty("choices")[0].GetProperty("message").GetProperty("content");
        var content = contentElement.ValueKind == JsonValueKind.String ? contentElement.GetString() : contentElement.GetRawText();
        if (string.IsNullOrWhiteSpace(content))
            return (false, new List<GeneratedQuestion>(), "Die KI hat keinen Inhalt geliefert.", true);

        content = ExtractJsonObject(content);
        using var inner = JsonDocument.Parse(content);
        if (!inner.RootElement.TryGetProperty("questions", out var questionsElement))
            return (false, new List<GeneratedQuestion>(), "JSON enthält kein Feld 'questions'.", true);

        var result = new List<GeneratedQuestion>();
        foreach (var q in questionsElement.EnumerateArray())
        {
            var options = q.GetProperty("options").EnumerateArray().Select(o => o.GetString() ?? string.Empty).Where(o => !string.IsNullOrWhiteSpace(o)).Take(5).ToList();
            if (options.Count != 5) continue;
            var correctIndex = q.GetProperty("correctOptionIndex").GetInt32();
            if (correctIndex < 0 || correctIndex > 4) continue;
            result.Add(new GeneratedQuestion
            {
                QuestionText = q.GetProperty("questionText").GetString() ?? string.Empty,
                Options = options,
                CorrectOptionIndex = correctIndex,
                Explanation = q.GetProperty("explanation").GetString() ?? string.Empty,
                Topic = q.GetProperty("topic").GetString() ?? "Allgemein",
                Difficulty = NormalizeDifficulty(q.GetProperty("difficulty").GetString())
            });
        }

        return result.Count > 0
            ? (true, result, "", false)
            : (false, result, "Die KI lieferte keine verwertbaren Fragen.", true);
    }

    private static string ParseAiError(string body)
    {
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.TryGetProperty("error", out var err))
            {
                var msg = err.TryGetProperty("message", out var m) ? m.GetString() : null;
                var code = err.TryGetProperty("code", out var c) ? c.GetString() : null;
                var type = err.TryGetProperty("type", out var t) ? t.GetString() : null;
                return string.Join(" | ", new[] { msg, code, type }.Where(s => !string.IsNullOrWhiteSpace(s))!);
            }
        }
        catch { }
        return string.IsNullOrWhiteSpace(body) ? "Unbekannter KI-Fehler" : body;
    }

    private static string ExtractJsonObject(string content)
    {
        content = content.Trim();
        var first = content.IndexOf('{');
        var last = content.LastIndexOf('}');
        return first >= 0 && last > first ? content[first..(last + 1)] : content;
    }

    private static string BuildPrompt(string sourceText, int count, int maxChars)
    {
        var clipped = sourceText.Length > maxChars ? sourceText[..maxChars] : sourceText;
        return $$"""
Erzeuge {{count}} hochwertige Multiple-Choice-Prüfungsfragen ausschließlich aus dem folgenden Skripttext.

Qualitätsregeln:
- Nur Inhalte verwenden, die im Skript stehen.
- Keine erfundenen Fakten und keine externen Leitlinien ergänzen.
- Medizinisch korrekt, prüfungsnah und eindeutig.
- Keine Platzhalterfragen wie "Welche Aussage ist korrekt?".
- Jede Frage muss einen konkreten Inhalt abfragen: Struktur, Funktion, Lokalisation, Verlauf, Klinik, Definition oder Zusammenhang.
- Jede Frage hat genau 5 Antwortmöglichkeiten.
- Genau eine Antwort ist richtig.
- Distraktoren müssen thematisch ähnlich und plausibel sein, aber klar falsch.
- Distraktoren bevorzugt aus dem Skript ableiten, etwa durch vertauschte Stadien, Grenzwerte, Lokalisationen, Zuordnungen oder Zusammenhänge.
- Keine neuen Zahlen, Altersgrenzen oder Leitlinienkriterien erfinden. Wenn vier gute Distraktoren nicht möglich sind, frage eine andere Kernaussage ab.
- Keine Frage darf dieselbe Kernaussage wie eine andere Frage prüfen.
- Richtige Antworten bei mehreren Fragen möglichst gleichmäßig über die Indizes 0 bis 4 verteilen; bei 5 Fragen jeden Index genau einmal verwenden.
- Richtige Antworten dürfen nicht systematisch länger, präziser oder sprachlich auffälliger als die Distraktoren sein. Formuliere die Optionen möglichst in vergleichbarer Länge und Struktur.
- Erklärung kurz, mit Bezug auf den Skriptinhalt.
- Thema so spezifisch wie möglich, z. B. "N. facialis", "Basis cranii", "pAVK".
- Schwierigkeitsgrad nur: leicht, mittel, schwer.

Antworte exakt in diesem JSON-Format:
{
  "questions": [
    {
      "questionText": "...",
      "options": ["...", "...", "...", "...", "..."],
      "correctOptionIndex": 0,
      "explanation": "...",
      "topic": "...",
      "difficulty": "mittel"
    }
  ]
}

Wenn der Skripttext zu unstrukturiert ist, extrahiere zuerst sinnvolle medizinische Kernaussagen und frage diese ab. Liefere trotzdem nur JSON.

SKRIPTTEXT:
{{clipped}}
""";
    }

    private static List<GeneratedQuestion> GenerateLocalFallback(string sourceText, int count)
    {
        var sentences = Regex.Split(sourceText ?? string.Empty, @"(?<=[\.\!\?])\s+")
            .Select(s => s.Trim())
            .Where(s => s.Length > 35 && s.Length < 260)
            .Distinct()
            .Take(Math.Max(count * 3, 80))
            .ToList();

        var result = new List<GeneratedQuestion>();
        for (var i = 0; i < Math.Min(count, sentences.Count); i++)
        {
            var s = sentences[i];
            var distractors = sentences.Where((x, idx) => idx != i).Take(4).Select(x => Shorten(x, 70)).ToList();
            if (distractors.Count < 4) break;
            var correct = Shorten(s, 70);
            var options = new List<string> { correct, distractors[0], distractors[1], distractors[2], distractors[3] }
                .OrderBy(_ => Random.Shared.Next())
                .ToList();

            result.Add(new GeneratedQuestion
            {
                QuestionText = "Welche Aussage ist laut Skript korrekt?",
                Options = options,
                CorrectOptionIndex = options.IndexOf(correct),
                Explanation = "Die richtige Antwort ist die Aussage, die im Skript wörtlich bzw. sinngleich enthalten ist.",
                Topic = "Skriptwissen",
                Difficulty = "mittel"
            });
        }

        return result;
    }

    private static string Shorten(string text, int max)
    {
        text = Regex.Replace(text, "\\s+", " ").Trim();
        if (text.Length <= max) return text;
        return text[..(max - 1)].TrimEnd() + "…";
    }

    private static string NormalizeDifficulty(string? value)
    {
        value = (value ?? "mittel").Trim().ToLowerInvariant();
        return value is "leicht" or "mittel" or "schwer" ? value : "mittel";
    }
}

