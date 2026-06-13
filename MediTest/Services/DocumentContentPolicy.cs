namespace MediTest.Services;

public static class DocumentContentPolicy
{
    public const string DocumentItemType = "document";
    public const string TestItemType = "test";

    public static string ItemType(string? contentType, int questionCount)
    {
        return IsTest(contentType, questionCount) ? TestItemType : DocumentItemType;
    }

    public static bool CanGenerateQuestions(string? contentType, int questionCount)
    {
        return !IsTest(contentType, questionCount);
    }

    public static long DisplaySizeBytes(long storedFileSizeBytes, long fallbackTextBytes)
    {
        return storedFileSizeBytes > 0 ? storedFileSizeBytes : Math.Max(0, fallbackTextBytes);
    }

    private static bool IsTest(string? contentType, int questionCount)
    {
        if (questionCount > 0) return true;

        var normalized = (contentType ?? string.Empty).Trim();
        return normalized.EndsWith("question-pool", StringComparison.OrdinalIgnoreCase) ||
               normalized.EndsWith("catalog-test", StringComparison.OrdinalIgnoreCase);
    }
}
