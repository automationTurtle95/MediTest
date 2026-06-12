using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediTest.Dtos;
using MediTest.Models;

namespace MediTest.Services;

public sealed class FirestoreUserDataStore
{
    private const int TextChunkChars = 200_000;
    private const int BulkWriteConcurrency = 8;
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly IHttpContextAccessor _httpContextAccessor;
    private readonly IConfiguration _configuration;

    public FirestoreUserDataStore(IHttpClientFactory httpClientFactory, IHttpContextAccessor httpContextAccessor, IConfiguration configuration)
    {
        _httpClientFactory = httpClientFactory;
        _httpContextAccessor = httpContextAccessor;
        _configuration = configuration;
    }

    public async Task<ProgramSettings> GetSettingsAsync(CancellationToken ct)
    {
        var json = await GetDocAsync($"{UserRoot()}/settings/profile", ct);
        if (json == null)
        {
            var defaults = DefaultSettings();
            await SaveSettingsAsync(defaults, ct);
            return defaults;
        }

        var settings = JsonSerializer.Deserialize<ProgramSettings>(FirestoreString(json.Value, "dataJson"), JsonOptions) ?? DefaultSettings();
        ApplyFixedAiSettings(settings);
        return settings;
    }

    public async Task SaveSettingsAsync(ProgramSettings settings, CancellationToken ct)
    {
        settings.Id = 1;
        ApplyFixedAiSettings(settings);
        settings.UpdatedAt = DateTime.UtcNow;
        await SetJsonDocAsync($"{UserRoot()}/settings/profile", settings, ct);
    }

    public async Task<UserLicenseState> GetLicenseStateAsync(int trialDays, CancellationToken ct)
    {
        _ = trialDays;
        var configuredUrl = (_configuration["Billing:LicenseStatusFunctionUrl"] ?? string.Empty).Trim();
        var functionUrl = string.IsNullOrWhiteSpace(configuredUrl)
            ? $"https://europe-west3-{ProjectId()}.cloudfunctions.net/meditestLicenseStatus"
            : configuredUrl;
        using var request = new HttpRequestMessage(HttpMethod.Get, functionUrl);
        request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {BearerToken()}");
        using var response = await _httpClientFactory.CreateClient().SendAsync(request, ct);
        var raw = await response.Content.ReadAsStringAsync(ct);
        if (!response.IsSuccessStatusCode)
            throw new InvalidOperationException(FunctionError(raw, "Der Lizenzstatus konnte nicht geladen werden."));

        using var json = JsonDocument.Parse(raw);
        if (!json.RootElement.TryGetProperty("state", out var stateElement))
            throw new InvalidOperationException("Der Lizenzdienst hat keinen gültigen Status geliefert.");
        var state = stateElement.Deserialize<UserLicenseState>(JsonOptions) ?? new UserLicenseState();
        state.BaseProductProvider ??= string.Empty;
        state.BaseProductCheckoutSessionId ??= string.Empty;
        state.BaseProductCodeHash ??= string.Empty;
        state.SubscriptionProvider ??= string.Empty;
        state.SubscriptionCustomerId ??= string.Empty;
        state.PremiumProvider ??= string.Empty;
        state.PremiumCodeHash ??= string.Empty;
        state.FreeCatalogCreditCodeHash ??= string.Empty;
        state.FreeCatalogCreditRedeemedCatalogId ??= string.Empty;
        state.PurchasedCatalogTestIds ??= [];
        return state;
    }

    public async Task SaveLicenseStateAsync(UserLicenseState state, CancellationToken ct)
    {
        state.UpdatedAt = DateTime.UtcNow;
        state.BaseProductProvider ??= string.Empty;
        state.BaseProductCheckoutSessionId ??= string.Empty;
        state.BaseProductCodeHash ??= string.Empty;
        state.SubscriptionProvider ??= string.Empty;
        state.SubscriptionCustomerId ??= string.Empty;
        state.PremiumProvider ??= string.Empty;
        state.PremiumCodeHash ??= string.Empty;
        state.FreeCatalogCreditCodeHash ??= string.Empty;
        state.FreeCatalogCreditRedeemedCatalogId ??= string.Empty;
        state.PurchasedCatalogTestIds ??= [];
        state.PurchasedCatalogTestIds = state.PurchasedCatalogTestIds
            .Where(id => !string.IsNullOrWhiteSpace(id))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(id => id, StringComparer.OrdinalIgnoreCase)
            .ToList();
        await SetJsonDocAsync($"{UserRoot()}/billing/license", state, ct);
    }

    public async Task<bool> HasCatalogPurchaseAsync(string catalogId, int trialDays, CancellationToken ct)
    {
        var state = await GetLicenseStateAsync(trialDays, ct);
        return state.PurchasedCatalogTestIds.Contains(catalogId, StringComparer.OrdinalIgnoreCase);
    }

    public async Task<List<DocumentDto>> ListDocumentsAsync(CancellationToken ct, bool seedDemo = true)
    {
        var docs = await ListDocumentMetasAsync(ct);
        if (docs.Count == 0 && seedDemo && !await DemoWasSeededAsync(ct))
        {
            await SeedDemoAsync(ct);
            docs = await ListDocumentMetasAsync(ct);
        }

        return docs
            .OrderByDescending(d => d.CreatedAt)
            .Select(d => new DocumentDto(d.Id, d.FileName, d.FolderPath, d.ContentType, d.CreatedAt, d.QuestionCount, d.TextLength))
            .ToList();
    }

    public async Task<UploadedDocument?> UpdateDocumentFolderAsync(int id, string folderPath, CancellationToken ct)
    {
        var fields = await GetDocAsync($"{UserRoot()}/documents/{id}", ct);
        if (fields == null) return null;

        var doc = DeserializeDoc(fields.Value);
        doc.FolderPath = folderPath;
        var textLength = FirestoreInt(fields.Value, "textLength");
        var questionCount = FirestoreInt(fields.Value, "questionCount");
        await SetJsonDocAsync($"{UserRoot()}/documents/{id}", ToDocMeta(doc, textLength, questionCount), ct, extraFields: new()
        {
            ["textLength"] = FsInt(textLength),
            ["questionCount"] = FsInt(questionCount)
        });
        return doc;
    }

    public async Task<UploadedDocument?> GetDocumentAsync(int id, CancellationToken ct, bool includeQuestions = false, bool includeText = true)
    {
        var fields = await GetDocAsync($"{UserRoot()}/documents/{id}", ct);
        if (fields == null) return null;

        var doc = DeserializeDoc(fields.Value);
        doc.ExtractedText = includeText ? await LoadTextAsync(id, ct) : string.Empty;
        if (includeQuestions) doc.Questions = await GetDocumentQuestionsAsync(id, ct);
        return doc;
    }

