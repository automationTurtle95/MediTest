using MediTest.Models;

namespace MediTest.Services;

public static class UserOnboardingPolicy
{
    public static bool IsProfileComplete(ProgramSettings settings)
    {
        return HasValue(settings.DisplayName) &&
               HasValue(settings.StudyProgram) &&
               HasValue(settings.University) &&
               HasValue(settings.Semester) &&
               HasValue(settings.Email);
    }

    public static bool ShouldRequestTrialFeedback(
        UserLicenseState license,
        ProgramSettings settings,
        DateTime now)
    {
        if (!license.BaseProductPurchased ||
            license.TrialEndsAt is not { } trialEnd ||
            trialEnd > now ||
            settings.TrialFeedbackSubmittedAt != null)
        {
            return false;
        }

        return settings.TrialFeedbackNextPromptAt is not { } nextPrompt || nextPrompt <= now;
    }

    private static bool HasValue(string? value) => !string.IsNullOrWhiteSpace(value);
}
