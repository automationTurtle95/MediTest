namespace MediTest.Dtos;

public sealed record DocumentDto(int Id, string FileName, string ContentType, DateTime CreatedAt, int QuestionCount, int TextLength);
public sealed record GenerateQuestionsRequest(int Count);

public sealed record CatalogListDto(
    bool CanPublish,
    bool FreeCatalogCreditAvailable,
    bool FreeCatalogCreditRedeemed,
    string FreeCatalogCreditRedeemedCatalogId,
    List<CatalogTestDto> Tests);

public sealed record CatalogTestDto(
    string Id,
    string Title,
    string Description,
    string Topic,
    string Difficulty,
    int QuestionCount,
    string Version,
    DateTime? PublishedAt,
    int PriceCents = 199,
    string Currency = "EUR",
    bool Purchased = false,
    bool RequiresPurchase = false);

public sealed record CatalogDownloadRequest(string? DocumentName);

public sealed record CatalogDownloadResult(int DocumentId, string DocumentName, int ImportedQuestions);

public sealed record CatalogPublishRequest(
    int DocumentId,
    string? Title,
    string? Description,
    string? Topic,
    string? Difficulty);

public sealed record CatalogPublishResult(string Id, string Title, int QuestionCount);

public sealed record QuestionListItemDto(
    int QuestionId,
    string QuestionText,
    string Topic,
    string Difficulty,
    bool IsAiGenerated,
    string Explanation,
    int CorrectOptionIndex,
    List<QuestionOptionListItemDto> Options,
    string? ImageDataUrl = null,
    string? ImageAltText = null,
    string? ImageFileName = null);
public sealed record QuestionOptionListItemDto(int AnswerOptionId, int OptionIndex, string Text, bool IsCorrect);
public sealed record UpdateQuestionRequest(
    string QuestionText,
    List<string> Options,
    int CorrectOptionIndex,
    string Explanation,
    string Topic,
    string Difficulty,
    string? ImageDataUrl = null,
    string? ImageAltText = null,
    string? ImageFileName = null,
    bool ClearImage = false);
public sealed record StartTestRequest(int DocumentId, int QuestionCount = 25, string? TestName = null);
public sealed record RenameTestRequest(string? TestName);
public sealed record SubmitTestRequest(List<SubmitAnswerDto> Answers);
public sealed record SubmitAnswerDto(int QuestionId, int? SelectedAnswerOptionId);

public sealed record TestQuestionDto(
    int QuestionId,
    string QuestionText,
    string Topic,
    string Difficulty,
    bool IsAiGenerated,
    List<TestOptionDto> Options,
    int? SelectedAnswerOptionId = null,
    string? ImageDataUrl = null,
    string? ImageAltText = null,
    string? ImageFileName = null);

public sealed record TestOptionDto(int AnswerOptionId, string Text);

public sealed record TestSessionDto(int TestSessionId, int DocumentId, int QuestionCount, List<TestQuestionDto> Questions);

public sealed record ReviewDto(
    int TestSessionId,
    int Score,
    int QuestionCount,
    double Percent,
    bool Passed,
    List<ReviewQuestionDto> Questions,
    List<TopicErrorDto> TopicErrors);

public sealed record ReviewQuestionDto(
    int QuestionId,
    string QuestionText,
    string Topic,
    string Difficulty,
    bool IsAiGenerated,
    string? SelectedAnswer,
    string CorrectAnswer,
    bool IsCorrect,
    string Explanation,
    List<string> Options,
    string? ImageDataUrl = null,
    string? ImageAltText = null,
    string? ImageFileName = null);

public sealed record TopicErrorDto(string Topic, int Errors, int Total);

public sealed record TestHistoryItemDto(
    int TestSessionId,
    string TestName,
    int DocumentId,
    string DocumentName,
    DateTime StartedAt,
    DateTime? SubmittedAt,
    int QuestionCount,
    int Score,
    double Percent,
    bool Passed);

public sealed record OverallStatsDto(
    int TotalTests,
    int CompletedTests,
    int OpenTests,
    int PassedTests,
    int FailedTests,
    double PassRate,
    double AveragePercent,
    int TotalAnsweredQuestions,
    int TotalCorrectAnswers,
    double AnswerAccuracy,
    double ReadinessPercent,
    string ReadinessLabel,
    int? ScopeTestSessionId,
    string? ScopeTestName,
    List<TopicErrorDto> WorstTopics,
    List<TopicPerformanceDto> TopicPerformance,
    List<DifficultyPerformanceDto> DifficultyPerformance,
    List<TestProgressPointDto> Progress,
    List<QuestionWeakSpotDto> WeakQuestions,
    List<LearningRecommendationDto> LearningRecommendations);

public sealed record TopicPerformanceDto(
    string Topic,
    int Attempts,
    int Correct,
    int Errors,
    double Percent,
    int QuestionCount,
    int DocumentCount);

public sealed record DifficultyPerformanceDto(
    string Difficulty,
    int Attempts,
    int Correct,
    int Errors,
    double Percent);