    public async Task<UploadedDocument> SaveDocumentAsync(UploadedDocument doc, CancellationToken ct)
    {
        if (doc.Id <= 0) doc.Id = NewId();
        doc.CreatedAt = doc.CreatedAt == default ? DateTime.UtcNow : doc.CreatedAt;

        var meta = ToDocMeta(doc, doc.ExtractedText.Length, doc.Questions.Count);
        await SetJsonDocAsync($"{UserRoot()}/documents/{doc.Id}", meta, ct, extraFields: new()
        {
            ["textLength"] = FsInt(doc.ExtractedText.Length),
            ["questionCount"] = FsInt(doc.Questions.Count)
        });
        await SaveTextAsync(doc.Id, doc.ExtractedText, ct);
        return doc;
    }

    public async Task DeleteDocumentAsync(int id, CancellationToken ct)
    {
        foreach (var q in await ListDocElementsAsync($"{UserRoot()}/documents/{id}/questions", ct))
            await DeleteDocAsync($"{UserRoot()}/documents/{id}/questions/{FirestoreDocumentId(q)}", ct);

        foreach (var c in await ListDocElementsAsync($"{UserRoot()}/documents/{id}/textChunks", ct))
            await DeleteDocAsync($"{UserRoot()}/documents/{id}/textChunks/{FirestoreDocumentId(c)}", ct);

        var tests = await ListTestsInternalAsync(ct);
        foreach (var test in tests.Where(t => t.UploadedDocumentId == id))
            await DeleteDocAsync($"{UserRoot()}/testSessions/{test.Id}", ct);

        await DeleteDocAsync($"{UserRoot()}/documents/{id}", ct);
    }

    public async Task<List<Question>> GetDocumentQuestionsAsync(int documentId, CancellationToken ct)
    {
        var rows = await ListDocElementsAsync($"{UserRoot()}/documents/{documentId}/questions", ct);
        return rows.Select(DeserializeQuestion)
            .OrderBy(q => q.Id)
            .ToList();
    }

    public async Task<Question?> GetQuestionAsync(int questionId, CancellationToken ct)
    {
        foreach (var doc in await ListDocumentMetasAsync(ct))
        {
            var fields = await GetDocAsync($"{UserRoot()}/documents/{doc.Id}/questions/{questionId}", ct);
            if (fields != null) return DeserializeQuestion(fields.Value);
        }
        return null;
    }

    public async Task<List<Question>> GetQuestionsByTopicAsync(string topic, CancellationToken ct)
    {
        var result = new List<Question>();
        foreach (var doc in await ListDocumentMetasAsync(ct))
        {
            var questions = await GetDocumentQuestionsAsync(doc.Id, ct);
            foreach (var q in questions)
            {
                q.Document = new UploadedDocument { Id = doc.Id, FileName = doc.FileName };
                if (string.Equals(topic, "Allgemein", StringComparison.OrdinalIgnoreCase))
                {
                    if (string.IsNullOrWhiteSpace(q.Topic) || q.Topic == "Allgemein") result.Add(q);
                }
                else if (q.Topic == topic)
                {
                    result.Add(q);
                }
            }
        }
        return result.OrderBy(q => q.Document?.FileName).ThenBy(q => q.Id).ToList();
    }

    public async Task<Question> UpdateQuestionAsync(int questionId, UpdateQuestionRequest req, CancellationToken ct)
    {
        foreach (var doc in await ListDocumentMetasAsync(ct))
        {
            var fields = await GetDocAsync($"{UserRoot()}/documents/{doc.Id}/questions/{questionId}", ct);
            if (fields == null) continue;

            var question = DeserializeQuestion(fields.Value);
            question.UploadedDocumentId = doc.Id;
            question.QuestionText = req.QuestionText.Trim();
            question.CorrectOptionIndex = req.CorrectOptionIndex;
            question.Explanation = string.IsNullOrWhiteSpace(req.Explanation) ? "Keine Erklärung hinterlegt." : req.Explanation.Trim();
            question.Topic = string.IsNullOrWhiteSpace(req.Topic) ? "Allgemein" : req.Topic.Trim();
            question.Difficulty = DifficultyLabel(req.Difficulty);
            if (req.ClearImage)
            {
                question.ImageDataUrl = string.Empty;
                question.ImageAltText = string.Empty;
                question.ImageFileName = string.Empty;
            }
            else if (!string.IsNullOrWhiteSpace(req.ImageDataUrl))
            {
                question.ImageDataUrl = req.ImageDataUrl.Trim();
                question.ImageAltText = (req.ImageAltText ?? string.Empty).Trim();
                question.ImageFileName = (req.ImageFileName ?? string.Empty).Trim();
            }
            else if (req.ImageAltText != null)
            {
                question.ImageAltText = req.ImageAltText.Trim();
            }
            var existingOptions = question.Options.OrderBy(o => o.OptionIndex).Take(5).ToList();
            for (var i = 0; i < existingOptions.Count; i++)
            {
                existingOptions[i].Text = req.Options[i].Trim();
                existingOptions[i].OptionIndex = i;
                existingOptions[i].QuestionId = question.Id;
                existingOptions[i].Question = null;
            }

            if (existingOptions.Count < 5)
            {
                for (var i = existingOptions.Count; i < 5; i++)
                    existingOptions.Add(new AnswerOption { Id = NewId(), QuestionId = question.Id, OptionIndex = i, Text = req.Options[i].Trim() });
            }

            question.Options = existingOptions;
            await SaveQuestionAsync(doc.Id, question, ct);
            return question;
        }

        throw new KeyNotFoundException("Frage nicht gefunden.");
    }

    public async Task<Question> SaveQuestionAsync(int documentId, Question question, CancellationToken ct)
    {
        PrepareQuestion(documentId, question);
        await SetJsonDocAsync($"{UserRoot()}/documents/{documentId}/questions/{question.Id}", question, ct);
        await UpdateDocumentQuestionCountAsync(documentId, ct);
        return question;
    }

    public async Task<List<Question>> SaveQuestionsAsync(
        int documentId,
        IEnumerable<Question> questions,
        CancellationToken ct,
        int? finalQuestionCount = null)
    {
        var prepared = questions.ToList();
        foreach (var question in prepared)
            PrepareQuestion(documentId, question);

        await Parallel.ForEachAsync(
            prepared,
            new ParallelOptions { MaxDegreeOfParallelism = BulkWriteConcurrency, CancellationToken = ct },
            async (question, token) =>
            {
                await SetJsonDocAsync($"{UserRoot()}/documents/{documentId}/questions/{question.Id}", question, token);
            });

        await UpdateDocumentQuestionCountAsync(documentId, ct, finalQuestionCount);
        return prepared;
    }

