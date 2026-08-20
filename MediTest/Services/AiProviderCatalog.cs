namespace MediTest.Services;

public sealed record AiModelOption(string Value, string Label);

public sealed record AiProviderOption(
    string Id,
    string Label,
    string ChatCompletionsUrl,
    bool UsesCustomBaseUrl,
    IReadOnlyList<AiModelOption> Models);

public static class AiProviderCatalog
{
    public const string DefaultProvider = "firebase";
    // gemini-2.5-flash Free-Tier-Kontingent ist auf 20 Anfragen/Tag begrenzt (bestaetigt 20.08.2026,
    // "GenerateRequestsPerDayPerProjectPerModel-FreeTier"). Kontingent ist PRO MODELL getrennt -
    // gemini-3.5-flash-lite hat noch unverbrauchtes, grosszuegigeres Free-Tier-Kontingent.
    // gemini-2.0-flash/gemini-2.5-flash-lite sind zum 20.08.2026 fuer neue Nutzung eingestellt (404).
    public const string DefaultModel = "gemini-3.5-flash-lite";
    public const string FirebaseProvider = "firebase";
    public const string FirebaseFunctionUrl = "https://europe-west3-meditest-12354.cloudfunctions.net/meditestAi";
    public const string FirebaseUsageFunctionUrl = "https://europe-west3-meditest-12354.cloudfunctions.net/meditestAiUsage";
    public const string FirebaseStatusFunctionUrl = "https://europe-west3-meditest-12354.cloudfunctions.net/meditestAiStatus";

    private static readonly AiProviderOption[] ProviderOptions =
    [
        new(
            "openai",
            "OpenAI",
            "https://api.openai.com/v1/chat/completions",
            false,
            [
                new("gpt-4o-mini", "GPT-4o mini"),
                new("gpt-4.1-mini", "GPT-4.1 mini"),
                new("gpt-4.1", "GPT-4.1"),
                new("gpt-4o", "GPT-4o"),
                new("__custom__", "Eigenes Modell")
            ]),
        new(
            "openrouter",
            "OpenRouter",
            "https://openrouter.ai/api/v1/chat/completions",
            false,
            [
                new("openrouter/auto", "Auto-Auswahl"),
                new("openai/gpt-4o-mini", "OpenAI GPT-4o mini"),
                new("anthropic/claude-3.5-haiku", "Claude 3.5 Haiku"),
                new("google/gemini-flash-1.5", "Gemini Flash"),
                new("__custom__", "Eigenes Modell")
            ]),
        new(
            "mistral",
            "Mistral AI",
            "https://api.mistral.ai/v1/chat/completions",
            false,
            [
                new("mistral-small-latest", "Mistral Small"),
                new("mistral-large-latest", "Mistral Large"),
                new("open-mistral-nemo", "Open Mistral Nemo"),
                new("__custom__", "Eigenes Modell")
            ]),
        new(
            "groq",
            "Groq",
            "https://api.groq.com/openai/v1/chat/completions",
            false,
            [
                new("llama-3.3-70b-versatile", "Llama 3.3 70B Versatile"),
                new("llama-3.1-8b-instant", "Llama 3.1 8B Instant"),
                new("__custom__", "Eigenes Modell")
            ]),
        new(
            "firebase",
            "Firebase Function",
            "",
            true,
            [
                new("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite (Standard, hohes Freikontingent)"),
                new("gemini-flash-latest", "Gemini Flash (latest)"),
                new("gemini-2.5-flash", "Gemini 2.5 Flash (Free-Tier: 20 Anfragen/Tag)"),
                new("gemini-2.5-pro", "Gemini 2.5 Pro"),
                new("__custom__", "Eigenes Modell")
            ]),
        new(
            "custom",
            "OpenAI-kompatibel",
            "",
            true,
            [
                new("__custom__", "Eigenes Modell")
            ])
    ];

    public static IReadOnlyList<AiProviderOption> Options => ProviderOptions;

    public static string NormalizeProvider(string? provider)
    {
        var id = (provider ?? DefaultProvider).Trim().ToLowerInvariant();
        return ProviderOptions.Any(p => p.Id == id) ? id : DefaultProvider;
    }

    public static string NormalizeModel(string? provider, string? model)
    {
        var providerId = NormalizeProvider(provider);
        var value = (model ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(value) || value == "__custom__")
            value = GetDefaultModel(providerId);

        return value.Length <= 200 ? value : value[..200];
    }

    public static string GetDefaultModel(string? provider)
    {
        var providerId = NormalizeProvider(provider);
        var option = ProviderOptions.First(p => p.Id == providerId);
        return option.Models.FirstOrDefault(m => m.Value != "__custom__")?.Value ?? DefaultModel;
    }

    public static List<string> GetModelFallbacks(string? provider, string primaryModel)
    {
        var providerId = NormalizeProvider(provider);
        var options = ProviderOptions.First(p => p.Id == providerId).Models
            .Select(m => m.Value)
            .Where(m => m != "__custom__");

        return new[] { primaryModel }.Concat(options)
            .Where(m => !string.IsNullOrWhiteSpace(m))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(providerId == "custom" ? 1 : 3)
            .ToList();
    }

    public static string NormalizeApiBaseUrl(string? apiBaseUrl)
    {
        var value = (apiBaseUrl ?? string.Empty).Trim().TrimEnd('/');
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        return value.Length <= 400 ? value : value[..400];
    }

    public static bool RequiresApiBaseUrl(string? provider)
    {
        var providerId = NormalizeProvider(provider);
        return ProviderOptions.First(p => p.Id == providerId).UsesCustomBaseUrl;
    }

    public static string BuildChatCompletionsUrl(string? provider, string? customApiBaseUrl)
    {
        var providerId = NormalizeProvider(provider);
        var option = ProviderOptions.First(p => p.Id == providerId);
        if (!option.UsesCustomBaseUrl) return option.ChatCompletionsUrl;

        var baseUrl = NormalizeApiBaseUrl(customApiBaseUrl);
        if (string.IsNullOrWhiteSpace(baseUrl)) return string.Empty;
        if (providerId == "firebase") return baseUrl;
        if (baseUrl.EndsWith("/chat/completions", StringComparison.OrdinalIgnoreCase)) return baseUrl;
        return baseUrl + "/chat/completions";
    }
}
