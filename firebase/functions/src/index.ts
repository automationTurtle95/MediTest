import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { defineInt, defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";

initializeApp();

setGlobalOptions({
  region: "europe-west3",
  maxInstances: 10
});

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const aiMaxQuestionsPerRequest = defineInt("AI_MAX_QUESTIONS_PER_REQUEST", { default: 25 });
const aiDailyQuestionLimit = defineInt("AI_DAILY_QUESTION_LIMIT", { default: 50 });
const aiMonthlyQuestionLimit = defineInt("AI_MONTHLY_QUESTION_LIMIT", { default: 500 });
const aiDailyRequestLimit = defineInt("AI_DAILY_REQUEST_LIMIT", { default: 10 });
const aiCooldownSeconds = defineInt("AI_COOLDOWN_SECONDS", { default: 30 });
const aiUsageRetentionDays = defineInt("AI_USAGE_RETENTION_DAYS", { default: 90 });
const aiMaxPromptChars = defineInt("AI_MAX_PROMPT_CHARS", { default: 50000 });
const db = getFirestore();

type GenerateQuestionsRequest = {
  messages?: unknown;
  model?: unknown;
  temperature?: unknown;
  questionCount?: unknown;
};

type QuestionResponse = {
  questions: Array<{
    questionText: string;
    options: string[];
    correctOptionIndex: number;
    explanation: string;
    topic: string;
    difficulty: "leicht" | "mittel" | "schwer";
  }>;
};

type GenerateQuestionsFlow = (request: GenerateQuestionsRequest) => Promise<QuestionResponse>;
type GenkitRuntime = {
  ai: any;
  googleAI: any;
  QuestionResponseSchema: unknown;
  GenerateQuestionsInputSchema: unknown;
};

type LimitConfiguration = {
  maxQuestionsPerRequest: number;
  dailyQuestionLimit: number;
  monthlyQuestionLimit: number;
  dailyRequestLimit: number;
  cooldownSeconds: number;
  retentionDays: number;
  maxPromptChars: number;
};

type UsageReservation = {
  allowed: boolean;
  eventId: string;
  uid: string;
  dayKey: string;
  monthKey: string;
  startedAtMs: number;
  dailyRemaining: number;
  monthlyRemaining: number;
  code?: string;
  message?: string;
};

let telemetryPromise: Promise<void> | null = null;
let genkitRuntimePromise: Promise<GenkitRuntime> | null = null;
let generateQuestionsFlow: GenerateQuestionsFlow | null = null;

export const meditestAi = onRequest(
  {
    invoker: "public",
    memory: "512MiB",
    secrets: [geminiApiKey],
    timeoutSeconds: 300
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).json({ error: { message: "Nur POST-Anfragen sind erlaubt." } });
      return;
    }

    const idToken = readBearerToken(req.header("authorization") ?? "");
    if (!idToken) {
      res.status(401).json({ error: { message: "Firebase-ID-Token fehlt." } });
      return;
    }

    let user;
    try {
      user = await getAuth().verifyIdToken(idToken);
    } catch {
      res.status(401).json({ error: { message: "Firebase-ID-Token ist ungültig oder abgelaufen." } });
      return;
    }

    const request = (req.body ?? {}) as GenerateQuestionsRequest;
    const requestedQuestions = readRequestedQuestionCount(request);
    if (!requestedQuestions) {
      res.status(400).json({
        error: {
          code: "invalid_question_count",
          message: "Die gewünschte Fragenanzahl fehlt oder ist ungültig."
        }
      });
      return;
    }

    let reservation: UsageReservation;
    try {
      reservation = await reserveUsage(user, request, requestedQuestions);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unbekannter Firestore-Fehler";
      logger.error("AI usage reservation failed", { uid: user.uid, message });
      res.status(503).json({
        error: {
          code: "usage_control_unavailable",
          message: "Die KI-Nutzungskontrolle ist momentan nicht verfügbar. Bitte versuche es später erneut."
        }
      });
      return;
    }

    if (!reservation.allowed) {
      logger.warn("AI generation rejected by usage control", {
        uid: user.uid,
        eventId: reservation.eventId,
        code: reservation.code,
        requestedQuestions
      });
      res.status(reservation.code === "request_limit" ? 400 : 429).json({
        error: {
          code: reservation.code,
          message: reservation.message,
          limits: {
            dailyRemaining: reservation.dailyRemaining,
            monthlyRemaining: reservation.monthlyRemaining
          }
        }
      });
      return;
    }

    logger.info("AI generation accepted", {
      uid: user.uid,
      eventId: reservation.eventId,
      requestedQuestions,
      model: normalizeGeminiModel(request.model)
    });

    try {
      const output = await generateQuestions(request);
      if (!output) {
        throw new Error("Gemini hat keine verwertbaren Fragen geliefert.");
      }

      await finalizeUsage(reservation, "success", output.questions.length);
      res.status(200).json({
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify(output)
            }
          }
        ],
        usageLimits: {
          dailyRemaining: reservation.dailyRemaining,
          monthlyRemaining: reservation.monthlyRemaining
        }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unbekannter Genkit-Fehler";
      await finalizeUsage(reservation, "failed", 0, message);
      logger.error("AI generation failed", {
        uid: user.uid,
        eventId: reservation.eventId,
        requestedQuestions,
        message
      });
      res.status(502).json({ error: { code: "generation_failed", message } });
    }
  }
);