    public async Task<int> CountQuestionsAsync(int documentId, CancellationToken ct)
    {
        return (await GetDocumentQuestionsAsync(documentId, ct)).Count;
    }

    public async Task<List<TestHistoryItemDto>> ListTestsAsync(CancellationToken ct)
    {
        var docs = await ListDocumentMetasAsync(ct);
        var docNames = docs.ToDictionary(d => d.Id, d => d.FileName);
        return (await ListTestsInternalAsync(ct))
            .OrderByDescending(t => t.StartedAt)
            .Select(t => new TestHistoryItemDto(
                t.Id,
                string.IsNullOrWhiteSpace(t.TestName) ? $"Test {t.Id}" : t.TestName,
                t.UploadedDocumentId,
                docNames.TryGetValue(t.UploadedDocumentId, out var name) ? name : "(unbekannt)",
                t.StartedAt,
                t.SubmittedAt,
                t.QuestionCount,
                t.Score,
                t.Percent,
                t.Passed))
            .ToList();
    }

    public async Task<TestSession?> GetTestAsync(int id, CancellationToken ct)
    {
        var fields = await GetDocAsync($"{UserRoot()}/testSessions/{id}", ct);
        return fields == null ? null : DeserializeTest(fields.Value);
    }

    public async Task SaveTestAsync(TestSession session, CancellationToken ct)
    {
        session.Document = null;
        foreach (var answer in session.Answers)
        {
            answer.TestSession = null;
            answer.Question = null;
            if (answer.Id <= 0) answer.Id = NewId();
            answer.TestSessionId = session.Id;
        }
        await SetJsonDocAsync($"{UserRoot()}/testSessions/{session.Id}", session, ct);
    }

    public async Task<(int testsDeleted, int answersDeleted)> DeleteAllTestsAsync(CancellationToken ct)
    {
        var tests = await ListTestsInternalAsync(ct);
        foreach (var test in tests)
            await DeleteDocAsync($"{UserRoot()}/testSessions/{test.Id}", ct);
        return (tests.Count, tests.Sum(t => t.Answers.Count));
    }

    public async Task<int> DeleteOpenTestAsync(int id, CancellationToken ct)
    {
        var test = await GetTestAsync(id, ct) ?? throw new KeyNotFoundException("Test nicht gefunden.");
        if (test.SubmittedAt != null)
            throw new InvalidOperationException("Abgeschlossene Tests bleiben für Statistik und Auswertung erhalten.");

        await DeleteDocAsync($"{UserRoot()}/testSessions/{id}", ct);
        return test.Answers.Count;
    }

    public async Task<TestSessionDto> StartTestAsync(StartTestRequest req, CancellationToken ct)
    {
        var settings = await GetSettingsAsync(ct);
        var questionCount = Math.Clamp(req.QuestionCount <= 0 ? settings.DefaultTestQuestionCount : req.QuestionCount, 1, 100);
        var questions = (await GetDocumentQuestionsAsync(req.DocumentId, ct)).OrderBy(_ => Random.Shared.Next()).Take(questionCount).ToList();
        if (questions.Count < questionCount)
            throw new InvalidOperationException($"Zu wenig Fragen vorhanden. Verfügbar: {questions.Count}, erforderlich: {questionCount}.");

        var session = new TestSession
        {
            Id = NewId(),
            UploadedDocumentId = req.DocumentId,
            TestName = string.IsNullOrWhiteSpace(req.TestName) ? $"Test {DateTime.Now:yyyy-MM-dd HH:mm}" : req.TestName.Trim(),
            QuestionCount = questionCount,
            StartedAt = DateTime.UtcNow
        };

        for (var i = 0; i < questions.Count; i++)
        {
            session.Answers.Add(new TestAnswer
            {
                Id = NewId(),
                TestSessionId = session.Id,
                QuestionId = questions[i].Id,
                DisplayOrder = i + 1,
                ShuffledOptionIdsJson = JsonSerializer.Serialize(questions[i].Options.OrderBy(_ => Random.Shared.Next()).Select(o => o.Id).ToList(), JsonOptions)
            });
        }

        await SaveTestAsync(session, ct);
        return ToTestSessionDto(session.Id, req.DocumentId, questions, session.Answers);
    }

    public async Task<TestSessionDto> ResumeTestAsync(int id, CancellationToken ct)
    {
        var session = await GetTestAsync(id, ct) ?? throw new KeyNotFoundException("Test nicht gefunden.");
        if (session.SubmittedAt != null) throw new InvalidOperationException("Test wurde bereits abgegeben. Öffne die Auswertung.");
        var questions = await QuestionsForSessionAsync(session, ct);
        return ToTestSessionDto(session.Id, session.UploadedDocumentId, questions, session.Answers);
    }

    public async Task<(int answered, int total)> SaveDraftAsync(int id, SubmitTestRequest req, CancellationToken ct)
    {
        var session = await GetTestAsync(id, ct) ?? throw new KeyNotFoundException("Test nicht gefunden.");
        if (session.SubmittedAt != null) throw new InvalidOperationException("Test wurde bereits abgegeben.");
        ApplySubmittedAnswers(session, req, await QuestionsForSessionAsync(session, ct));
        await SaveTestAsync(session, ct);
        return (session.Answers.Count(a => a.SelectedAnswerOptionId != null), session.QuestionCount);
    }

    public async Task RenameTestAsync(int id, string? name, CancellationToken ct)
    {
        var session = await GetTestAsync(id, ct) ?? throw new KeyNotFoundException("Test nicht gefunden.");
        name = (name ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(name)) throw new InvalidOperationException("Bitte gib einen Testnamen ein.");
        session.TestName = name.Length <= 200 ? name : name[..200];
        await SaveTestAsync(session, ct);
    }

    public async Task<TestSession> SubmitTestAsync(int id, SubmitTestRequest req, CancellationToken ct)
    {
        var session = await GetTestAsync(id, ct) ?? throw new KeyNotFoundException("Test nicht gefunden.");
        if (session.SubmittedAt != null) throw new InvalidOperationException("Test wurde bereits abgegeben.");
        var questions = await QuestionsForSessionAsync(session, ct);
        ApplySubmittedAnswers(session, req, questions);

        var byId = questions.ToDictionary(q => q.Id);
        var score = 0;
        foreach (var answer in session.Answers)
        {
            var q = byId[answer.QuestionId];
            var correctOption = q.Options.Single(o => o.OptionIndex == q.CorrectOptionIndex);
            answer.IsCorrect = answer.SelectedAnswerOptionId == correctOption.Id;
            if (answer.IsCorrect) score++;
        }
        session.Score = score;
        session.Percent = Math.Round(score * 100.0 / session.QuestionCount, 1);
        session.Passed = session.Percent >= 60.0;
        session.SubmittedAt = DateTime.UtcNow;
        await SaveTestAsync(session, ct);
        return session;
    }

