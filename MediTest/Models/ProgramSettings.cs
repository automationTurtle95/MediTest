namespace MediTest.Models;

public sealed class ProgramSettings
{
    public int Id { get; set; } = 1;
    public string DisplayName { get; set; } = string.Empty;
    public string MatriculationNumber { get; set; } = string.Empty;
    public string StudyProgram { get; set; } = string.Empty;
    public string University { get; set; } = string.Empty;
    public string Semester { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
    public string Theme { get; set; } = "system";
    public int DefaultGenerateQuestionCount { get; set; } = 25;
    public int DefaultTestQuestionCount { get; set; } = 25;
    public string OpenAiApiKey { get; set; } = string.Empty;
    public string OpenAiModel { get; set; } = "gemini-2.5-flash";
    public string AiProvider { get; set; } = "firebase";
    public string AiApiBaseUrl { get; set; } = "https://europe-west3-meditest-12354.cloudfunctions.net/meditestAi";
    public bool AllowLocalFallback { get; set; }
    public DateTime? ProfileCompletedAt { get; set; }
    public DateTime? TrialFeedbackPromptedAt { get; set; }
    public DateTime? TrialFeedbackNextPromptAt { get; set; }
    public DateTime? TrialFeedbackSubmittedAt { get; set; }
    public int? TrialFeedbackRating { get; set; }
    public string TrialFeedbackComment { get; set; } = string.Empty;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
