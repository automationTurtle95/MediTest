using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using MediTest.Models;
using Microsoft.Extensions.Caching.Memory;

namespace MediTest.Services;

public sealed class LicenseAccessService
{
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly IConfiguration _configuration;
    private readonly DeviceIdentityService _deviceIdentityService;
    private readonly InstallationAuthorizationService _installationAuthorizationService;
    private readonly LicenseCacheStore _cacheStore;
    private readonly ProductInfoService _productInfoService;
    private readonly IMemoryCache _memoryCache;

    public LicenseAccessService(
        IHttpClientFactory httpClientFactory,
        IHttpContextAccessor httpContextAccessor,
        IConfiguration configuration,
        DeviceIdentityService deviceIdentityService,
        InstallationAuthorizationService installationAuthorizationService,
        LicenseCacheStore cacheStore,
        ProductInfoService productInfoService,
        IMemoryCache memoryCache)
    {
        _httpClientFactory = httpClientFactory;
        _httpContextAccessor = httpContextAccessor;
        _configuration = configuration;
        _deviceIdentityService = deviceIdentityService;
        _installationAuthorizationService = installationAuthorizationService;
        _cacheStore = cacheStore;
        _productInfoService = productInfoService;
        _memoryCache = memoryCache;
    }

    public async Task<LicenseAccessSnapshot> CheckAsync(CancellationToken ct, bool force = false)
    {
        var identity = await _deviceIdentityService.GetAsync(ct);
        var cacheKey = MemoryCacheKey(identity.DeviceId);
        if (!force && _memoryCache.TryGetValue(cacheKey, out LicenseAccessSnapshot? cached) && cached != null)
            return cached;

        try
        {
            var snapshot = await SendAsync("check", identity, null, ct);
            var checkedAt = DateTime.UtcNow;
            snapshot.Online = true;
            snapshot.IsOfflineMode = false;
            snapshot.LastSuccessfulOnlineCheck = checkedAt;
            await _cacheStore.SaveAsync(new LicenseCacheEntry
            {
                LastSuccessfulOnlineCheck = checkedAt,
                Snapshot = snapshot
            }, ct);
            _memoryCache.Set(cacheKey, snapshot, TimeSpan.FromMinutes(2));
            return snapshot;
        }
        catch (Exception ex) when (IsConnectivityFailure(ex))
        {
            return await OfflineSnapshotAsync(identity, ct);
        }
    }

    public async Task<LicenseAccessSnapshot> ActivateDeviceAsync(CancellationToken ct)
    {
        var identity = await _deviceIdentityService.GetAsync(ct);
        var snapshot = await SendAsync("activateDevice", identity, null, ct);
        _memoryCache.Remove(MemoryCacheKey(identity.DeviceId));
        return snapshot;
    }

    public async Task<LicenseAccessSnapshot> AcceptTermsAsync(AcceptTermsRequest request, CancellationToken ct)
    {
        if (!request.AcceptTerms || !request.AcceptPrivacy)
            throw new InvalidOperationException("AGB und Datenschutzerklärung müssen beide akzeptiert werden.");

        var identity = await _deviceIdentityService.GetAsync(ct);
        var snapshot = await SendAsync("acceptTerms", identity, new
        {
            acceptTerms = request.AcceptTerms,
            acceptPrivacy = request.AcceptPrivacy
        }, ct);
        _memoryCache.Remove(MemoryCacheKey(identity.DeviceId));
        return snapshot;
    }

