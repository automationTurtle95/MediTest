import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { defineSecret } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";

initializeApp();

setGlobalOptions({
  region: "europe-west3",
  maxInstances: 10
});

const geminiApiKey = defineSecret("GEMINI_API_KEY");

type GenerateQuestionsRequest = {
  messages?: unknown;
  model?: unknown;
  temperature?: unknown;
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

    try {
      await getAuth().verifyIdToken(idToken);
    } catch {
      res.status(401).json({ error: { message: "Firebase-ID-Token ist ungültig oder abgelaufen." } });
      return;
    }

    try {
      const output = await generateQuestions(req.body ?? {});
      if (!output) {
        res.status(502).json({ error: { message: "Gemini hat keine verwertbaren Fragen geliefert." } });
        return;
      }

      res.status(200).json({
        choices: [
          {
            message: {
              role: "assistant",
              content: JSON.stringify(output)
            }
          }
        ]
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unbekannter Genkit-Fehler";
      res.status(502).json({ error: { message } });
    }
  }
);

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
      console.error("Genkit Firebase telemetry could not be enabled.", error);
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
        temperature: z.unknown().optional()
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
        const response = await runtime.ai.generate({
          model: runtime.googleAI.model(normalizeGeminiModel(input.model), { apiKey: geminiApiKey.value() }),
          prompt: buildPrompt(input.messages),
          config: {
            temperature: typeof input.temperature === "number" ? input.temperature : 0.2
          },
          output: {
            schema: runtime.QuestionResponseSchema
          }
        });

        if (!response.output) {
          throw new Error("Gemini hat keine verwertbaren Fragen geliefert.");
        }

        return response.output;
      }
    );
  }

  return generateQuestionsFlow!;
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