    public async Task<ReviewDto> ReviewAsync(int id, CancellationToken ct)
    {
        var session = await GetTestAsync(id, ct) ?? throw new KeyNotFoundException("Test nicht gefunden.");
        var questions = await QuestionsForSessionAsync(session, ct);
        var byId = questions.ToDictionary(q => q.Id);
        var reviewQuestions = session.Answers.OrderBy(a => a.DisplayOrder).Select(a =>
        {
            var q = byId[a.QuestionId];
            var correct = q.Options.Single(o => o.OptionIndex == q.CorrectOptionIndex);
            var selected = q.Options.FirstOrDefault(o => o.Id == a.SelectedAnswerOptionId);
            return new ReviewQuestionDto(q.Id, q.QuestionText, q.Topic, q.Difficulty, q.IsAiGenerated, selected?.Text, correct.Text, a.IsCorrect, q.Explanation, q.Options.OrderBy(o => o.OptionIndex).Select(o => o.Text).ToList(), EmptyToNull(q.ImageDataUrl), EmptyToNull(q.ImageAltText), EmptyToNull(q.ImageFileName));
        }).ToList();

        var topicErrors = reviewQuestions.GroupBy(q => q.Topic)
            .Select(g => new TopicErrorDto(g.Key, g.Count(q => !q.IsCorrect), g.Count()))
            .Where(t => t.Errors > 0)
            .OrderByDescending(t => t.Errors)
            .ToList();

        return new ReviewDto(session.Id, session.Score, session.QuestionCount, session.Percent, session.Passed, reviewQuestions, topicErrors);
    }

    public async Task<OverallStatsDto> BuildStatsAsync(int? testSessionId, CancellationToken ct)
    {
        var allTests = await ListTestsInternalAsync(ct);
        var sessions = testSessionId.HasValue ? allTests.Where(t => t.Id == testSessionId.Value).ToList() : allTests;
        var completed = sessions.Where(t => t.SubmittedAt != null).ToList();
        var allQuestions = new List<Question>();
        foreach (var doc in await ListDocumentMetasAsync(ct))
        {
            var questions = await GetDocumentQuestionsAsync(doc.Id, ct);
            foreach (var q in questions) q.Document = new UploadedDocument { Id = doc.Id, FileName = doc.FileName };
            allQuestions.AddRange(questions);
        }
        var questionsById = allQuestions.ToDictionary(q => q.Id);
        var answerRows = completed.SelectMany(t => t.Answers.Select(a => (Test: t, Answer: a))).Where(x => questionsById.ContainsKey(x.Answer.QuestionId)).ToList();
        var totalAnswered = answerRows.Count;
        var totalCorrect = answerRows.Count(x => x.Answer.IsCorrect);

        var progress = completed.OrderBy(t => t.SubmittedAt).Select(t => new TestProgressPointDto(
            t.Id,
            string.IsNullOrWhiteSpace(t.TestName) ? $"Test {t.Id}" : t.TestName,
            t.SubmittedAt!.Value,
            t.Score,
            t.QuestionCount,
            t.Percent,
            t.Passed)).ToList();

        var topicInventory = allQuestions.GroupBy(q => TopicLabel(q.Topic)).ToDictionary(g => g.Key, g => new
        {
            QuestionCount = g.Select(q => q.Id).Distinct().Count(),
            DocumentCount = g.Select(q => q.UploadedDocumentId).Distinct().Count()
        });

        var topicPerformance = answerRows
            .GroupBy(x => TopicLabel(questionsById[x.Answer.QuestionId].Topic))
            .Select(g =>
            {
                var attempts = g.Count();
                var correct = g.Count(x => x.Answer.IsCorrect);
                topicInventory.TryGetValue(g.Key, out var inv);
                return new TopicPerformanceDto(g.Key, attempts, correct, attempts - correct, attempts == 0 ? 0 : Math.Round(correct * 100.0 / attempts, 1), inv?.QuestionCount ?? 0, inv?.DocumentCount ?? 0);
            })
            .OrderBy(t => t.Percent)
            .ThenByDescending(t => t.Attempts)
            .ToList();

        var difficultyPerformance = answerRows
            .GroupBy(x => DifficultyLabel(questionsById[x.Answer.QuestionId].Difficulty))
            .Select(g =>
            {
                var attempts = g.Count();
                var correct = g.Count(x => x.Answer.IsCorrect);
                return new DifficultyPerformanceDto(g.Key, attempts, correct, attempts - correct, attempts == 0 ? 0 : Math.Round(correct * 100.0 / attempts, 1));
            }).ToList();

        var docNames = (await ListDocumentMetasAsync(ct)).ToDictionary(d => d.Id, d => d.FileName);
        var weakQuestions = answerRows
            .GroupBy(x => x.Answer.QuestionId)
            .Select(g =>
            {
                var q = questionsById[g.Key];
                var attempts = g.Count();
                var errors = g.Count(x => !x.Answer.IsCorrect);
                return new QuestionWeakSpotDto(q.Id, q.UploadedDocumentId, docNames.GetValueOrDefault(q.UploadedDocumentId, "(unbekannt)"), TopicLabel(q.Topic), DifficultyLabel(q.Difficulty), q.QuestionText, attempts, errors, attempts == 0 ? 0 : Math.Round(errors * 100.0 / attempts, 1), g.Max(x => x.Test.SubmittedAt));
            })
            .Where(q => q.Errors > 0)
            .OrderByDescending(q => q.ErrorRate)
            .ThenByDescending(q => q.Errors)
            .Take(10)
            .ToList();

        var readiness = progress.TakeLast(5).Any() ? Math.Round(progress.TakeLast(5).Average(p => p.Percent), 1) : 0;
        var worstTopics = topicPerformance.Where(t => t.Errors > 0).OrderByDescending(t => t.Errors).Take(8).Select(t => new TopicErrorDto(t.Topic, t.Errors, t.Attempts)).ToList();
        var recommendations = BuildLearningRecommendations(topicPerformance, weakQuestions, progress, readiness).ToList();

        if (recommendations.Count == 0 && completed.Count > 0)
            recommendations.Add(new LearningRecommendationDto("Aktuellen Stand halten", "In den ausgewerteten Antworten gibt es keine Fehlerschwerpunkte. Plane kurze gemischte Wiederholungen, damit der Stand stabil bleibt.", "", 0, totalAnswered, 0, 0, "/pages/documents.html"));

        return new OverallStatsDto(
            sessions.Count,
            completed.Count,
            sessions.Count(t => t.SubmittedAt == null),
            completed.Count(t => t.Passed),
            completed.Count(t => !t.Passed),
            completed.Count == 0 ? 0 : Math.Round(completed.Count(t => t.Passed) * 100.0 / completed.Count, 1),
            completed.Count == 0 ? 0 : Math.Round(completed.Average(t => t.Percent), 1),
            totalAnswered,
            totalCorrect,
            totalAnswered == 0 ? 0 : Math.Round(totalCorrect * 100.0 / totalAnswered, 1),
            readiness,
            readiness switch { >= 80 => "prüfungsbereit", >= 60 => "stabil, weiter festigen", > 0 => "noch gezielt wiederholen", _ => "noch keine Daten" },
            testSessionId,
            testSessionId.HasValue ? sessions.FirstOrDefault()?.TestName : null,
            worstTopics,
            topicPerformance,
            difficultyPerformance,
            progress,
            weakQuestions,
            recommendations);
    }