public sealed record TestProgressPointDto(
    int TestSessionId,
    string TestName,
    DateTime SubmittedAt,
    int Score,
    int QuestionCount,
    double Percent,
    bool Passed);

public sealed record QuestionWeakSpotDto(
    int QuestionId,
    int DocumentId,
    string DocumentName,
    string Topic,
    string Difficulty,
    string QuestionText,
    int Attempts,
    int Errors,
    double ErrorRate,
    DateTime? LastAnsweredAt);

public sealed record LearningRecommendationDto(
    string Title,
    string Description,
    string Topic,
    int QuestionCount,
    int Attempts,
    int Errors,
    double ErrorRate,
    string Href);

public sealed record TopicQuestionListDto(
    string Topic,
    int QuestionCount,
    List<TopicQuestionItemDto> Questions);

public sealed record TopicQuestionItemDto(
    int QuestionId,
    int DocumentId,
    string DocumentName,
    string QuestionText,
    string Topic,
    string Difficulty,
    bool IsAiGenerated,
    string Explanation,
    int CorrectOptionIndex,
    List<QuestionOptionListItemDto> Options,
    string? ImageDataUrl = null,
    string? ImageAltText = null,
    string? ImageFileName = null);

public sealed record CreateManualQuestionRequest(
    int? DocumentId,
    string? DocumentName,
    string QuestionText,
    List<string> Options,
    int CorrectOptionIndex,
    string Explanation,
    string Topic,
    string Difficulty,
    string? ImageDataUrl = null,
    string? ImageAltText = null,
    string? ImageFileName = null);

public sealed record LicenseStatusDto(
    string Plan,
    string Status,
    bool AccessActive,
    bool PremiumActive,
    DateTime TrialStartedAt,
    DateTime TrialEndsAt,
    int TrialDaysRemaining,
    int MonthlyPriceCents,
    int CatalogTestPriceCents,
    int CatalogQuestionPriceCents,
    int CatalogPriceEndingCents,
    int CatalogPriceExampleQuestionCount,
    string Currency,
    bool CheckoutConfigured,
    bool FreeCatalogCreditAvailable,
    bool FreeCatalogCreditRedeemed,
    string FreeCatalogCreditRedeemedCatalogId,
    DateTime? FreeCatalogCreditGrantedAt,
    DateTime? FreeCatalogCreditRedeemedAt,
    string Message);

public sealed record RedeemPremiumCodeRequest(string? Code);
public sealed record RedeemCatalogCodeRequest(string? Code);

public sealed record CheckoutLinkDto(bool Available, string? Url, string Message);

public sealed record UpdateDownloadDto(
    string Platform,
    string Url,
    string FileName,
    string Sha256,
    long SizeBytes);

public sealed record UpdateCheckDto(
    bool Configured,
    string CurrentVersion,
    string CurrentPlatform,
    string? LatestVersion,
    bool UpdateAvailable,
    string? ReleaseDate,
    string? Notes,
    string? ReleaseUrl,
    UpdateDownloadDto? RecommendedDownload,
    List<UpdateDownloadDto> Downloads,
    string Message);

public sealed record AiModelOptionDto(string Value, string Label);
public sealed record AiProviderOptionDto(string Id, string Label, bool UsesCustomBaseUrl, List<AiModelOptionDto> Models);

public sealed record ProgramSettingsDto(
    string DisplayName,
    string MatriculationNumber,
    string StudyProgram,
    string University,
    string Semester,
    string Email,
    string Theme,
    int DefaultGenerateQuestionCount,
    int DefaultTestQuestionCount,
    bool OpenAiApiKeyConfigured,
    string OpenAiApiKeyPreview,
    string OpenAiModel,
    string AiProvider,
    string AiModel,
    string AiApiBaseUrl,
    List<AiProviderOptionDto> AiProviders,
    bool AllowLocalFallback,
    DateTime UpdatedAt);

public sealed record UpdateProgramSettingsRequest(
    string? DisplayName,
    string? MatriculationNumber,
    string? StudyProgram,
    string? University,
    string? Semester,
    string? Email,
    string? Theme,
    int DefaultGenerateQuestionCount,
    int DefaultTestQuestionCount,
    string? OpenAiApiKey,
    bool ClearOpenAiApiKey,
    string? OpenAiModel,
    string? AiProvider,
    string? AiModel,
    string? AiApiBaseUrl,
    bool AllowLocalFallback);

public sealed record AuthConfigDto(
    string Mode,
    bool CloudConfigured,
    bool RegistrationEnabled,
    string SessionPersistence,
    FirebaseConfigDto? Firebase);

public sealed record FirebaseConfigDto(
    string ApiKey,
    string AuthDomain,
    string ProjectId,
    string StorageBucket,
    string MessagingSenderId,
    string AppId,
    string MeasurementId);

public sealed record RegisterRequest(
    string? Email,
    string? Password,
    string? DisplayName);

public sealed record LoginRequest(
    string? Email,
    string? Password);

public sealed record AuthUserDto(
    string UserId,
    string Email,
    string DisplayName,
    string Plan,
    string LicenseStatus,
    string AuthMode,
    DateTime ExpiresAt);

public sealed record AuthResponse(AuthUserDto User);