export const meditestAiUsage = onRequest(
  {
    invoker: "public",
    memory: "256MiB",
    timeoutSeconds: 60
  },
  async (req, res) => {
    if (req.method !== "GET") {
      res.set("Allow", "GET").status(405).json({ error: { message: "Nur GET-Anfragen sind erlaubt." } });
      return;
    }

    const idToken = readBearerToken(req.header("authorization") ?? "");
    if (!idToken) {
      res.status(401).json({ error: { message: "Firebase-ID-Token fehlt." } });
      return;
    }

    try {
      const user = await getAuth().verifyIdToken(idToken);
      if (user.admin !== true && user.isAdmin !== true) {
        res.status(403).json({ error: { message: "Nur Administratoren dürfen die KI-Nutzung einsehen." } });
        return;
      }
    } catch {
      res.status(401).json({ error: { message: "Firebase-ID-Token ist ungültig oder abgelaufen." } });
      return;
    }

    const eventLimit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    const [usersSnapshot, eventsSnapshot] = await Promise.all([
      db.collection("aiUsage").orderBy("updatedAt", "desc").limit(100).get(),
      db.collection("aiGenerationEvents").orderBy("createdAt", "desc").limit(eventLimit).get()
    ]);

    res.status(200).json({
      limits: getLimitConfiguration(),
      users: usersSnapshot.docs.map((doc) => serializeFirestoreDocument(doc.id, doc.data())),
      events: eventsSnapshot.docs.map((doc) => serializeFirestoreDocument(doc.id, doc.data()))
    });
  }
);