    private static IEnumerable<LearningRecommendationDto> BuildLearningRecommendations(
        IReadOnlyCollection<TopicPerformanceDto> topics,
        IReadOnlyCollection<QuestionWeakSpotDto> weakQuestions,
        IReadOnlyList<TestProgressPointDto> progress,
        double readiness)
    {
        var usedTopics = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var result = new List<(double Score, LearningRecommendationDto Item)>();

        foreach (var topic in topics.Where(t => t.Errors > 0))
        {
            var errorRate = topic.Attempts == 0 ? 0 : Math.Round(topic.Errors * 100.0 / topic.Attempts, 1);
            var score = errorRate + Math.Min(30, topic.Errors * 4) + Math.Min(12, topic.Attempts);
            var priority = errorRate >= 50 || topic.Errors >= 4 ? "Priorität hoch" : errorRate >= 25 ? "Priorität mittel" : "Gezielt festigen";
            var questionHint = topic.QuestionCount > 0 ? $"{topic.QuestionCount} Fragen im Pool" : "Fragenpool öffnen";

            result.Add((score, new LearningRecommendationDto(
                $"{priority}: {topic.Topic}",
                $"{topic.Errors} Fehler bei {topic.Attempts} Antworten, Fehlerquote {errorRate:0.0} %. Starte mit den schwachen Fragen, lies die Erklärung und wiederhole danach {questionHint}.",
                topic.Topic,
                topic.QuestionCount,
                topic.Attempts,
                topic.Errors,
                errorRate,
                $"/pages/questions.html?topic={Uri.EscapeDataString(topic.Topic)}")));
        }

        foreach (var question in weakQuestions.Take(3))
        {
            if (!usedTopics.Add(question.Topic)) continue;
            var score = 90 + question.ErrorRate + question.Errors * 5;
            result.Add((score, new LearningRecommendationDto(
                $"Schlüsselfrage klären: {question.Topic}",
                $"Eine Frage aus {question.DocumentName} wurde {question.Errors} von {question.Attempts} Mal falsch beantwortet. Öffne das Thema, suche diese Frage und lerne zuerst die Erklärung aktiv nach.",
                question.Topic,
                1,
                question.Attempts,
                question.Errors,
                question.ErrorRate,
                $"/pages/questions.html?topic={Uri.EscapeDataString(question.Topic)}#q-{question.QuestionId}")));
        }

        if (progress.Count >= 4)
        {
            var recent = progress.TakeLast(3).Average(p => p.Percent);
            var previous = progress.Take(progress.Count - 3).TakeLast(3).DefaultIfEmpty().Average(p => p?.Percent ?? recent);
            if (recent + 8 < previous)
            {
                result.Add((85, new LearningRecommendationDto(
                    "Leistungstrend stabilisieren",
                    $"Die letzten Tests liegen im Schnitt bei {recent:0.0} %, davor bei {previous:0.0} %. Wiederhole zuerst die Themen mit der höchsten Fehlerquote und starte danach einen kurzen gemischten Test.",
                    "",
                    0,
                    progress.Count,
                    0,
                    Math.Round(Math.Max(0, previous - recent), 1),
                    "/pages/documents.html")));
            }
        }

        if (readiness is > 0 and < 60)
        {
            result.Add((70, new LearningRecommendationDto(
                "Basis vor Tempo",
                $"Der aktuelle Prüfungsstand liegt bei {readiness:0.0} %. Nimm dir zuerst die zwei schwächsten Themen vor und prüfe danach mit einem kurzen Test, ob die Fehlerquote sinkt.",
                "",
                0,
                progress.Count,
                0,
                Math.Round(100 - readiness, 1),
                "/pages/stats.html")));
        }

        return result
            .OrderByDescending(r => r.Score)
            .Select(r => r.Item)
            .Take(4);
    }

    public async Task<TestSession> GetTestWithGraphAsync(int id, CancellationToken ct)
    {
        var session = await GetTestAsync(id, ct) ?? throw new KeyNotFoundException("Test nicht gefunden.");
        session.Document = await GetDocumentAsync(session.UploadedDocumentId, ct, includeText: false);
        var questions = await QuestionsForSessionAsync(session, ct);
        var byId = questions.ToDictionary(q => q.Id);
        foreach (var answer in session.Answers)
            if (byId.TryGetValue(answer.QuestionId, out var q)) answer.Question = q;
        return session;
    }

    private async Task<List<TestSession>> ListTestsInternalAsync(CancellationToken ct)
    {
        return (await ListDocElementsAsync($"{UserRoot()}/testSessions", ct)).Select(DeserializeTest).ToList();
    }

    private async Task<List<Question>> QuestionsForSessionAsync(TestSession session, CancellationToken ct)
    {
        var all = await GetDocumentQuestionsAsync(session.UploadedDocumentId, ct);
        var ids = session.Answers.Select(a => a.QuestionId).ToHashSet();
        return all.Where(q => ids.Contains(q.Id)).ToList();
    }

    private static void ApplySubmittedAnswers(TestSession session, SubmitTestRequest req, List<Question> questions)
    {
        var submitted = req.Answers.ToDictionary(a => a.QuestionId, a => a.SelectedAnswerOptionId);
        var validByQuestion = questions.ToDictionary(q => q.Id, q => q.Options.Select(o => o.Id).ToHashSet());
        foreach (var answer in session.Answers)
        {
            submitted.TryGetValue(answer.QuestionId, out var selectedOptionId);
            if (selectedOptionId != null && (!validByQuestion.TryGetValue(answer.QuestionId, out var valid) || !valid.Contains(selectedOptionId.Value)))
                throw new InvalidOperationException("Eine gespeicherte Antwort passt nicht zu diesem Test.");
            answer.SelectedAnswerOptionId = selectedOptionId;
        }
    }

