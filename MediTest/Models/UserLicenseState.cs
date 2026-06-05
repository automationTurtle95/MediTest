namespace MediTest.Models;

public sealed class UserLicenseState
{
    public DateTime TrialStartedAt { get; set; } = DateTime.UtcNow;
    public DateTime TrialEndsAt { get; set; } = DateTime.UtcNow.AddDays(7);
    public bool SubscriptionActive { get; set; }
    public DateTime? SubscriptionRenewsAt { get; set; }
    public string SubscriptionProvider { get; set; } = string.Empty;
    public string SubscriptionCustomerId { get; set; } = string.Empty;
    public bool PremiumActive { get; set; }
    public DateTime? PremiumGrantedAt { get; set; }
    public string PremiumProvider { get; set; } = string.Empty;
    public string PremiumCodeHash { get; set; } = string.Empty;
    public List<string> PurchasedCatalogTestIds { get; set; } = new();
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
