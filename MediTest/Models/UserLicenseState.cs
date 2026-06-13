namespace MediTest.Models;

public sealed class UserLicenseState
{
    public int ProductPriceCents { get; set; }
    public int MonthlyPriceCents { get; set; }
    public string Currency { get; set; } = string.Empty;
    public bool BaseProductPurchased { get; set; }
    public DateTime? BaseProductPurchasedAt { get; set; }
    public string BaseProductProvider { get; set; } = string.Empty;
    public string BaseProductCheckoutSessionId { get; set; } = string.Empty;
    public string BaseProductCodeHash { get; set; } = string.Empty;
    public DateTime? TrialStartedAt { get; set; }
    public DateTime? TrialEndsAt { get; set; }
    public bool SubscriptionActive { get; set; }
    public DateTime? SubscriptionRenewsAt { get; set; }
    public string SubscriptionProvider { get; set; } = string.Empty;
    public string SubscriptionCustomerId { get; set; } = string.Empty;
    public bool PremiumActive { get; set; }
    public DateTime? PremiumGrantedAt { get; set; }
    public string PremiumProvider { get; set; } = string.Empty;
    public string PremiumCodeHash { get; set; } = string.Empty;
    public bool FreeCatalogCreditActive { get; set; }
    public DateTime? FreeCatalogCreditGrantedAt { get; set; }
    public string FreeCatalogCreditCodeHash { get; set; } = string.Empty;
    public string FreeCatalogCreditRedeemedCatalogId { get; set; } = string.Empty;
    public DateTime? FreeCatalogCreditRedeemedAt { get; set; }
    public List<string> PurchasedCatalogTestIds { get; set; } = new();
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