    private static TestSessionDto ToTestSessionDto(int sessionId, int documentId, List<Question> questions, List<TestAnswer> answers)
    {
        var byQuestion = questions.ToDictionary(q => q.Id);
        var result = answers.OrderBy(a => a.DisplayOrder).Select(a =>
        {
            var q = byQuestion[a.QuestionId];
            var shuffledIds = JsonSerializer.Deserialize<List<int>>(a.ShuffledOptionIdsJson, JsonOptions) ?? [];
            var optionsById = q.Options.ToDictionary(o => o.Id);
            var options = shuffledIds.Where(optionsById.ContainsKey).Select(id => new TestOptionDto(id, optionsById[id].Text)).ToList();
            return new TestQuestionDto(q.Id, q.QuestionText, q.Topic, q.Difficulty, q.IsAiGenerated, options, a.SelectedAnswerOptionId, EmptyToNull(q.ImageDataUrl), EmptyToNull(q.ImageAltText), EmptyToNull(q.ImageFileName));
        }).ToList();
        return new TestSessionDto(sessionId, documentId, result.Count, result);
    }

    private async Task<List<DocMeta>> ListDocumentMetasAsync(CancellationToken ct)
    {
        return (await ListDocElementsAsync($"{UserRoot()}/documents", ct)).Select(e =>
        {
            var meta = DeserializeDocMeta(e);
            meta.QuestionCount = FirestoreInt(e.GetProperty("fields"), "questionCount");
            meta.TextLength = FirestoreInt(e.GetProperty("fields"), "textLength");
            return meta;
        }).ToList();
    }

    private UploadedDocument DeserializeDoc(JsonElement fields)
    {
        var meta = JsonSerializer.Deserialize<DocMeta>(FirestoreString(fields, "dataJson"), JsonOptions) ?? new DocMeta();
        return new UploadedDocument { Id = meta.Id, FileName = meta.FileName, FolderPath = meta.FolderPath, ContentType = meta.ContentType, CreatedAt = meta.CreatedAt };
    }

    private DocMeta DeserializeDocMeta(JsonElement document)
    {
        var fields = document.GetProperty("fields");
        return JsonSerializer.Deserialize<DocMeta>(FirestoreString(fields, "dataJson"), JsonOptions) ?? new DocMeta { Id = int.Parse(FirestoreDocumentId(document), CultureInfo.InvariantCulture) };
    }

    private static DocMeta ToDocMeta(UploadedDocument doc, int textLength, int questionCount) => new()
    {
        Id = doc.Id,
        FileName = doc.FileName,
        FolderPath = doc.FolderPath,
        ContentType = doc.ContentType,
        CreatedAt = doc.CreatedAt,
        TextLength = textLength,
        QuestionCount = questionCount
    };

    private Question DeserializeQuestion(JsonElement document)
    {
        var fields = document.TryGetProperty("fields", out var f) ? f : document;
        var q = JsonSerializer.Deserialize<Question>(FirestoreString(fields, "dataJson"), JsonOptions) ?? new Question();
        foreach (var option in q.Options)
        {
            option.Question = null;
            option.QuestionId = q.Id;
        }
        return q;
    }

    private TestSession DeserializeTest(JsonElement document)
    {
        var fields = document.TryGetProperty("fields", out var f) ? f : document;
        var session = JsonSerializer.Deserialize<TestSession>(FirestoreString(fields, "dataJson"), JsonOptions) ?? new TestSession();
        foreach (var answer in session.Answers)
        {
            answer.TestSession = null;
            answer.Question = null;
            answer.TestSessionId = session.Id;
        }
        return session;
    }

    private async Task SaveTextAsync(int documentId, string text, CancellationToken ct)
    {
        foreach (var existing in await ListDocElementsAsync($"{UserRoot()}/documents/{documentId}/textChunks", ct))
            await DeleteDocAsync($"{UserRoot()}/documents/{documentId}/textChunks/{FirestoreDocumentId(existing)}", ct);

        var chunks = SplitText(text ?? string.Empty).ToList();
        for (var i = 0; i < chunks.Count; i++)
        {
            await SetFieldsAsync($"{UserRoot()}/documents/{documentId}/textChunks/{i:00000}", new()
            {
                ["order"] = FsInt(i),
                ["text"] = FsString(chunks[i])
            }, ct);
        }
    }

    private async Task<string> LoadTextAsync(int documentId, CancellationToken ct)
    {
        var chunks = await ListDocElementsAsync($"{UserRoot()}/documents/{documentId}/textChunks", ct);
        return string.Concat(chunks
            .OrderBy(c => FirestoreDocumentId(c))
            .Select(c => FirestoreString(c.GetProperty("fields"), "text")));
    }

    private async Task UpdateDocumentQuestionCountAsync(int documentId, CancellationToken ct, int? knownCount = null)
    {
        var fields = await GetDocAsync($"{UserRoot()}/documents/{documentId}", ct);
        if (fields == null) return;

        var doc = DeserializeDoc(fields.Value);
        var textLength = FirestoreInt(fields.Value, "textLength");
        if (textLength == 0)
        {
            var storedMeta = JsonSerializer.Deserialize<DocMeta>(FirestoreString(fields.Value, "dataJson"), JsonOptions);
            textLength = storedMeta?.TextLength ?? 0;
        }
        var count = knownCount ?? await CountQuestionsAsync(documentId, ct);
        await SetJsonDocAsync($"{UserRoot()}/documents/{documentId}", ToDocMeta(doc, textLength, count), ct, extraFields: new()
        {
            ["textLength"] = FsInt(textLength),
            ["questionCount"] = FsInt(count)
        });
    }

    private static void PrepareQuestion(int documentId, Question question)
    {
        if (question.Id <= 0) question.Id = NewId();
        question.UploadedDocumentId = documentId;
        question.Document = null;
        question.CreatedAt = question.CreatedAt == default ? DateTime.UtcNow : question.CreatedAt;
        for (var i = 0; i < question.Options.Count; i++)
        {
            question.Options[i].Question = null;
            question.Options[i].QuestionId = question.Id;
            question.Options[i].OptionIndex = i;
            if (question.Options[i].Id <= 0) question.Options[i].Id = NewId();
        }
    }

    private async Task<bool> DemoWasSeededAsync(CancellationToken ct)
    {
        var fields = await GetDocAsync($"{UserRoot()}/meta/app", ct);
        return fields != null && FirestoreBool(fields.Value, "demoSeeded");
    }

