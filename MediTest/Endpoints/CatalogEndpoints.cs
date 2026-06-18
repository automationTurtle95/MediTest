using System.Globalization;
using System.Net;
using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using MediTest;
using MediTest.Dtos;
using MediTest.Models;
using MediTest.Services;
using static MediTest.AppSupport;

namespace MediTest.Endpoints;

public static class CatalogEndpoints
{
    public static IEndpointRouteBuilder MapCatalogEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/api/catalog/tests", async (HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            var client = httpClientFactory.CreateClient();
            var tests = new List<CatalogTestDto>();
            var seenIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            IResult? firstError = null;
            var trialDays = BillingTrialDays(cfg);
            var currency = BillingCurrency(cfg);
            var enforcePurchases = BillingEnforcesCatalogPurchases(cfg);
            var canPublish = UserCanPublishCatalog(context, cfg);
            var licenseState = await store.GetLicenseStateAsync(trialDays, ct);
            var freeCatalogCreditAvailable = FreeCatalogCreditAvailable(licenseState);

            foreach (var collection in CatalogCollections())
            {
                var (json, error) = await SendFirestoreAsync(client, cfg, context, HttpMethod.Get, $"documents/{collection}?pageSize=100", null, "Firestore-Katalog konnte nicht geladen werden.", ct);
                if (error != null)
                {
                    firstError ??= error;
                    continue;
                }

                using var payload = json!;
                if (!payload.RootElement.TryGetProperty("documents", out var documents) || documents.ValueKind != JsonValueKind.Array) continue;
                foreach (var document in documents.EnumerateArray())
                {
                    if (!document.TryGetProperty("fields", out var fields)) continue;
                    var id = FirestoreDocumentId(document);
                    var title = FirestoreString(fields, "title");
                    if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(title)) continue;
                    if (!seenIds.Add(id)) continue;
                    var questionCount = FirestoreInt(fields, "questionCount");
                    if (questionCount <= 0) questionCount = DeserializeCatalogQuestions(FirestoreString(fields, "questionsJson")).Count;
                    var category = CatalogCategory(FirestoreString(fields, "category"));
                    var topic = TopicLabel(FirestoreString(fields, "topic"));
                    var folderPath = CatalogFolderPath(category, FirestoreString(fields, "folderPath"), topic);
                    var storedPriceAmount = FirestoreInt(fields, "priceAmount");
                    var storedPriceCents = FirestoreInt(fields, "priceCents");
                    var priceCents = storedPriceAmount > 0
                        ? storedPriceAmount
                        : storedPriceCents > 0
                            ? storedPriceCents
                        : BillingCatalogTestPriceCents(cfg, category, questionCount);
                    var stripeProductId = FirestoreString(fields, "stripeProductId");
                    var stripePriceId = FirestoreString(fields, "stripePriceId");
                    var productCurrency = FirestoreString(fields, "currency");
                    if (string.IsNullOrWhiteSpace(productCurrency)) productCurrency = currency;
                    var active = FirestoreBool(fields, "active", true);
                    var stripeReady = active &&
                                      stripeProductId.StartsWith("prod_", StringComparison.Ordinal) &&
                                      stripePriceId.StartsWith("price_", StringComparison.Ordinal);
                    var purchased = licenseState.PurchasedCatalogTestIds.Contains(id, StringComparer.OrdinalIgnoreCase);

                    tests.Add(new CatalogTestDto(
                        id,
                        title,
                        FirestoreString(fields, "description"),
                        category,
                        folderPath,
                        topic,
                        FirestoreString(fields, "difficulty"),
                        questionCount,
                        FirestoreString(fields, "appVersion"),
                        FirestoreTimestamp(fields, "publishedAt"),
                        priceCents,
                        productCurrency,
                        purchased,
                        enforcePurchases && !canPublish && !purchased,
                        stripeProductId,
                        stripePriceId,
                        priceCents,
                        FirestoreString(fields, "taxCode"),
                        active,
                        stripeReady));
                }
            }

            if (tests.Count == 0 && firstError != null) return firstError;

            tests = tests
                .OrderBy(t => string.Equals(t.Category, "MedAT", StringComparison.OrdinalIgnoreCase) ? 0 : 1)
                .ThenByDescending(t => t.PublishedAt ?? DateTime.MinValue)
                .ThenBy(t => t.Title)
                .ToList();

            return Results.Ok(new CatalogListDto(
                canPublish,
                freeCatalogCreditAvailable,
                !string.IsNullOrWhiteSpace(licenseState.FreeCatalogCreditRedeemedCatalogId),
                licenseState.FreeCatalogCreditRedeemedCatalogId,
                tests));
        });

        app.MapGet("/api/catalog/tests/{catalogId}/questions", async (string catalogId, HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, CancellationToken ct) =>
        {
            if (!UserCanPublishCatalog(context, cfg))
                return Results.Json(new { error = "Nur Admin-Konten dürfen Katalogfragen bearbeiten." }, statusCode: StatusCodes.Status403Forbidden);

            catalogId = (catalogId ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(catalogId)) return Results.BadRequest(new { error = "Katalog-ID fehlt." });

            var client = httpClientFactory.CreateClient();
            JsonDocument? loadedPayload = null;
            foreach (var collection in CatalogCollections())
            {
                var path = $"documents/{collection}/{Uri.EscapeDataString(catalogId)}";
                var (json, error) = await SendFirestoreAsync(client, cfg, context, HttpMethod.Get, path, null, "Katalogfragen konnten nicht geladen werden.", ct, allowNotFound: true);
                if (error != null) return error;
                if (json == null) continue;
                loadedPayload = json;
                break;
            }

            if (loadedPayload == null) return Results.NotFound(new { error = "Katalogtest nicht gefunden." });
            using var payload = loadedPayload;
            if (!payload.RootElement.TryGetProperty("fields", out var fields))
                return Results.BadRequest(new { error = "Katalogtest enthält keine gültigen Felder." });

            var questions = DeserializeCatalogQuestions(FirestoreString(fields, "questionsJson"))
                .Select((question, index) => new CatalogQuestionDto(
                    index,
                    question.QuestionText,
                    question.Options,
                    question.CorrectOptionIndex,
                    question.Explanation,
                    question.Topic,
                    question.Difficulty,
                    question.IsAiGenerated))
                .ToList();

            return Results.Ok(new CatalogQuestionListDto(
                catalogId,
                FirestoreString(fields, "title"),
                questions.Count,
                questions));
        });

        app.MapPut("/api/catalog/tests/{catalogId}/questions/{questionIndex:int}", async (string catalogId, int questionIndex, UpdateCatalogQuestionRequest req, HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, CancellationToken ct) =>
        {
            if (!UserCanPublishCatalog(context, cfg))
                return Results.Json(new { error = "Nur Admin-Konten dürfen Katalogfragen bearbeiten." }, statusCode: StatusCodes.Status403Forbidden);
            if (string.IsNullOrWhiteSpace(req.QuestionText)) return Results.BadRequest(new { error = "Fragetext fehlt." });
            if (req.Options == null || req.Options.Count is < 2 or > 5 || req.Options.Any(string.IsNullOrWhiteSpace))
                return Results.BadRequest(new { error = "Zwischen 2 und 5 ausgefüllte Antwortmöglichkeiten sind erforderlich." });
            if (req.CorrectOptionIndex < 0 || req.CorrectOptionIndex >= req.Options.Count)
                return Results.BadRequest(new { error = "Die richtige Antwort liegt außerhalb der Antwortmöglichkeiten." });

            catalogId = (catalogId ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(catalogId)) return Results.BadRequest(new { error = "Katalog-ID fehlt." });

            var client = httpClientFactory.CreateClient();
            JsonDocument? loadedPayload = null;
            var collection = string.Empty;
            foreach (var candidate in CatalogCollections())
            {
                var path = $"documents/{candidate}/{Uri.EscapeDataString(catalogId)}";
                var (json, error) = await SendFirestoreAsync(client, cfg, context, HttpMethod.Get, path, null, "Katalogfragen konnten nicht geladen werden.", ct, allowNotFound: true);
                if (error != null) return error;
                if (json == null) continue;
                loadedPayload = json;
                collection = candidate;
                break;
            }

            if (loadedPayload == null) return Results.NotFound(new { error = "Katalogtest nicht gefunden." });
            using var payload = loadedPayload;
            var fields = payload.RootElement.GetProperty("fields");
            var questions = DeserializeCatalogQuestions(FirestoreString(fields, "questionsJson"));
            if (questionIndex < 0 || questionIndex >= questions.Count)
                return Results.NotFound(new { error = "Katalogfrage nicht gefunden." });

            var previous = questions[questionIndex];
            questions[questionIndex] = new CatalogQuestionPayload(
                req.QuestionText.Trim(),
                req.Options.Select(option => option.Trim()).ToList(),
                req.CorrectOptionIndex,
                string.IsNullOrWhiteSpace(req.Explanation) ? "Keine Erklärung hinterlegt." : req.Explanation.Trim(),
                TopicLabel(req.Topic),
                DifficultyLabel(req.Difficulty),
                previous.IsAiGenerated);

            var questionsJson = JsonSerializer.Serialize(questions, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            if (Encoding.UTF8.GetByteCount(questionsJson) > 900_000)
                return Results.BadRequest(new { error = "Der aktualisierte Katalogtest ist für einen einzelnen Firestore-Eintrag zu groß." });

            var user = ToFirebaseUserDto(context.User, cfg);
            var body = new
            {
                fields = new Dictionary<string, object>
                {
                    ["questionsJson"] = FirestoreValue(questionsJson),
                    ["questionCount"] = FirestoreIntValue(questions.Count),
                    ["updatedByUid"] = FirestoreValue(user.UserId),
                    ["updatedByEmail"] = FirestoreValue(user.Email),
                    ["updatedAt"] = FirestoreTimestampValue(DateTime.UtcNow)
                }
            };
            var updateMask = "?updateMask.fieldPaths=questionsJson&updateMask.fieldPaths=questionCount&updateMask.fieldPaths=updatedByUid&updateMask.fieldPaths=updatedByEmail&updateMask.fieldPaths=updatedAt";
            var updatePath = $"documents/{collection}/{Uri.EscapeDataString(catalogId)}{updateMask}";
            var (_, updateError) = await SendFirestoreAsync(client, cfg, context, HttpMethod.Patch, updatePath, body, "Katalogfrage konnte nicht gespeichert werden.", ct);
            if (updateError != null) return updateError;

            var saved = questions[questionIndex];
            return Results.Ok(new
            {
                saved = true,
                question = new CatalogQuestionDto(
                    questionIndex,
                    saved.QuestionText,
                    saved.Options,
                    saved.CorrectOptionIndex,
                    saved.Explanation,
                    saved.Topic,
                    saved.Difficulty,
                    saved.IsAiGenerated)
            });
        });

        app.MapPost("/api/catalog/tests/{catalogId}/download", async (string catalogId, CatalogDownloadRequest req, HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            catalogId = (catalogId ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(catalogId)) return Results.BadRequest(new { error = "Katalog-ID fehlt." });

            var client = httpClientFactory.CreateClient();
            JsonDocument? loadedPayload = null;
            IResult? firstError = null;
            foreach (var collection in CatalogCollections())
            {
                var path = $"documents/{collection}/{Uri.EscapeDataString(catalogId)}";
                var (json, error) = await SendFirestoreAsync(client, cfg, context, HttpMethod.Get, path, null, "Firestore-Test konnte nicht heruntergeladen werden.", ct);
                if (error != null)
                {
                    firstError ??= error;
                    continue;
                }

                loadedPayload = json;
                break;
            }

            if (loadedPayload == null) return firstError ?? Results.NotFound(new { error = "Firestore-Test nicht gefunden." });
            using var payload = loadedPayload;

            if (!payload.RootElement.TryGetProperty("fields", out var fields))
                return Results.BadRequest(new { error = "Firestore-Test enthält keine gültigen Felder." });

            var title = FirestoreString(fields, "title");
            var category = CatalogCategory(FirestoreString(fields, "category"));
            var catalogFolderPath = CatalogFolderPath(category, FirestoreString(fields, "folderPath"), FirestoreString(fields, "topic"));
            var questionsJson = FirestoreString(fields, "questionsJson");
            var questions = DeserializeCatalogQuestions(questionsJson);
            if (questions.Count == 0) return Results.BadRequest(new { error = "Firestore-Test enthält keine gültigen Fragen." });

            var canPublish = UserCanPublishCatalog(context, cfg);
            var licenseState = await store.GetLicenseStateAsync(BillingTrialDays(cfg), ct);
            var purchased = licenseState.PurchasedCatalogTestIds.Contains(catalogId, StringComparer.OrdinalIgnoreCase);
            var consumeFreeCatalogCredit = false;
            if (BillingEnforcesCatalogPurchases(cfg) && !canPublish && !purchased)
            {
                if (FreeCatalogCreditAvailable(licenseState))
                {
                    consumeFreeCatalogCredit = true;
                }
                else
                {
                    return Results.Json(
                        new
                        {
                            error = "Dieser Katalogtest muss zuerst gekauft werden.",
                            checkoutRequired = true,
                            priceCents = BillingCatalogTestPriceCents(cfg, category, questions.Count),
                            currency = BillingCurrency(cfg)
                        },
                        statusCode: StatusCodes.Status402PaymentRequired);
                }
            }

            if (consumeFreeCatalogCredit)
            {
                var consumeUrl = FirebaseFunctionUrl(cfg, "Billing:CatalogCreditConsumptionFunctionUrl", "meditestConsumeCatalogCredit");
                var consumeResult = await SendProtectedFirebaseFunctionAsync(
                    httpClientFactory,
                    context,
                    HttpMethod.Post,
                    consumeUrl,
                    new { catalogId },
                    "Der Gratis-Katalogtest konnte nicht freigeschaltet werden.",
                    ct);
                if (consumeResult.Error != null) return consumeResult.Error;
                consumeResult.Json?.Dispose();
            }

            var documentName = TrimTo(req.DocumentName, 200);
            if (string.IsNullOrWhiteSpace(documentName)) documentName = title;
            if (string.IsNullOrWhiteSpace(documentName)) documentName = "Firestore-Test";

            var doc = new UploadedDocument
            {
                FileName = documentName,
                FolderPath = DocumentFolderPath($"Katalog/{catalogFolderPath}"),
                ContentType = "firestore/catalog-test",
                ExtractedText = $"Aus Firestore heruntergeladener Test: {documentName}",
                FileSizeBytes = Encoding.UTF8.GetByteCount(questionsJson),
                CreatedAt = DateTime.UtcNow
            };
            await store.SaveDocumentAsync(doc, ct);

            foreach (var item in questions)
            {
                await store.SaveQuestionAsync(doc.Id, new Question
                {
                    UploadedDocumentId = doc.Id,
                    QuestionText = item.QuestionText.Trim(),
                    CorrectOptionIndex = Math.Clamp(item.CorrectOptionIndex, 0, item.Options.Count - 1),
                    Explanation = string.IsNullOrWhiteSpace(item.Explanation) ? "Aus Firestore importierte Frage." : item.Explanation.Trim(),
                    Topic = TopicLabel(item.Topic),
                    Difficulty = DifficultyLabel(item.Difficulty),
                    IsAiGenerated = item.IsAiGenerated,
                    CreatedAt = DateTime.UtcNow,
                    Options = item.Options.Select((text, index) => new AnswerOption { Text = text.Trim(), OptionIndex = index }).ToList()
                }, ct);
            }

            return Results.Ok(new CatalogDownloadResult(doc.Id, doc.FileName, questions.Count));
        });

        app.MapPost("/api/catalog/tests/{catalogId}/checkout", async (string catalogId, HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, CancellationToken ct) =>
        {
            catalogId = (catalogId ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(catalogId)) return Results.BadRequest(new { error = "Katalog-ID fehlt." });

            var functionUrl = FirebaseFunctionUrl(cfg, "Billing:CheckoutFunctionUrl", "meditestCreateCheckout");
            var functionResult = await SendProtectedFirebaseFunctionAsync(
                httpClientFactory,
                context,
                HttpMethod.Post,
                functionUrl,
                new { kind = "catalog", catalogId },
                "Der Stripe-Checkout konnte nicht gestartet werden.",
                ct);
            if (functionResult.Error != null) return functionResult.Error;
            using var json = functionResult.Json;
            return Results.Ok(ParseCheckoutLink(json, "Weiterleitung zum Katalogtest-Checkout."));
        });

        app.MapPost("/api/catalog/tests/publish", async (CatalogPublishRequest req, HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            if (!UserCanPublishCatalog(context, cfg))
            {
                return Results.Json(new { error = "Nur Admin-Konten dürfen neue Firestore-Tests veröffentlichen." }, statusCode: StatusCodes.Status403Forbidden);
            }

            var doc = await store.GetDocumentAsync(req.DocumentId, ct, includeQuestions: true, includeText: false);
            if (doc == null) return Results.NotFound(new { error = "Lokaler Fragenpool nicht gefunden." });

            var questions = BuildCatalogQuestions(doc);
            if (questions.Count == 0) return Results.BadRequest(new { error = "Dieser Fragenpool enthält keine veröffentlichbaren Fragen." });

            var title = TrimTo(req.Title, 200);
            if (string.IsNullOrWhiteSpace(title)) title = doc.FileName;
            var description = TrimTo(req.Description, 600);
            var category = CatalogCategory(req.Category);
            var topic = TopicLabel(req.Topic);
            var folderPath = CatalogFolderPath(category, req.FolderPath, topic);
            var difficulty = DifficultyLabel(req.Difficulty);
            var now = DateTime.UtcNow;
            var documentId = $"{Slugify(title)}-{now:yyyyMMddHHmmss}";
            var user = ToFirebaseUserDto(context.User, cfg);
            var questionsJson = JsonSerializer.Serialize(questions, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            if (Encoding.UTF8.GetByteCount(questionsJson) > 900_000)
            {
                return Results.BadRequest(new { error = "Dieser Fragenpool ist für einen einzelnen Firestore-Katalogeintrag zu groß. Bitte teile ihn in kleinere Tests auf." });
            }

            var body = new
            {
                fields = new Dictionary<string, object>
                {
                    ["title"] = FirestoreValue(title),
                    ["description"] = FirestoreValue(description),
                    ["category"] = FirestoreValue(category),
                    ["folderPath"] = FirestoreValue(folderPath),
                    ["topic"] = FirestoreValue(topic),
                    ["difficulty"] = FirestoreValue(difficulty),
                    ["questionCount"] = FirestoreIntValue(questions.Count),
                    ["priceCents"] = FirestoreIntValue(BillingCatalogTestPriceCents(cfg, category, questions.Count)),
                    ["priceAmount"] = FirestoreIntValue(BillingCatalogTestPriceCents(cfg, category, questions.Count)),
                    ["currency"] = FirestoreValue(BillingCurrency(cfg)),
                    ["stripeProductId"] = FirestoreValue(string.Empty),
                    ["stripePriceId"] = FirestoreValue(string.Empty),
                    ["taxCode"] = FirestoreValue(string.Empty),
                    ["active"] = FirestoreBoolValue(true),
                    ["schemaVersion"] = FirestoreIntValue(1),
                    ["appVersion"] = FirestoreValue(AppVersion()),
                    ["questionsJson"] = FirestoreValue(questionsJson),
                    ["createdByUid"] = FirestoreValue(user.UserId),
                    ["createdByEmail"] = FirestoreValue(user.Email),
                    ["publishedAt"] = FirestoreTimestampValue(now),
                    ["updatedAt"] = FirestoreTimestampValue(now)
                }
            };

            var client = httpClientFactory.CreateClient();
            var path = $"documents/catalogTests/{Uri.EscapeDataString(documentId)}";
            var (_, error) = await SendFirestoreAsync(client, cfg, context, HttpMethod.Patch, path, body, "Firestore-Test konnte nicht veröffentlicht werden.", ct);
            if (error != null) return error;

            return Results.Ok(new CatalogPublishResult(documentId, title, questions.Count));
        });

        app.MapPut("/api/catalog/tests/{catalogId}", async (string catalogId, CatalogUpdateRequest req, HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, FirestoreUserDataStore store, CancellationToken ct) =>
        {
            if (!UserCanPublishCatalog(context, cfg))
                return Results.Json(new { error = "Nur Admin-Konten dürfen Katalogtests bearbeiten." }, statusCode: StatusCodes.Status403Forbidden);

            catalogId = (catalogId ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(catalogId)) return Results.BadRequest(new { error = "Katalog-ID fehlt." });

            var client = httpClientFactory.CreateClient();
            JsonDocument? existingJson = null;
            var collection = string.Empty;
            foreach (var candidate in CatalogCollections())
            {
                var candidatePath = $"documents/{candidate}/{Uri.EscapeDataString(catalogId)}";
                var (candidateJson, candidateError) = await SendFirestoreAsync(client, cfg, context, HttpMethod.Get, candidatePath, null, "Katalogtest konnte nicht geladen werden.", ct, allowNotFound: true);
                if (candidateError != null) return candidateError;
                if (candidateJson == null) continue;
                existingJson = candidateJson;
                collection = candidate;
                break;
            }
            if (existingJson == null) return Results.NotFound(new { error = "Katalogtest nicht gefunden." });
            using var existingPayload = existingJson;
            var existingFields = existingPayload.RootElement.GetProperty("fields");

            var doc = await store.GetDocumentAsync(req.DocumentId, ct, includeQuestions: true, includeText: false);
            if (doc == null) return Results.NotFound(new { error = "Lokaler Fragenpool nicht gefunden." });
            var questions = BuildCatalogQuestions(doc);
            if (questions.Count == 0) return Results.BadRequest(new { error = "Dieser Fragenpool enthält keine veröffentlichbaren Fragen." });

            var title = TrimTo(req.Title, 200);
            if (string.IsNullOrWhiteSpace(title)) title = doc.FileName;
            var description = TrimTo(req.Description, 600);
            var category = CatalogCategory(req.Category);
            var topic = TopicLabel(req.Topic);
            var folderPath = CatalogFolderPath(category, req.FolderPath, topic);
            var difficulty = DifficultyLabel(req.Difficulty);
            var now = DateTime.UtcNow;
            var user = ToFirebaseUserDto(context.User, cfg);
            var questionsJson = JsonSerializer.Serialize(questions, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            if (Encoding.UTF8.GetByteCount(questionsJson) > 900_000)
                return Results.BadRequest(new { error = "Dieser Fragenpool ist für einen einzelnen Firestore-Katalogeintrag zu groß." });

            var updatedPriceAmount = BillingCatalogTestPriceCents(cfg, category, questions.Count);
            var previousPriceAmount = FirestoreInt(existingFields, "priceAmount");
            if (previousPriceAmount <= 0) previousPriceAmount = FirestoreInt(existingFields, "priceCents");
            var preserveStripePrice = previousPriceAmount == updatedPriceAmount;
            var body = new
            {
                fields = new Dictionary<string, object>
                {
                    ["title"] = FirestoreValue(title),
                    ["description"] = FirestoreValue(description),
                    ["category"] = FirestoreValue(category),
                    ["folderPath"] = FirestoreValue(folderPath),
                    ["topic"] = FirestoreValue(topic),
                    ["difficulty"] = FirestoreValue(difficulty),
                    ["questionCount"] = FirestoreIntValue(questions.Count),
                    ["priceCents"] = FirestoreIntValue(updatedPriceAmount),
                    ["priceAmount"] = FirestoreIntValue(updatedPriceAmount),
                    ["currency"] = FirestoreValue(FirestoreString(existingFields, "currency") is { Length: > 0 } productCurrency ? productCurrency : BillingCurrency(cfg)),
                    ["stripeProductId"] = FirestoreValue(FirestoreString(existingFields, "stripeProductId")),
                    ["stripePriceId"] = FirestoreValue(preserveStripePrice ? FirestoreString(existingFields, "stripePriceId") : string.Empty),
                    ["taxCode"] = FirestoreValue(FirestoreString(existingFields, "taxCode")),
                    ["active"] = FirestoreBoolValue(FirestoreBool(existingFields, "active", true)),
                    ["schemaVersion"] = FirestoreIntValue(1),
                    ["appVersion"] = FirestoreValue(AppVersion()),
                    ["questionsJson"] = FirestoreValue(questionsJson),
                    ["createdByUid"] = FirestoreValue(FirestoreString(existingFields, "createdByUid") is { Length: > 0 } createdByUid ? createdByUid : user.UserId),
                    ["createdByEmail"] = FirestoreValue(FirestoreString(existingFields, "createdByEmail") is { Length: > 0 } createdByEmail ? createdByEmail : user.Email),
                    ["publishedAt"] = FirestoreTimestampValue(DateTime.TryParse(FirestoreString(existingFields, "publishedAt"), out var publishedAt) ? publishedAt.ToUniversalTime() : now),
                    ["updatedByUid"] = FirestoreValue(user.UserId),
                    ["updatedByEmail"] = FirestoreValue(user.Email),
                    ["updatedAt"] = FirestoreTimestampValue(now)
                }
            };

            var path = $"documents/{collection}/{Uri.EscapeDataString(catalogId)}";
            var (_, error) = await SendFirestoreAsync(client, cfg, context, HttpMethod.Patch, path, body, "Katalogtest konnte nicht aktualisiert werden.", ct);
            if (error != null) return error;
            return Results.Ok(new CatalogPublishResult(catalogId, title, questions.Count));
        });

        app.MapDelete("/api/catalog/tests/{catalogId}", async (string catalogId, HttpContext context, IConfiguration cfg, IHttpClientFactory httpClientFactory, CancellationToken ct) =>
        {
            if (!UserCanPublishCatalog(context, cfg))
                return Results.Json(new { error = "Nur Admin-Konten dürfen Katalogtests löschen." }, statusCode: StatusCodes.Status403Forbidden);

            catalogId = (catalogId ?? string.Empty).Trim();
            if (string.IsNullOrWhiteSpace(catalogId)) return Results.BadRequest(new { error = "Katalog-ID fehlt." });
            var client = httpClientFactory.CreateClient();
            var collection = string.Empty;
            foreach (var candidate in CatalogCollections())
            {
                var candidatePath = $"documents/{candidate}/{Uri.EscapeDataString(catalogId)}";
                var (candidateJson, candidateError) = await SendFirestoreAsync(client, cfg, context, HttpMethod.Get, candidatePath, null, "Katalogtest konnte nicht geladen werden.", ct, allowNotFound: true);
                if (candidateError != null) return candidateError;
                if (candidateJson == null) continue;
                candidateJson.Dispose();
                collection = candidate;
                break;
            }
            if (string.IsNullOrWhiteSpace(collection)) return Results.NotFound(new { error = "Katalogtest nicht gefunden." });
            var path = $"documents/{collection}/{Uri.EscapeDataString(catalogId)}";
            var (_, error) = await SendFirestoreAsync(client, cfg, context, HttpMethod.Delete, path, null, "Katalogtest konnte nicht gelöscht werden.", ct);
            if (error != null) return error;
            return Results.Ok(new { deleted = true, id = catalogId });
        });

        return app;
    }
}
