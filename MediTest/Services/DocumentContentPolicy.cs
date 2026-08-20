namespace MediTest.Services;

public static class DocumentContentPolicy
{
    public const string DocumentItemType = "document";
    public const string TestItemType = "test";

    // Ein hochgeladenes Dokument (PDF/PPTX/TXT mit echtem Quelltext) bleibt IMMER als "document"
    // klassifiziert, auch nachdem KI-Fragen generiert wurden - es soll in "Dokumente" sichtbar
    // bleiben und beliebig oft weitere Fragen generierbar sein (Entscheidung Lukas, 20.08.2026,
    // vorher wurde das Dokument bei questionCount > 0 zu "test" umklassifiziert und verschwand
    // dadurch faktisch aus der Dokumente-Ansicht). Nur reine Katalog-/Fragenpool-Importe ohne
    // eigenen Quelltext (contentType endet auf "question-pool"/"catalog-test") sind reine Tests.
    public static string ItemType(string? contentType, int questionCount)
    {
        return IsTest(contentType) ? TestItemType : DocumentItemType;
    }

    public static bool CanGenerateQuestions(string? contentType, int questionCount)
    {
        return !IsTest(contentType);
    }

    public static long DisplaySizeBytes(long storedFileSizeBytes, long fallbackTextBytes)
    {
        return storedFileSizeBytes > 0 ? storedFileSizeBytes : Math.Max(0, fallbackTextBytes);
    }

    private static bool IsTest(string? contentType)
    {
        var normalized = (contentType ?? string.Empty).Trim();
        return normalized.EndsWith("question-pool", StringComparison.OrdinalIgnoreCase) ||
               normalized.EndsWith("catalog-test", StringComparison.OrdinalIgnoreCase);
    }
}