    private async Task MarkDemoSeededAsync(CancellationToken ct)
    {
        await SetFieldsAsync($"{UserRoot()}/meta/app", new() { ["demoSeeded"] = FsBool(true), ["updatedAt"] = FsTimestamp(DateTime.UtcNow) }, ct);
    }

    private async Task SeedDemoAsync(CancellationToken ct)
    {
        var doc = new UploadedDocument
        {
            Id = NewId(),
            FileName = "Beispiel-Test Medizin",
            FolderPath = "Beispiele",
            ContentType = "text/plain",
            ExtractedText = "Demo-Dokument mit allgemeinen Beispiel-Fragen für den sofortigen Test der App.",
            CreatedAt = DateTime.UtcNow
        };
        await SaveDocumentAsync(doc, ct);
        foreach (var item in DemoQuestionSeeds.Items)
        {
            await SaveQuestionAsync(doc.Id, new Question
            {
                QuestionText = item.Question,
                CorrectOptionIndex = item.Correct,
                Explanation = item.Explanation,
                Topic = item.Topic,
                Difficulty = item.Difficulty,
                IsAiGenerated = false,
                CreatedAt = DateTime.UtcNow,
                Options = item.Options.Select((text, index) => new AnswerOption { Id = NewId(), Text = text, OptionIndex = index }).ToList()
            }, ct);
        }
        await MarkDemoSeededAsync(ct);
    }

    private string UserRoot()
    {
        var principal = _httpContextAccessor.HttpContext?.User;
        var uid = principal?.FindFirst("user_id")?.Value ?? principal?.FindFirst("sub")?.Value;
        if (string.IsNullOrWhiteSpace(uid)) throw new InvalidOperationException("Firebase-Benutzer fehlt.");
        return $"users/{uid}";
    }

    private string ProjectId()
    {
        var projectId = (_configuration["Auth:Firebase:ProjectId"] ?? string.Empty).Trim();
        if (string.IsNullOrWhiteSpace(projectId)) throw new InvalidOperationException("Firebase ProjectId ist nicht konfiguriert.");
        return projectId;
    }

    private string BearerToken()
    {
        var authorization = _httpContextAccessor.HttpContext?.Request.Headers.Authorization.ToString() ?? string.Empty;
        const string prefix = "Bearer ";
        if (!authorization.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("Firebase-Token fehlt.");
        return authorization[prefix.Length..].Trim();
    }

    private async Task<JsonElement?> GetDocAsync(string documentPath, CancellationToken ct)
    {
        var response = await SendAsync(HttpMethod.Get, $"documents/{documentPath}", null, ct);
        if (response.StatusCode == HttpStatusCode.NotFound) return null;
        await EnsureSuccessAsync(response, ct);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
        return json.RootElement.GetProperty("fields").Clone();
    }

    private async Task<List<JsonElement>> ListDocElementsAsync(string collectionPath, CancellationToken ct)
    {
        var result = new List<JsonElement>();
        string? pageToken = null;
        do
        {
            var suffix = $"documents/{collectionPath}?pageSize=1000" + (string.IsNullOrWhiteSpace(pageToken) ? "" : $"&pageToken={Uri.EscapeDataString(pageToken)}");
            var response = await SendAsync(HttpMethod.Get, suffix, null, ct);
            if (response.StatusCode == HttpStatusCode.NotFound) return result;
            await EnsureSuccessAsync(response, ct);
            using var json = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            if (json.RootElement.TryGetProperty("documents", out var docs))
                result.AddRange(docs.EnumerateArray().Select(d => d.Clone()));
            pageToken = json.RootElement.TryGetProperty("nextPageToken", out var token) ? token.GetString() : null;
        } while (!string.IsNullOrWhiteSpace(pageToken));
        return result;
    }

    private async Task SetJsonDocAsync<T>(string documentPath, T data, CancellationToken ct, Dictionary<string, object>? extraFields = null)
    {
        var fields = extraFields ?? new Dictionary<string, object>();
        fields["dataJson"] = FsString(JsonSerializer.Serialize(data, JsonOptions));
        await SetFieldsAsync(documentPath, fields, ct);
    }

    private async Task SetFieldsAsync(string documentPath, Dictionary<string, object> fields, CancellationToken ct)
    {
        var response = await SendAsync(HttpMethod.Patch, $"documents/{documentPath}", new { fields }, ct);
        await EnsureSuccessAsync(response, ct);
    }

    private async Task DeleteDocAsync(string documentPath, CancellationToken ct)
    {
        var response = await SendAsync(HttpMethod.Delete, $"documents/{documentPath}", null, ct);
        if (response.StatusCode != HttpStatusCode.NotFound) await EnsureSuccessAsync(response, ct);
    }

    private async Task<HttpResponseMessage> SendAsync(HttpMethod method, string pathAndQuery, object? body, CancellationToken ct)
    {
        var client = _httpClientFactory.CreateClient();
        var url = $"https://firestore.googleapis.com/v1/projects/{Uri.EscapeDataString(ProjectId())}/databases/(default)/{pathAndQuery.TrimStart('/')}";
        var request = new HttpRequestMessage(method, url);
        request.Headers.TryAddWithoutValidation("Authorization", $"Bearer {BearerToken()}");
        if (body != null) request.Content = new StringContent(JsonSerializer.Serialize(body, JsonOptions), Encoding.UTF8, "application/json");
        return await client.SendAsync(request, ct);
    }

    private static async Task EnsureSuccessAsync(HttpResponseMessage response, CancellationToken ct)
    {
        if (response.IsSuccessStatusCode) return;
        var raw = await response.Content.ReadAsStringAsync(ct);
        try
        {
            using var json = JsonDocument.Parse(raw);
            if (json.RootElement.TryGetProperty("error", out var error) &&
                error.TryGetProperty("message", out var message))
                throw new InvalidOperationException(message.GetString());
        }
        catch (JsonException) { }
        throw new InvalidOperationException(string.IsNullOrWhiteSpace(raw) ? $"Firestore-Fehler: {(int)response.StatusCode}" : raw);
    }

    private static string FunctionError(string raw, string fallback)
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
        catch (JsonException) { }
        return string.IsNullOrWhiteSpace(raw) ? fallback : raw;
    }

    private static IEnumerable<string> SplitText(string text)
    {
        if (string.IsNullOrEmpty(text)) { yield return string.Empty; yield break; }
        for (var i = 0; i < text.Length; i += TextChunkChars)
            yield return text.Substring(i, Math.Min(TextChunkChars, text.Length - i));
    }

    private static int NewId() => RandomNumberGenerator.GetInt32(100_000, int.MaxValue);