async function reserveUsage(
  user: { uid: string; email?: string; name?: string },
  request: GenerateQuestionsRequest,
  requestedQuestions: number
): Promise<UsageReservation> {
  const limits = getLimitConfiguration();
  const now = Timestamp.now();
  const nowDate = now.toDate();
  const dayKey = nowDate.toISOString().slice(0, 10);
  const monthKey = dayKey.slice(0, 7);
  const summaryRef = db.collection("aiUsage").doc(user.uid);
  const dayRef = summaryRef.collection("days").doc(dayKey);
  const monthRef = summaryRef.collection("months").doc(monthKey);
  const eventRef = db.collection("aiGenerationEvents").doc();
  const expiresAt = Timestamp.fromMillis(now.toMillis() + limits.retentionDays * 86_400_000);

  return await db.runTransaction(async (transaction) => {
    const [summarySnapshot, daySnapshot, monthSnapshot] = await Promise.all([
      transaction.get(summaryRef),
      transaction.get(dayRef),
      transaction.get(monthRef)
    ]);
    const summary = summarySnapshot.data() ?? {};
    const day = daySnapshot.data() ?? {};
    const month = monthSnapshot.data() ?? {};
    const dayRequested = numberField(day, "requestedQuestions");
    const dayRequests = numberField(day, "requestCount");
    const monthRequested = numberField(month, "requestedQuestions");
    const lastAcceptedAtMs = timestampMillis(summary.lastAcceptedAt);
    const cooldownRemaining = lastAcceptedAtMs
      ? Math.max(0, Math.ceil((lastAcceptedAtMs + limits.cooldownSeconds * 1000 - now.toMillis()) / 1000))
      : 0;

    let code = "";
    let message = "";
    if (requestedQuestions > limits.maxQuestionsPerRequest) {
      code = "request_limit";
      message = `Pro Generierung sind höchstens ${limits.maxQuestionsPerRequest} Fragen erlaubt.`;
    } else if (cooldownRemaining > 0) {
      code = "cooldown";
      message = `Bitte warte noch ${cooldownRemaining} Sekunden bis zur nächsten KI-Generierung.`;
    } else if (dayRequests >= limits.dailyRequestLimit) {
      code = "daily_request_limit";
      message = `Das Tageslimit von ${limits.dailyRequestLimit} KI-Anfragen ist erreicht.`;
    } else if (dayRequested + requestedQuestions > limits.dailyQuestionLimit) {
      code = "daily_question_limit";
      message = `Das Tageslimit von ${limits.dailyQuestionLimit} KI-Fragen würde überschritten.`;
    } else if (monthRequested + requestedQuestions > limits.monthlyQuestionLimit) {
      code = "monthly_question_limit";
      message = `Das Monatslimit von ${limits.monthlyQuestionLimit} KI-Fragen würde überschritten.`;
    }

    const commonEvent = {
      uid: user.uid,
      email: user.email ?? "",
      displayName: user.name ?? "",
      requestedQuestions,
      generatedQuestions: 0,
      model: normalizeGeminiModel(request.model),
      createdAt: now,
      completedAt: code ? now : null,
      expiresAt
    };

    if (code) {
      transaction.set(eventRef, {
        ...commonEvent,
        status: "rejected",
        reason: code,
        message
      });
      transaction.set(summaryRef, {
        uid: user.uid,
        email: user.email ?? "",
        displayName: user.name ?? "",
        totalAttempts: numberField(summary, "totalAttempts") + 1,
        totalRejectedRequests: numberField(summary, "totalRejectedRequests") + 1,
        lastRequestedAt: now,
        lastStatus: "rejected",
        lastReason: code,
        updatedAt: now
      }, { merge: true });

      return {
        allowed: false,
        eventId: eventRef.id,
        uid: user.uid,
        dayKey,
        monthKey,
        startedAtMs: now.toMillis(),
        dailyRemaining: Math.max(0, limits.dailyQuestionLimit - dayRequested),
        monthlyRemaining: Math.max(0, limits.monthlyQuestionLimit - monthRequested),
        code,
        message
      };
    }

    const nextDayRequested = dayRequested + requestedQuestions;
    const nextDayRequests = dayRequests + 1;
    const nextMonthRequested = monthRequested + requestedQuestions;

    transaction.set(eventRef, {
      ...commonEvent,
      status: "started",
      reason: ""
    });
    transaction.set(dayRef, {
      key: dayKey,
      requestCount: nextDayRequests,
      requestedQuestions: nextDayRequested,
      generatedQuestions: numberField(day, "generatedQuestions"),
      successCount: numberField(day, "successCount"),
      failedCount: numberField(day, "failedCount"),
      updatedAt: now
    }, { merge: true });
    transaction.set(monthRef, {
      key: monthKey,
      requestCount: numberField(month, "requestCount") + 1,
      requestedQuestions: nextMonthRequested,
      generatedQuestions: numberField(month, "generatedQuestions"),
      successCount: numberField(month, "successCount"),
      failedCount: numberField(month, "failedCount"),
      updatedAt: now
    }, { merge: true });
    transaction.set(summaryRef, {
      uid: user.uid,
      email: user.email ?? "",
      displayName: user.name ?? "",
      totalAttempts: numberField(summary, "totalAttempts") + 1,
      totalAcceptedRequests: numberField(summary, "totalAcceptedRequests") + 1,
      totalRequestedQuestions: numberField(summary, "totalRequestedQuestions") + requestedQuestions,
      totalGeneratedQuestions: numberField(summary, "totalGeneratedQuestions"),
      lastRequestedAt: now,
      lastAcceptedAt: now,
      lastStatus: "started",
      lastReason: "",
      currentDayKey: dayKey,
      currentDayRequestCount: nextDayRequests,
      currentDayRequestedQuestions: nextDayRequested,
      currentMonthKey: monthKey,
      currentMonthRequestedQuestions: nextMonthRequested,
      updatedAt: now
    }, { merge: true });

    return {
      allowed: true,
      eventId: eventRef.id,
      uid: user.uid,
      dayKey,
      monthKey,
      startedAtMs: now.toMillis(),
      dailyRemaining: Math.max(0, limits.dailyQuestionLimit - nextDayRequested),
      monthlyRemaining: Math.max(0, limits.monthlyQuestionLimit - nextMonthRequested)
    };
  });
}

