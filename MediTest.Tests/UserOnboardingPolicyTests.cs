using MediTest.Models;
using MediTest.Services;
using Xunit;

namespace MediTest.Tests;

public sealed class UserOnboardingPolicyTests
{
    private static readonly DateTime Now = new(2026, 6, 12, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void CompleteProfileRequiresCoreStudyData()
    {
        var settings = CompleteSettings();

        Assert.True(UserOnboardingPolicy.IsProfileComplete(settings));

        settings.University = string.Empty;
        Assert.False(UserOnboardingPolicy.IsProfileComplete(settings));
    }

    [Fact]
    public void MatriculationNumberIsOptional()
    {
        var settings = CompleteSettings();
        settings.MatriculationNumber = string.Empty;

        Assert.True(UserOnboardingPolicy.IsProfileComplete(settings));
    }

    [Fact]
    public void FeedbackIsRequestedAfterTrialEnds()
    {
        var license = PurchasedLicense(Now.AddMinutes(-1));

        Assert.True(UserOnboardingPolicy.ShouldRequestTrialFeedback(license, CompleteSettings(), Now));
    }

    [Fact]
    public void FeedbackIsNotRequestedDuringTrial()
    {
        var license = PurchasedLicense(Now.AddDays(1));

        Assert.False(UserOnboardingPolicy.ShouldRequestTrialFeedback(license, CompleteSettings(), Now));
    }

    [Fact]
    public void DeferredFeedbackWaitsUntilNextPrompt()
    {
        var settings = CompleteSettings();
        settings.TrialFeedbackNextPromptAt = Now.AddDays(1);

        Assert.False(UserOnboardingPolicy.ShouldRequestTrialFeedback(
            PurchasedLicense(Now.AddDays(-1)),
            settings,
            Now));
    }

    [Fact]
    public void SubmittedFeedbackIsNotRequestedAgain()
    {
        var settings = CompleteSettings();
        settings.TrialFeedbackSubmittedAt = Now.AddMinutes(-1);

        Assert.False(UserOnboardingPolicy.ShouldRequestTrialFeedback(
            PurchasedLicense(Now.AddDays(-1)),
            settings,
            Now));
    }

    private static ProgramSettings CompleteSettings() => new()
    {
        DisplayName = "Max Mustermann",
        StudyProgram = "Humanmedizin",
        University = "Medizinische Universität Wien",
        Semester = "6. Semester",
        Email = "max@example.test"
    };

    private static UserLicenseState PurchasedLicense(DateTime trialEndsAt) => new()
    {
        BaseProductPurchased = true,
        TrialStartedAt = trialEndsAt.AddDays(-7),
        TrialEndsAt = trialEndsAt
    };
}