    private static object FsString(string? value) => new Dictionary<string, object> { ["stringValue"] = value ?? string.Empty };
    private static object FsInt(int value) => new Dictionary<string, object> { ["integerValue"] = value.ToString(CultureInfo.InvariantCulture) };
    private static object FsBool(bool value) => new Dictionary<string, object> { ["booleanValue"] = value };
    private static object FsTimestamp(DateTime value) => new Dictionary<string, object> { ["timestampValue"] = value.ToUniversalTime().ToString("O", CultureInfo.InvariantCulture) };

    private static string FirestoreString(JsonElement fields, string fieldName)
    {
        if (!fields.TryGetProperty(fieldName, out var field)) return string.Empty;
        if (field.TryGetProperty("stringValue", out var stringValue)) return stringValue.GetString() ?? string.Empty;
        return string.Empty;
    }

    private static int FirestoreInt(JsonElement fields, string fieldName)
    {
        if (!fields.TryGetProperty(fieldName, out var field)) return 0;
        if (field.TryGetProperty("integerValue", out var integerValue) && int.TryParse(integerValue.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed)) return parsed;
        return 0;
    }

    private static bool FirestoreBool(JsonElement fields, string fieldName)
    {
        return fields.TryGetProperty(fieldName, out var field) && field.TryGetProperty("booleanValue", out var value) && value.GetBoolean();
    }

    private static string FirestoreDocumentId(JsonElement document)
    {
        var name = document.GetProperty("name").GetString() ?? string.Empty;
        var slash = name.LastIndexOf('/');
        return slash >= 0 ? Uri.UnescapeDataString(name[(slash + 1)..]) : name;
    }

    private static string? EmptyToNull(string? value) => string.IsNullOrWhiteSpace(value) ? null : value;

    private static ProgramSettings DefaultSettings()
    {
        var settings = new ProgramSettings();
        ApplyFixedAiSettings(settings);
        return settings;
    }

    private static bool ApplyFixedAiSettings(ProgramSettings settings)
    {
        settings.AiProvider = AiProviderCatalog.FirebaseProvider;
        settings.OpenAiModel = AiProviderCatalog.DefaultModel;
        settings.AiApiBaseUrl = AiProviderCatalog.FirebaseFunctionUrl;
        settings.OpenAiApiKey = string.Empty;
        settings.AllowLocalFallback = false;
        return true;
    }

    private static string TopicLabel(string? topic) => string.IsNullOrWhiteSpace(topic) ? "Allgemein" : topic.Trim();

    private static string DifficultyLabel(string? difficulty)
    {
        difficulty = (difficulty ?? "mittel").Trim().ToLowerInvariant();
        return difficulty is "leicht" or "mittel" or "schwer" ? difficulty : "mittel";
    }

    private sealed class DocMeta
    {
        public int Id { get; set; }
        public string FileName { get; set; } = string.Empty;
        public string FolderPath { get; set; } = string.Empty;
        public string ContentType { get; set; } = string.Empty;
        public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
        public int TextLength { get; set; }
        public int QuestionCount { get; set; }
    }
}

public sealed record DemoQuestionSeed(string Question, string[] Options, int Correct, string Explanation, string Topic, string Difficulty);

public static class DemoQuestionSeeds
{
    public static readonly DemoQuestionSeed[] Items =
    [
        new("Welche Herzkammer pumpt sauerstoffreiches Blut in den Körperkreislauf?", ["Linker Ventrikel", "Rechter Ventrikel", "Rechter Vorhof", "Linker Vorhof", "Keine der genannten Antworten"], 0, "Der linke Ventrikel wirft Blut über die Aorta in den systemischen Kreislauf aus.", "Kardiologie", "leicht"),
        new("Welche Klappe liegt zwischen linkem Vorhof und linkem Ventrikel?", ["Mitralklappe", "Trikuspidalklappe", "Pulmonalklappe", "Aortenklappe", "Keine der genannten Antworten"], 0, "Die Mitralklappe trennt linken Vorhof und linken Ventrikel.", "Kardiologie", "leicht"),
        new("Was beschreibt eine Tachykardie?", ["Erhöhte Herzfrequenz", "Erniedrigte Atemfrequenz", "Erhöhter Blutdruck", "Erniedrigte Körpertemperatur", "Keine der genannten Antworten"], 0, "Tachykardie bedeutet eine pathologisch oder physiologisch erhöhte Herzfrequenz.", "Kardiologie", "leicht"),
        new("Welcher Zelltyp produziert im Pankreas Insulin?", ["Beta-Zellen", "Alpha-Zellen", "Delta-Zellen", "Azinarzellen", "Keine der genannten Antworten"], 0, "Insulin wird in den Beta-Zellen der Langerhans-Inseln gebildet.", "Endokrinologie", "leicht"),
        new("Welche Struktur ist die funktionelle Einheit der Niere?", ["Nephron", "Alveole", "Hepatozyt", "Sarkomer", "Keine der genannten Antworten"], 0, "Das Nephron besteht aus Glomerulus und Tubulussystem und bildet die funktionelle Einheit der Niere.", "Nephrologie", "leicht"),
        new("Wo findet die glomeruläre Filtration statt?", ["Im Nierenkörperchen", "Im Sammelrohr", "In der Harnblase", "Im distalen Ösophagus", "Keine der genannten Antworten"], 0, "Die Filtration erfolgt im Glomerulus innerhalb des Nierenkörperchens.", "Nephrologie", "mittel"),
        new("Welcher Teil des Atemtrakts ist hauptsächlich für den Gasaustausch verantwortlich?", ["Alveolen", "Trachea", "Larynx", "Bronchien erster Ordnung", "Keine der genannten Antworten"], 0, "Der Gasaustausch zwischen Luft und Blut erfolgt über die alveolokapilläre Membran.", "Pneumologie", "leicht"),
        new("Welcher Blutbestandteil ist hauptsächlich für den Sauerstofftransport zuständig?", ["Hämoglobin", "Albumin", "Fibrinogen", "Immunglobulin E", "Keine der genannten Antworten"], 0, "Hämoglobin in Erythrozyten bindet und transportiert Sauerstoff.", "Hämatologie", "leicht"),
        new("Welche Zellen sind primär an der humoralen Immunantwort beteiligt?", ["B-Lymphozyten", "Erythrozyten", "Thrombozyten", "Fibroblasten", "Keine der genannten Antworten"], 0, "B-Zellen können sich zu Plasmazellen differenzieren und Antikörper produzieren.", "Immunologie", "mittel"),
        new("Welches Organ produziert Galle?", ["Leber", "Gallenblase", "Pankreas", "Milz", "Keine der genannten Antworten"], 0, "Die Leber produziert Galle; die Gallenblase speichert und konzentriert sie.", "Gastroenterologie", "leicht")
    ];
}