async function finalizeUsage(
  reservation: UsageReservation,
  status: "success" | "failed",
  generatedQuestions: number,
  errorMessage = ""
): Promise<void> {
  const now = Timestamp.now();
  const summaryRef = db.collection("aiUsage").doc(reservation.uid);
  const dayRef = summaryRef.collection("days").doc(reservation.dayKey);
  const monthRef = summaryRef.collection("months").doc(reservation.monthKey);
  const eventRef = db.collection("aiGenerationEvents").doc(reservation.eventId);
  const batch = db.batch();
  const statusCounter = status === "success" ? "successCount" : "failedCount";

  batch.set(eventRef, {
    status,
    generatedQuestions,
    errorMessage: errorMessage.slice(0, 1000),
    completedAt: now,
    durationMs: Math.max(0, now.toMillis() - reservation.startedAtMs)
  }, { merge: true });
  batch.set(summaryRef, {
    totalGeneratedQuestions: FieldValue.increment(generatedQuestions),
    [statusCounter]: FieldValue.increment(1),
    lastStatus: status,
    lastReason: status === "failed" ? "generation_failed" : "",
    updatedAt: now
  }, { merge: true });
  batch.set(dayRef, {
    generatedQuestions: FieldValue.increment(generatedQuestions),
    [statusCounter]: FieldValue.increment(1),
    updatedAt: now
  }, { merge: true });
  batch.set(monthRef, {
    generatedQuestions: FieldValue.increment(generatedQuestions),
    [statusCounter]: FieldValue.increment(1),
    updatedAt: now
  }, { merge: true });

  try {
    await batch.commit();
  } catch (error) {
    logger.error("AI usage finalization failed", {
      uid: reservation.uid,
      eventId: reservation.eventId,
      message: error instanceof Error ? error.message : String(error)
    });
  }
}

async function generateQuestions(request: GenerateQuestionsRequest) {
  await ensureTelemetryEnabled();
  const flow = await getGenerateQuestionsFlow();
  return flow(request);
}

async function ensureTelemetryEnabled(): Promise<void> {
  if (!telemetryPromise) {
    telemetryPromise = (async () => {
      const { enableFirebaseTelemetry } = await import("@genkit-ai/firebase");
      await enableFirebaseTelemetry({
        metricExportIntervalMillis: 180_000,
        metricExportTimeoutMillis: 180_000
      });
    })().catch((error: unknown) => {
      telemetryPromise = null;
      logger.error("Genkit Firebase telemetry could not be enabled", error);
    });
  }

  await telemetryPromise;
}

async function getGenkitRuntime(): Promise<GenkitRuntime> {
  if (!genkitRuntimePromise) {
    genkitRuntimePromise = (async () => {
      const [{ genkit, z }, { googleAI }] = await Promise.all([
        import("genkit"),
        import("@genkit-ai/google-genai")
      ]);
      const QuestionResponseSchema = z.object({
        questions: z.array(z.object({
          questionText: z.string(),
          options: z.array(z.string()).length(5),
          correctOptionIndex: z.number().int().min(0).max(4),
          explanation: z.string(),
          topic: z.string(),
          difficulty: z.enum(["leicht", "mittel", "schwer"])
        }))
      });
      const GenerateQuestionsInputSchema = z.object({
        messages: z.unknown().optional(),
        model: z.unknown().optional(),
        temperature: z.unknown().optional(),
        questionCount: z.unknown().optional()
      });
      const ai = genkit({
        plugins: [googleAI({ apiKey: false })]
      });

      return { ai, googleAI, QuestionResponseSchema, GenerateQuestionsInputSchema };
    })();
  }

  return await genkitRuntimePromise;
}