    private async Task<LicenseAccessSnapshot> SendAsync(
        string action,
        DeviceIdentity identity,
        object? extra,
        CancellationToken ct)
    {
        var token = BearerToken();
        if (string.IsNullOrWhiteSpace(token))
            throw new UnauthorizedAccessException("Kein eingeloggter Firebase-Nutzer.");

        var product = _productInfoService.GetLegalInfo();
        var installationAuthorization = await _installationAuthorizationService.FindAsync(identity.Platform, ct);
        var body = new Dictionary<string, object?>
        {
            ["action"] = action,
            ["deviceId"] = identity.DeviceId,
            ["deviceName"] = identity.DeviceName,
            ["platform"] = identity.Platform,
            ["installationToken"] = installationAuthorization?.Token ?? string.Empty,
            ["appVersion"] = product.ProductVersion
        };
        if (extra != null)
        {
            foreach (var property in JsonSerializer.SerializeToElement(extra).EnumerateObject())
                body[property.Name] = property.Value;
        }

        using var request = new HttpRequestMessage(HttpMethod.Post, FunctionUrl());
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        request.Content = new StringContent(JsonSerializer.Serialize(body), Encoding.UTF8, "application/json");
        using var response = await _httpClientFactory.CreateClient().SendAsync(request, ct);
        var raw = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
        {
            var message = ErrorMessage(raw, "Die Lizenzprüfung konnte nicht abgeschlossen werden.");
            if ((int)response.StatusCode >= 500)
                throw new HttpRequestException(message, null, response.StatusCode);
            throw new InvalidOperationException(message);
        }

        var snapshot = JsonSerializer.Deserialize<LicenseAccessSnapshot>(raw, JsonOptions);
        if (snapshot == null)
            throw new JsonException("Der Lizenzdienst hat ungültige Daten geliefert.");
        if (installationAuthorization != null &&
            string.Equals(snapshot.Device?.DeviceId, identity.DeviceId, StringComparison.Ordinal))
        {
            _installationAuthorizationService.Delete(installationAuthorization);
        }
        return snapshot;
    }

    private async Task<LicenseAccessSnapshot> OfflineSnapshotAsync(DeviceIdentity identity, CancellationToken ct)
    {
        var cache = await _cacheStore.ReadAsync(ct);
        var userId = _httpContextAccessor.HttpContext?.User.FindFirst("user_id")?.Value ??
            _httpContextAccessor.HttpContext?.User.FindFirst("sub")?.Value ?? string.Empty;
        var result = LicensePolicy.EvaluateOffline(cache, userId, identity.DeviceId, DateTime.UtcNow);
        if (cache == null)
        {
            return new LicenseAccessSnapshot
            {
                AppConfig = _productInfoService.GetAppConfig(),
                Result = result,
                Online = false,
                IsOfflineMode = true
            };
        }

        var snapshot = cache.Snapshot;
        snapshot.Result = result;
        snapshot.Online = false;
        snapshot.IsOfflineMode = true;
        snapshot.LastSuccessfulOnlineCheck = cache.LastSuccessfulOnlineCheck;
        return snapshot;
    }

    private string FunctionUrl()
    {
        var configured = (_configuration["Licensing:AccessFunctionUrl"] ?? string.Empty).Trim();
        if (!string.IsNullOrWhiteSpace(configured)) return configured;
        var projectId = (_configuration["Auth:Firebase:ProjectId"] ?? string.Empty).Trim();
        return $"https://europe-west3-{projectId}.cloudfunctions.net/meditestLicenseAccess";
    }

    private string MemoryCacheKey(string deviceId)
    {
        var userId = _httpContextAccessor.HttpContext?.User.FindFirst("user_id")?.Value ??
            _httpContextAccessor.HttpContext?.User.FindFirst("sub")?.Value ?? string.Empty;
        return $"license-access:{userId}:{deviceId}";
    }

    private string BearerToken()
    {
        var authorization = _httpContextAccessor.HttpContext?.Request.Headers.Authorization.ToString() ?? string.Empty;
        const string prefix = "Bearer ";
        return authorization.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)
            ? authorization[prefix.Length..].Trim()
            : string.Empty;
    }

    private static bool IsConnectivityFailure(Exception ex) =>
        ex is HttpRequestException or TaskCanceledException ||
        ex is JsonException ||
        ex.InnerException is HttpRequestException;

    private static string ErrorMessage(string raw, string fallback)
    {
        try
        {
            using var json = JsonDocument.Parse(raw);
            if (json.RootElement.TryGetProperty("error", out var error))
            {
                if (error.ValueKind == JsonValueKind.String) return error.GetString() ?? fallback;
                if (error.TryGetProperty("message", out var message)) return message.GetString() ?? fallback;
            }
        }
        catch (JsonException)
        {
        }
        return string.IsNullOrWhiteSpace(raw) ? fallback : raw;
    }
}
