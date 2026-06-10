namespace MediTest.Services;

public static class RestrictedAccessPolicy
{
    public static bool Allows(string method, string path)
    {
        path = NormalizePath(path);
        var normalizedMethod = (method ?? string.Empty).Trim().ToUpperInvariant();

        if (Matches(path, "/api/catalog")) return true;
        if (Matches(path, "/api/stats")) return normalizedMethod == "GET";
        if (Matches(path, "/api/tests"))
        {
            if (normalizedMethod == "GET") return true;
            if (normalizedMethod == "POST")
                return path.Equals("/api/tests/start", StringComparison.OrdinalIgnoreCase) ||
                       MatchesTestAction(path, "submit");
            if (normalizedMethod == "PUT")
                return MatchesTestAction(path, "draft");
            return false;
        }

        if (normalizedMethod != "GET") return false;
        return Matches(path, "/api/documents") ||
               Matches(path, "/api/questions") ||
               path.Equals("/api/settings", StringComparison.OrdinalIgnoreCase);
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

    private static bool Matches(string path, string prefix) =>
        path.Equals(prefix, StringComparison.OrdinalIgnoreCase) ||
        path.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase);

    private static string NormalizePath(string? path)
    {
        path = (path ?? string.Empty).Trim();
        if (path.Length == 0) return "/";
        var queryIndex = path.IndexOf('?');
        if (queryIndex >= 0) path = path[..queryIndex];
        return path.StartsWith('/') ? path : "/" + path;
    }
}
