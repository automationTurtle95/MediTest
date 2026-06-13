namespace MediTest.Services;

public static class RestrictedAccessPolicy
{
    public static bool Allows(string method, string path)
    {
        path = NormalizePath(path);
        var normalizedMethod = (method ?? string.Empty).Trim().ToUpperInvariant();

        if (normalizedMethod == "GET")
            return path.Equals("/api/settings", StringComparison.OrdinalIgnoreCase) ||
                   path.Equals("/api/tests", StringComparison.OrdinalIgnoreCase) ||
                   path.Equals("/api/tests/sources", StringComparison.OrdinalIgnoreCase) ||
                   MatchesTestAction(path, "resume") ||
                   MatchesTestAction(path, "review");

        if (normalizedMethod == "POST")
            return path.Equals("/api/tests/start", StringComparison.OrdinalIgnoreCase) ||
                   MatchesTestAction(path, "submit");

        return normalizedMethod == "PUT" && MatchesTestAction(path, "draft");
    }

    private static bool MatchesTestAction(string path, string action)
    {
        var segments = path.Split('/', StringSplitOptions.RemoveEmptyEntries);
        return segments.Length == 4 &&
               segments[0].Equals("api", StringComparison.OrdinalIgnoreCase) &&
               segments[1].Equals("tests", StringComparison.OrdinalIgnoreCase) &&
               int.TryParse(segments[2], out _) &&
               segments[3].Equals(action, StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizePath(string? path)
    {
        path = (path ?? string.Empty).Trim();
        if (path.Length == 0) return "/";
        var queryIndex = path.IndexOf('?');
        if (queryIndex >= 0) path = path[..queryIndex];
        return path.StartsWith('/') ? path : "/" + path;
    }
}