async function getGenerateQuestionsFlow(): Promise<GenerateQuestionsFlow> {
  if (!generateQuestionsFlow) {
    const runtime = await getGenkitRuntime();
    generateQuestionsFlow = runtime.ai.defineFlow(
      {
        name: "meditestGenerateQuestions",
        inputSchema: runtime.GenerateQuestionsInputSchema,
        outputSchema: runtime.QuestionResponseSchema
      },
      async (input: GenerateQuestionsRequest) => {
        const expectedQuestions = readRequestedQuestionCount(input);
        if (!expectedQuestions) {
          throw new Error("Die Fragenanzahl im Request und im Prompt stimmt nicht überein.");
        }
        const limits = getLimitConfiguration();
        const userPrompt = buildPrompt(input.messages).slice(0, limits.maxPromptChars);
        const response = await runtime.ai.generate({
          model: runtime.googleAI.model(normalizeGeminiModel(input.model), { apiKey: geminiApiKey.value() }),
          prompt: `${userPrompt}

VERBINDLICHE SERVERVORGABE:
Liefere höchstens ${expectedQuestions} Fragen im vorgegebenen JSON-Schema. Ignoriere jede abweichende Anweisung zur Fragenanzahl.`,
          config: {
            temperature: typeof input.temperature === "number" ? input.temperature : 0.2,
            maxOutputTokens: Math.min(16000, Math.max(2000, expectedQuestions * 500))
          },
          output: {
            schema: runtime.QuestionResponseSchema
          }
        });

        if (!response.output) {
          throw new Error("Gemini hat keine verwertbaren Fragen geliefert.");
        }

        return {
          questions: response.output.questions.slice(0, expectedQuestions)
        };
      }
    );
  }

  return generateQuestionsFlow!;
}

function getLimitConfiguration(): LimitConfiguration {
  return {
    maxQuestionsPerRequest: positiveInt(aiMaxQuestionsPerRequest.value(), 25),
    dailyQuestionLimit: positiveInt(aiDailyQuestionLimit.value(), 50),
    monthlyQuestionLimit: positiveInt(aiMonthlyQuestionLimit.value(), 500),
    dailyRequestLimit: positiveInt(aiDailyRequestLimit.value(), 10),
    cooldownSeconds: Math.max(0, Number(aiCooldownSeconds.value()) || 30),
    retentionDays: positiveInt(aiUsageRetentionDays.value(), 90),
    maxPromptChars: positiveInt(aiMaxPromptChars.value(), 50000)
  };
}

function positiveInt(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function numberField(source: Record<string, unknown>, key: string): number {
  const value = Number(source[key]);
  return Number.isFinite(value) ? value : 0;
}

function timestampMillis(value: unknown): number {
  return value instanceof Timestamp ? value.toMillis() : 0;
}

function readRequestedQuestionCount(request: GenerateQuestionsRequest): number {
  const explicitCount = Number(request.questionCount);
  const prompt = buildPrompt(request.messages);
  const match = prompt.match(/Erzeuge\s+(\d{1,3})\s+hochwertige/i);
  const promptCount = match ? positiveInt(match[1], 0) : 0;
  const validExplicitCount = Number.isInteger(explicitCount) && explicitCount > 0 ? explicitCount : 0;

  if (validExplicitCount && promptCount && validExplicitCount !== promptCount) return 0;
  return validExplicitCount || promptCount;
}

function serializeFirestoreDocument(id: string, data: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    ...Object.fromEntries(Object.entries(data).map(([key, value]) => [key, serializeFirestoreValue(value)]))
  };
}

function serializeFirestoreValue(value: unknown): unknown {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serializeFirestoreValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, nestedValue]) => [key, serializeFirestoreValue(nestedValue)])
    );
  }
  return value;
}

function readBearerToken(authorization: string): string {
  const prefix = "Bearer ";
  return authorization.toLowerCase().startsWith(prefix.toLowerCase())
    ? authorization.slice(prefix.length).trim()
    : "";
}

function normalizeGeminiModel(model: unknown): string {
  const value = typeof model === "string" ? model.trim() : "";
  return value.startsWith("gemini-") ? value : "gemini-2.5-flash";
}

function buildPrompt(messages: unknown): string {
  if (!Array.isArray(messages)) {
    return "";
  }

  return messages
    .map((message) => {
      if (!message || typeof message !== "object") return "";
      const item = message as { role?: unknown; content?: unknown };
      const role = typeof item.role === "string" ? item.role : "user";
      const content = typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");
      return `${role.toUpperCase()}:\n${content}`;
    })
    .filter((text) => text.trim().length > 0)
    .join("\n\n");
}
