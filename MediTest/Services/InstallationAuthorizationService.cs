using System.Text.Json;
using System.Text.RegularExpressions;

namespace MediTest.Services;

public sealed record InstallationAuthorization(
    string Token,
    string Platform,
    DateTimeOffset ExpiresAt,
    string FilePath);

public sealed class InstallationAuthorizationService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private static readonly Regex TokenPattern = new("^[A-Za-z0-9_-]{40,160}$", RegexOptions.Compiled);
    private readonly IReadOnlyList<string>? _searchDirectories;
    private readonly TimeProvider _timeProvider;

    public InstallationAuthorizationService()
        : this(null, TimeProvider.System)
    {
    }

    internal InstallationAuthorizationService(
        IEnumerable<string>? searchDirectories,
        TimeProvider timeProvider)
    {
        _searchDirectories = searchDirectories?.ToArray();
        _timeProvider = timeProvider;
    }

    public async Task<InstallationAuthorization?> FindAsync(string platform, CancellationToken ct = default)
    {
        foreach (var path in CandidateFiles())
        {
            try
            {
                var json = await File.ReadAllTextAsync(path, ct);
                var file = JsonSerializer.Deserialize<InstallationAuthorizationFile>(json, JsonOptions);
                if (file == null ||
                    file.SchemaVersion != 1 ||
                    !TokenPattern.IsMatch(file.Token) ||
                    file.ExpiresAt <= _timeProvider.GetUtcNow() ||
                    !string.Equals(file.Platform, platform, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                return new InstallationAuthorization(file.Token, file.Platform, file.ExpiresAt, path);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
            {
                // Ignore unrelated or damaged files and continue with the next candidate.
            }
        }

        return null;
    }

    public void Delete(InstallationAuthorization authorization)
    {
        try
        {
            if (File.Exists(authorization.FilePath))
                File.Delete(authorization.FilePath);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The server-side token is already consumed, so a local cleanup failure is harmless.
        }
    }

    private IEnumerable<string> CandidateFiles()
    {
        var userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var directories = _searchDirectories ?? new[]
        {
            Path.Combine(userProfile, "Downloads"),
            Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory),
            AppContext.BaseDirectory
        }
        .Where(path => !string.IsNullOrWhiteSpace(path) && Directory.Exists(path))
        .Distinct(StringComparer.OrdinalIgnoreCase);

        foreach (var directory in directories)
        {
            IEnumerable<string> files;
            try
            {
                files = Directory.EnumerateFiles(
                        directory,
                        "Meduvalo-Installationsberechtigung*.json",
                        SearchOption.TopDirectoryOnly)
                    .OrderByDescending(File.GetLastWriteTimeUtc)
                    .ToArray();
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                continue;
            }

            foreach (var file in files)
                yield return file;
        }
    }

    private sealed class InstallationAuthorizationFile
    {
        public int SchemaVersion { get; set; }
        public string Token { get; set; } = string.Empty;
        public string Platform { get; set; } = string.Empty;
        public DateTimeOffset ExpiresAt { get; set; }
    }
}
