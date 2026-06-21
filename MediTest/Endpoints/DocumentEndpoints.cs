using System.Text;
using System.Text.RegularExpressions;
using MediTest.Dtos;
using MediTest.Models;
using MediTest.Services;
using static MediTest.AppSupport;

namespace MediTest;

internal static class DocumentEndpoints
{
    public static IEndpointRouteBuilder MapDocumentEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/documents/upload", async (HttpRequest request, FirestoreUserDataStore store, ITextExtractionService extractor, IConfiguration cfg, CancellationToken ct) =>
        {
            if (!request.HasFormContentType) return Results.BadRequest(new { error = "Multipart/Form-Data erwartet." });
            IFormCollection form;
            try
            {
                form = await request.ReadFormAsync(ct);
            }
            catch (InvalidDataException)
            {
                return Results.BadRequest(new { error = "Die Dateiübertragung war unvollständig. Bitte wähle die Datei erneut aus und versuche es noch einmal." });
            }
            var file = form.Files.GetFile("file");
            if (file == null || file.Length == 0) return Results.BadRequest(new { error = "Keine Datei hochgeladen." });
            if (!AllowedFile(file)) return Results.BadRequest(new { error = "Nur PDF, PPTX und TXT sind erlaubt." });

            var maxMb = cfg.GetValue<int?>("Upload:MaxFileSizeMb") ?? 100;
            if (file.Length > maxMb * 1024L * 1024L) return Results.BadRequest(new { error = $"Datei ist zu groß. Maximum: {maxMb} MB." });

            string text;
            try
            {
                text = await extractor.ExtractTextAsync(file, ct);
            }
            catch (Exception ex) when (ex is InvalidDataException or IOException or InvalidOperationException or UnauthorizedAccessException)
            {
                return Results.BadRequest(new
                {
                    error = $"„{Path.GetFileName(file.FileName)}" konnte nicht gelesen werden. Prüfe, ob die Datei lokal verfügbar, unbeschädigt und nicht passwortgeschützt ist."
                });
            }
            if (string.IsNullOrWhiteSpace(text)) return Results.BadRequest(new { error = "Aus der Datei konnte kein Text extrahiert werden." });

            var doc = new UploadedDocument
            {
                FileName = Path.GetFileName(file.FileName),
                FolderPath = DocumentFolderPath(form["folderPath"].ToString()),
                ContentType = file.ContentType ?? string.Empty,
                ExtractedText = text,
                FileSizeBytes = file.Length,
                CreatedAt = DateTime.UtcNow
            };
            await store.SaveDocumentAsync(doc, ct);
            return Results.Ok(new { doc.Id, doc.FileName, doc.FileSizeBytes });
        });

        app.MapGet("/api/documents", async (FirestoreUserDataStore store, CancellationToken ct) =>
        {
            return Results.Ok(await store.ListDocumentsAsync(ct));
        });

        app.MapGet("/api/documents/{id:int}/preview", async (int id, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            var doc = await store.GetDocumentAsync(id, ct, includeText: true);
            if (doc == null) return Results.NotFound(new { error = "Dokument nicht gefunden." });

            return Results.Ok(new
            {
                doc.Id,
                doc.FileName,
                doc.FolderPath,
                doc.ContentType,
                doc.CreatedAt,
                fileSizeBytes = DocumentContentPolicy.DisplaySizeBytes(doc.FileSizeBytes, Encoding.UTF8.GetByteCount(doc.ExtractedText)),
                text = doc.ExtractedText
            });
        });

        app.MapGet("/api/documents/{id:int}/questions", async (int id, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            var doc = await store.GetDocumentAsync(id, ct, includeQuestions: true, includeText: false);
            if (doc == null) return Results.NotFound(new { error = "Dokument nicht gefunden." });

            var questions = doc.Questions
                .OrderBy(q => q.Id)
                .Select(q => new QuestionListItemDto(
                    q.Id,
                    q.QuestionText,
                    q.Topic,
                    q.Difficulty,
                    q.IsAiGenerated,
                    q.Explanation,
                    q.CorrectOptionIndex,
                    q.Options
                        .OrderBy(o => o.OptionIndex)
                        .Select(o => new QuestionOptionListItemDto(o.Id, o.OptionIndex, o.Text, o.OptionIndex == q.CorrectOptionIndex))
                        .ToList(),
                    EmptyToNull(q.ImageDataUrl),
                    EmptyToNull(q.ImageAltText),
                    EmptyToNull(q.ImageFileName)))
                .ToList();

            return Results.Ok(new { documentId = doc.Id, documentName = doc.FileName, questionCount = questions.Count, questions });
        });

        app.MapGet("/api/questions/by-topic", async (string topic, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            topic = TopicLabel(topic);
            var rows = await store.GetQuestionsByTopicAsync(topic, ct);

            var questions = rows
                .Select(q => new TopicQuestionItemDto(
                    q.Id,
                    q.UploadedDocumentId,
                    q.Document != null ? q.Document.FileName : "(unbekannt)",
                    q.QuestionText,
                    q.Topic,
                    q.Difficulty,
                    q.IsAiGenerated,
                    q.Explanation,
                    q.CorrectOptionIndex,
                    q.Options
                        .OrderBy(o => o.OptionIndex)
                        .Select(o => new QuestionOptionListItemDto(o.Id, o.OptionIndex, o.Text, o.OptionIndex == q.CorrectOptionIndex))
                        .ToList(),
                    EmptyToNull(q.ImageDataUrl),
                    EmptyToNull(q.ImageAltText),
                    EmptyToNull(q.ImageFileName)))
                .ToList();

            return Results.Ok(new TopicQuestionListDto(topic, questions.Count, questions));
        });

        app.MapPut("/api/questions/{id:int}", async (int id, UpdateQuestionRequest req, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.QuestionText)) return Results.BadRequest(new { error = "Fragetext fehlt." });
            if (req.Options == null || req.Options.Count != 5 || req.Options.Any(string.IsNullOrWhiteSpace))
                return Results.BadRequest(new { error = "Genau 5 Antwortmöglichkeiten sind erforderlich." });
            if (req.CorrectOptionIndex < 0 || req.CorrectOptionIndex > 4)
                return Results.BadRequest(new { error = "Index der richtigen Antwort muss zwischen 0 und 4 liegen." });
            var imageError = ValidateQuestionImage(req.ImageDataUrl);
            if (imageError != null) return Results.BadRequest(new { error = imageError });

            Question question;
            try
            {
                question = await store.UpdateQuestionAsync(id, req, ct);
            }
            catch (KeyNotFoundException)
            {
                return Results.NotFound(new { error = "Frage nicht gefunden." });
            }
            return Results.Ok(new { saved = true, questionId = question.Id });
        });

        app.MapDelete("/api/documents/{id:int}", async (int id, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            var doc = await store.GetDocumentAsync(id, ct, includeText: false);
            if (doc == null) return Results.NotFound(new { error = "Dokument nicht gefunden." });

            await store.DeleteDocumentAsync(id, ct);
            return Results.Ok(new { deleted = true, id });
        });

        app.MapPut("/api/documents/{id:int}/folder", async (int id, UpdateDocumentFolderRequest req, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            var doc = await store.UpdateDocumentFolderAsync(id, DocumentFolderPath(req.FolderPath), ct);
            return doc == null
                ? Results.NotFound(new { error = "Dokument nicht gefunden." })
                : Results.Ok(new { saved = true, doc.Id, doc.FolderPath });
        });

        app.MapPost("/api/questions/manual", async (CreateManualQuestionRequest req, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            if (string.IsNullOrWhiteSpace(req.QuestionText)) return Results.BadRequest(new { error = "Fragetext fehlt." });
            if (req.Options == null || req.Options.Count != 5 || req.Options.Any(string.IsNullOrWhiteSpace))
                return Results.BadRequest(new { error = "Genau 5 Antwortmöglichkeiten sind erforderlich." });
            if (req.CorrectOptionIndex < 0 || req.CorrectOptionIndex > 4)
                return Results.BadRequest(new { error = "Index der richtigen Antwort muss zwischen 0 und 4 liegen." });
            var imageError = ValidateQuestionImage(req.ImageDataUrl);
            if (imageError != null) return Results.BadRequest(new { error = imageError });

            UploadedDocument? doc = null;
            if (req.DocumentId.HasValue)
                doc = await store.GetDocumentAsync(req.DocumentId.Value, ct, includeText: false);

            if (doc == null)
            {
                var name = string.IsNullOrWhiteSpace(req.DocumentName) ? "Manueller Fragenpool" : req.DocumentName.Trim();
                doc = new UploadedDocument
                {
                    FileName = name,
                    FolderPath = "Manuell",
                    ContentType = "manual/question-pool",
                    ExtractedText = "Manuell angelegter Fragenpool.",
                    CreatedAt = DateTime.UtcNow
                };
                await store.SaveDocumentAsync(doc, ct);
            }

            var difficulty = (req.Difficulty ?? "mittel").Trim().ToLowerInvariant();
            if (difficulty is not ("leicht" or "mittel" or "schwer")) difficulty = "mittel";

            var question = new Question
            {
                UploadedDocumentId = doc.Id,
                QuestionText = req.QuestionText.Trim(),
                CorrectOptionIndex = req.CorrectOptionIndex,
                Explanation = string.IsNullOrWhiteSpace(req.Explanation) ? "Manuell angelegte Frage." : req.Explanation.Trim(),
                Topic = string.IsNullOrWhiteSpace(req.Topic) ? "Manuell" : req.Topic.Trim(),
                Difficulty = difficulty,
                ImageDataUrl = (req.ImageDataUrl ?? string.Empty).Trim(),
                ImageAltText = TrimTo(req.ImageAltText, 240),
                ImageFileName = TrimTo(req.ImageFileName, 200),
                CreatedAt = DateTime.UtcNow,
                Options = req.Options.Select((text, index) => new AnswerOption { Text = text.Trim(), OptionIndex = index }).ToList()
            };

            question = await store.SaveQuestionAsync(doc.Id, question, ct);
            var total = await store.CountQuestionsAsync(doc.Id, ct);
            return Results.Ok(new { questionId = question.Id, documentId = doc.Id, documentName = doc.FileName, totalQuestions = total });
        });

        app.MapGet("/api/documents/{id:int}/export-txt", async (int id, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            var doc = await store.GetDocumentAsync(id, ct, includeQuestions: true, includeText: false);
            if (doc == null) return Results.NotFound(new { error = "Dokument nicht gefunden." });

            var sb = new StringBuilder();
            var questions = doc.Questions.OrderBy(q => q.Id).ToList();
            for (var i = 0; i < questions.Count; i++)
            {
                var q = questions[i];
                var opts = q.Options.OrderBy(o => o.OptionIndex).ToList();
                sb.AppendLine($"{i + 1}. {q.QuestionText}");
                for (var j = 0; j < Math.Min(5, opts.Count); j++)
                    sb.AppendLine($"{(char)('a' + j)}. {opts[j].Text}");
                var correctLetter = (char)('a' + Math.Clamp(q.CorrectOptionIndex, 0, 4));
                sb.AppendLine($"Richtig: {correctLetter}");
                sb.AppendLine($"Thema: {q.Topic}");
                sb.AppendLine($"Schwierigkeit: {q.Difficulty}");
                sb.AppendLine($"KI-generiert: {(q.IsAiGenerated ? "Ja" : "Nein")}");
                sb.AppendLine($"Erklärung: {q.Explanation}");
                sb.AppendLine();
            }

            var bytes = Encoding.UTF8.GetBytes(sb.ToString());
            var safeName = Regex.Replace(doc.FileName, "[^A-Za-z0-9äöüÄÖÜß _.-]", "_");
            return Results.File(bytes, "text/plain; charset=utf-8", $"{safeName}_Fragenexport.txt");
        });

        app.MapPost("/api/documents/import-txt", async (HttpRequest request, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            if (!request.HasFormContentType) return Results.BadRequest(new { error = "Multipart/Form-Data erwartet." });
            var form = await request.ReadFormAsync(ct);
            var file = form.Files.GetFile("file");
            if (file == null || file.Length == 0) return Results.BadRequest(new { error = "Keine TXT-Datei hochgeladen." });
            if (Path.GetExtension(file.FileName).ToLowerInvariant() != ".txt") return Results.BadRequest(new { error = "Nur .txt ist für den Import erlaubt." });

            var documentName = form["documentName"].ToString();
            if (string.IsNullOrWhiteSpace(documentName)) documentName = Path.GetFileNameWithoutExtension(file.FileName);
            var folderPath = DocumentFolderPath(form["folderPath"].ToString());
            var isAiGenerated = bool.TryParse(form["isAiGenerated"].ToString(), out var parsedAiGenerated) &&
                parsedAiGenerated;

            using var reader = new StreamReader(file.OpenReadStream(), Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            var content = await reader.ReadToEndAsync(ct);
            var parsed = ParseImportedQuestions(content);
            if (parsed.Count == 0) return Results.BadRequest(new { error = "Keine gültigen Fragen im TXT-Format gefunden." });

            var doc = new UploadedDocument
            {
                FileName = documentName,
                FolderPath = folderPath,
                ContentType = "text/imported-question-pool",
                ExtractedText = "Importierter Fragenpool aus TXT.",
                FileSizeBytes = file.Length,
                CreatedAt = DateTime.UtcNow
            };
            await store.SaveDocumentAsync(doc, ct);

            var importedQuestions = parsed.Select(p => new Question
            {
                UploadedDocumentId = doc.Id,
                QuestionText = p.Question,
                CorrectOptionIndex = p.Correct,
                Explanation = p.Explanation,
                Topic = p.Topic,
                Difficulty = p.Difficulty,
                IsAiGenerated = isAiGenerated,
                CreatedAt = DateTime.UtcNow,
                Options = p.Options.Select((o, i) => new AnswerOption { Text = o, OptionIndex = i }).ToList()
            }).ToList();
            await store.SaveQuestionsAsync(doc.Id, importedQuestions, ct, finalQuestionCount: importedQuestions.Count);

            return Results.Ok(new
            {
                documentId = doc.Id,
                documentName = doc.FileName,
                importedQuestions = parsed.Count,
                isAiGenerated
            });
        });

        app.MapPost("/api/documents/{id:int}/generate-questions", async (int id, GenerateQuestionsRequest req, IConfiguration cfg, FirestoreUserDataStore store, IQuestionGenerationService generator, CancellationToken ct) =>
        {
            var settings = await store.GetSettingsAsync(ct);
            var defaultCount = settings.DefaultGenerateQuestionCount;
            var maxCount = Math.Clamp(cfg.GetValue<int?>("AI:MaxQuestionsPerGeneration") ?? 25, 1, 100);
            var count = Math.Clamp(req.Count <= 0 ? defaultCount : req.Count, 1, maxCount);
            var doc = await store.GetDocumentAsync(id, ct, includeQuestions: true, includeText: true);
            if (doc == null) return Results.NotFound(new { error = "Dokument nicht gefunden." });
            if (!DocumentContentPolicy.CanGenerateQuestions(doc.ContentType, doc.Questions.Count))
                return Results.BadRequest(new { error = "Aus einem bestehenden Test können keine weiteren KI-Fragen generiert werden." });

            List<GeneratedQuestion> generated;
            try
            {
                generated = await generator.GenerateAsync(doc.ExtractedText, count, ct);
            }
            catch (InvalidOperationException ex)
            {
                return Results.BadRequest(new { error = ex.Message });
            }

            var addedQuestions = new List<Question>();
            foreach (var g in generated)
            {
                var q = new Question
                {
                    UploadedDocumentId = id,
                    QuestionText = g.QuestionText,
                    CorrectOptionIndex = g.CorrectOptionIndex,
                    Explanation = g.Explanation,
                    Topic = g.Topic,
                    Difficulty = g.Difficulty,
                    IsAiGenerated = true,
                    Options = g.Options.Select((text, index) => new AnswerOption { Text = text, OptionIndex = index }).ToList()
                };
                q = await store.SaveQuestionAsync(id, q, ct);
                addedQuestions.Add(q);
            }
            return Results.Ok(new
            {
                added = generated.Count,
                total = await store.CountQuestionsAsync(id, ct),
                questionIds = addedQuestions.Select(q => q.Id).ToList()
            });
        });

        return app;
    }
}
