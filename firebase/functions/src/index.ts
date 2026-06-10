import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { defineInt, defineSecret, defineString } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { createHash } from "node:crypto";
import Stripe from "stripe";

initializeApp();

setGlobalOptions({
  region: "europe-west3",
  maxInstances: 10
});

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const stripeApiKey = defineSecret("MEDITEST_STRIPE_API_KEY");
const stripeWebhookSecret = defineSecret("MEDITEST_STRIPE_WEBHOOK_SECRET");
const aiMaxQuestionsPerRequest = defineInt("AI_MAX_QUESTIONS_PER_REQUEST", { default: 25 });
const aiDailyQuestionLimit = defineInt("AI_DAILY_QUESTION_LIMIT", { default: 50 });
const aiMonthlyQuestionLimit = defineInt("AI_MONTHLY_QUESTION_LIMIT", { default: 500 });
const aiDailyRequestLimit = defineInt("AI_DAILY_REQUEST_LIMIT", { default: 10 });
const aiCooldownSeconds = defineInt("AI_COOLDOWN_SECONDS", { default: 30 });
const aiUsageRetentionDays = defineInt("AI_USAGE_RETENTION_DAYS", { default: 90 });
const aiMaxPromptChars = defineInt("AI_MAX_PROMPT_CHARS", { default: 50000 });
const freeCatalogCodeHashList = defineString("FREE_CATALOG_CODE_HASHES", {
  default: ""
});
const premiumCodeHashList = defineString("PREMIUM_CODE_HASHES", {
  default: ""
});
const billingTrialDays = defineInt("BILLING_TRIAL_DAYS", { default: 7 });
const billingMonthlyPriceCents = defineInt("BILLING_MONTHLY_PRICE_CENTS", { default: 999 });
const billingCatalogQuestionPriceCents = defineInt("BILLING_CATALOG_QUESTION_PRICE_CENTS", { default: 10 });
const billingCatalogPriceEndingCents = defineInt("BILLING_CATALOG_PRICE_ENDING_CENTS", { default: 9 });
const billingCurrency = defineString("BILLING_CURRENCY", { default: "EUR" });
const billingReturnBaseUrl = defineString("BILLING_RETURN_BASE_URL", { default: "http://127.0.0.1:55000" });
const billingWebsiteBaseUrl = defineString("BILLING_WEBSITE_BASE_URL", {
  default: "https://meditest-12354.web.app"
});
const stripeCustomersCollection = defineString("STRIPE_CUSTOMERS_COLLECTION", { default: "customers" });
const stripeCatalogUnitPriceId = defineString("STRIPE_CATALOG_UNIT_PRICE_ID", { default: "not-configured" });
const stripeCatalogEndingPriceId = defineString("STRIPE_CATALOG_ENDING_PRICE_ID", { default: "not-configured" });
const stripePortalConfigurationId = defineString("STRIPE_PORTAL_CONFIGURATION_ID", { default: "not-configured" });
const windowsDownloadUrl = defineString("WINDOWS_DOWNLOAD_URL", {
  default: "https://github.com/automationTurtle95/MediTest/releases/download/v5.0.1/MediTest-Setup-5.0.1-win-x64.msi"
});
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

type LicenseState = {
  trialStartedAt: string;
  trialEndsAt: string;
  subscriptionActive: boolean;
  subscriptionRenewsAt: string | null;
  subscriptionProvider: string;
  subscriptionCustomerId: string;
  premiumActive: boolean;
  premiumGrantedAt: string | null;
  premiumProvider: string;
  premiumCodeHash: string;
  freeCatalogCreditActive: boolean;
  freeCatalogCreditGrantedAt: string | null;
  freeCatalogCreditCodeHash: string;
  freeCatalogCreditRedeemedCatalogId: string;
  freeCatalogCreditRedeemedAt: string | null;
  purchasedCatalogTestIds: string[];
  updatedAt: string;
};

type GlobalAppConfig = {
  currentAppVersion: string;
  currentTermsVersion: string;
  currentPrivacyVersion: string;
  allowedOfflineDays: number;
  supportEmail: string;
  termsOfUseUrl: string;
  privacyPolicyUrl: string;
  impressumUrl: string;
  licenseAgreementUrl: string;
  defaultMaxDevices: number;
  trialDurationDays: number;
};

type CommercialLicense = {
  userId: string;
  userEmail: string;
  licenseType: string;
  licenseStatus: string;
  licenseStartDate: string | null;
  licenseEndDate: string | null;
  maxDevices: number;
  currentDeviceCount: number;
  lastLicenseCheck: string;
  serverValidationRequired: boolean;
  managedBy: string;
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
      res.status(401).json({ error: { message: "Anmeldetoken fehlt." } });
      return;
    }

    let user;
    try {
      user = await getAuth().verifyIdToken(idToken);
    } catch {
      res.status(401).json({ error: { message: "Anmeldetoken ist ungültig oder abgelaufen." } });
      return;
    }

    const request = (req.body ?? {}) as GenerateQuestionsRequest;
    if (user.email_verified !== true) {
      res.status(403).json({ error: { message: "Bitte bestätige zuerst deine E-Mail-Adresse." } });
      return;
    }

    const entitlement = await cloudEntitlement(user);
    if (!entitlement.allowed) {
      res.status(403).json({
        error: {
          code: "license_required",
          message: entitlement.message
        }
      });
      return;
    }

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
        throw new Error("Der KI-Dienst hat keine verwertbaren Fragen geliefert.");
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
      res.status(502).json({
        error: {
          code: "generation_failed",
          message: "Die KI-Generierung konnte nicht abgeschlossen werden. Bitte versuche es später erneut oder wähle weniger Fragen."
        }
      });
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
      res.status(401).json({ error: { message: "Anmeldetoken fehlt." } });
      return;
    }

    try {
      const user = await getAuth().verifyIdToken(idToken);
      if (user.email_verified !== true) {
        res.status(403).json({ error: { message: "Bitte bestätige zuerst deine E-Mail-Adresse." } });
        return;
      }
      if (user.admin !== true && user.isAdmin !== true) {
        res.status(403).json({ error: { message: "Nur Administratoren dürfen die KI-Nutzung einsehen." } });
        return;
      }
    } catch {
      res.status(401).json({ error: { message: "Anmeldetoken ist ungültig oder abgelaufen." } });
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

export const meditestAiStatus = onRequest(
  {
    invoker: "public",
    memory: "256MiB",
    timeoutSeconds: 30
  },
  async (req, res) => {
    if (req.method !== "GET") {
      res.set("Allow", "GET").status(405).json({ error: { message: "Nur GET-Anfragen sind erlaubt." } });
      return;
    }

    const idToken = readBearerToken(req.header("authorization") ?? "");
    if (!idToken) {
      res.status(401).json({ error: { message: "Anmeldetoken fehlt." } });
      return;
    }

    let user;
    try {
      user = await getAuth().verifyIdToken(idToken);
    } catch {
      res.status(401).json({ error: { message: "Anmeldetoken ist ungültig oder abgelaufen." } });
      return;
    }

    const limits = getLimitConfiguration();
    if (user.email_verified !== true) {
      res.status(403).json({ error: { message: "Bitte bestätige zuerst deine E-Mail-Adresse." } });
      return;
    }

    const now = Timestamp.now();
    const dayKey = now.toDate().toISOString().slice(0, 10);
    const monthKey = dayKey.slice(0, 7);
    const summaryRef = db.collection("aiUsage").doc(user.uid);
    const [summarySnapshot, daySnapshot, monthSnapshot] = await Promise.all([
      summaryRef.get(),
      summaryRef.collection("days").doc(dayKey).get(),
      summaryRef.collection("months").doc(monthKey).get()
    ]);
    const summary = summarySnapshot.data() ?? {};
    const day = daySnapshot.data() ?? {};
    const month = monthSnapshot.data() ?? {};
    const dailyQuestionsUsed = numberField(day, "requestedQuestions");
    const dailyRequestsUsed = numberField(day, "requestCount");
    const monthlyQuestionsUsed = numberField(month, "requestedQuestions");
    const lastAcceptedAtMs = timestampMillis(summary.lastAcceptedAt);
    const cooldownRemainingSeconds = lastAcceptedAtMs
      ? Math.max(0, Math.ceil((lastAcceptedAtMs + limits.cooldownSeconds * 1000 - now.toMillis()) / 1000))
      : 0;

    res.status(200).json({
      limits,
      usage: {
        dailyQuestionsUsed,
        dailyQuestionsRemaining: Math.max(0, limits.dailyQuestionLimit - dailyQuestionsUsed),
        dailyRequestsUsed,
        dailyRequestsRemaining: Math.max(0, limits.dailyRequestLimit - dailyRequestsUsed),
        monthlyQuestionsUsed,
        monthlyQuestionsRemaining: Math.max(0, limits.monthlyQuestionLimit - monthlyQuestionsUsed),
        cooldownRemainingSeconds,
        totalGeneratedQuestions: numberField(summary, "totalGeneratedQuestions"),
        lastStatus: typeof summary.lastStatus === "string" ? summary.lastStatus : "",
        updatedAt: serializeFirestoreValue(summary.updatedAt)
      }
    });
  }
);

export const meditestLicenseStatus = onRequest(
  {
    invoker: "public",
    memory: "256MiB",
    timeoutSeconds: 30
  },
  async (req, res) => {
    if (req.method !== "GET") {
      res.set("Allow", "GET").status(405).json({ error: { message: "Nur GET-Anfragen sind erlaubt." } });
      return;
    }

    const user = await verifiedUser(req.header("authorization") ?? "", res);
    if (!user) return;

    const state = await ensureLicenseState(user.uid);
    res.status(200).json({ state });
  }
);

export const meditestDownloadAccess = onRequest(
  {
    invoker: "public",
    memory: "256MiB",
    timeoutSeconds: 30
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).json({ error: { message: "Nur POST-Anfragen sind erlaubt." } });
      return;
    }

    const user = await verifiedUser(req.header("authorization") ?? "", res);
    if (!user) return;

    const state = await ensureLicenseState(user.uid);
    const downloadAllowed = user.admin === true ||
      user.isAdmin === true ||
      state.premiumActive ||
      state.subscriptionActive;
    if (!downloadAllowed) {
      res.status(403).json({
        error: {
          message: "Der Windows-Download wird nach erfolgreichem Kauf freigeschaltet."
        }
      });
      return;
    }

    res.status(200).json({
      platform: "windows-x64",
      version: "5.0.1",
      fileName: "MediTest-Setup-5.0.1-win-x64.msi",
      url: windowsDownloadUrl.value().trim()
    });
  }
);

export const meditestLicenseAccess = onRequest(
  {
    invoker: "public",
    memory: "256MiB",
    timeoutSeconds: 30
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).json({ error: { message: "Nur POST-Anfragen sind erlaubt." } });
      return;
    }

    const user = await verifiedUser(req.header("authorization") ?? "", res);
    if (!user) return;

    const action = stringValue(req.body?.action) || "check";
    const deviceId = stringValue(req.body?.deviceId).toLowerCase();
    const deviceName = stringValue(req.body?.deviceName).slice(0, 200);
    const appVersion = stringValue(req.body?.appVersion).slice(0, 40) || "0.0.0";
    if (!/^[a-f0-9]{64}$/.test(deviceId)) {
      res.status(400).json({ error: { message: "Die Geräte-ID ist ungültig." } });
      return;
    }

    try {
      const appConfig = await ensureGlobalAppConfig();
      const billingState = await ensureLicenseState(user.uid);
      const userStatus = await ensureCommercialUser(user);
      let license = await ensureCommercialLicense(user, billingState, appConfig);

      if (action === "acceptTerms") {
        if (req.body?.acceptTerms !== true || req.body?.acceptPrivacy !== true) {
          res.status(400).json({ error: { message: "AGB und Datenschutzerklärung müssen beide akzeptiert werden." } });
          return;
        }
        await saveTermsAcceptance(user, deviceId, appVersion, appConfig);
      } else if (action === "activateDevice") {
        await activateDevice(user.uid, deviceId, deviceName, appVersion);
      } else if (action === "check") {
        const currentDevice = await db.doc(`deviceActivations/${user.uid}/devices/${deviceId}`).get();
        const deviceEligible = (license.licenseStatus === "active" || license.licenseStatus === "trial") &&
          (!license.licenseEndDate || Date.parse(license.licenseEndDate) > Date.now());
        if (!currentDevice.exists && deviceEligible && !userStatus.isBlocked) {
          try {
            await activateDevice(user.uid, deviceId, deviceName, appVersion);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "device_limit_reached") throw error;
          }
        } else if (currentDevice.exists) {
          await currentDevice.ref.set({
            lastUsedAt: Timestamp.now(),
            appVersion
          }, { merge: true });
        }
      } else {
        res.status(400).json({ error: { message: "Unbekannte Lizenzaktion." } });
        return;
      }

      const [deviceSnapshot, termsSnapshot, licenseSnapshot] = await Promise.all([
        db.doc(`deviceActivations/${user.uid}/devices/${deviceId}`).get(),
        db.doc(`termsAcceptances/${user.uid}`).get(),
        db.doc(`licenses/${user.uid}`).get()
      ]);
      license = commercialLicenseFromData(user.uid, stringValue(user.email), licenseSnapshot.data() ?? {}, appConfig);
      const terms = termsAcceptanceResponse(termsSnapshot.data());
      const device = deviceActivationResponse(deviceSnapshot.data());
      const result = evaluateCommercialAccess(userStatus, license, !!device, terms, appConfig);

      await db.doc(`licenses/${user.uid}`).set({
        lastLicenseCheck: Timestamp.now()
      }, { merge: true });

      res.status(200).json({
        appConfig,
        user: userStatus,
        license,
        device,
        termsAcceptance: terms,
        result,
        online: true,
        isOfflineMode: false,
        lastSuccessfulOnlineCheck: new Date().toISOString()
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "device_limit_reached") {
        res.status(409).json({ error: { message: "Maximale Geräteanzahl erreicht." } });
        return;
      }
      if (code === "license_not_active") {
        res.status(409).json({ error: { message: "Keine gültige Lizenz gefunden." } });
        return;
      }
      logger.error("License access failed", {
        uid: user.uid,
        action,
        message: code || String(error)
      });
      res.status(503).json({ error: { message: "Die Lizenzprüfung ist momentan nicht erreichbar." } });
    }
  }
);

export const meditestRedeemPremiumCode = onRequest(
  {
    invoker: "public",
    memory: "256MiB",
    timeoutSeconds: 30
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).json({ error: { message: "Nur POST-Anfragen sind erlaubt." } });
      return;
    }

    const user = await verifiedUser(req.header("authorization") ?? "", res);
    if (!user) return;

    const normalizedCode = normalizeAccessCode(req.body?.code);
    const codeHash = hashAccessCode(normalizedCode);
    if (!normalizedCode || !configuredPremiumCodeHashes().has(codeHash)) {
      res.status(400).json({ error: { message: "Dieser Premium-Code ist ungültig." } });
      return;
    }

    const state = await updateLicenseState(user.uid, (current) => {
      const now = new Date().toISOString();
      current.premiumActive = true;
      current.premiumGrantedAt ||= now;
      current.premiumProvider = "premium-code";
      current.premiumCodeHash = codeHash;
      return current;
    });
    res.status(200).json({ state, message: "Premium wurde aktiviert." });
  }
);

export const meditestConsumeCatalogCredit = onRequest(
  {
    invoker: "public",
    memory: "256MiB",
    timeoutSeconds: 30
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).json({ error: { message: "Nur POST-Anfragen sind erlaubt." } });
      return;
    }

    const user = await verifiedUser(req.header("authorization") ?? "", res);
    if (!user) return;
    const catalogId = stringValue(req.body?.catalogId).slice(0, 200);
    if (!catalogId) {
      res.status(400).json({ error: { message: "Katalog-ID fehlt." } });
      return;
    }

    try {
      const state = await updateLicenseState(user.uid, (current) => {
        if (current.premiumActive || current.purchasedCatalogTestIds.includes(catalogId)) return current;
        if (!current.freeCatalogCreditActive || current.freeCatalogCreditRedeemedCatalogId) {
          throw new Error("catalog_credit_unavailable");
        }

        current.freeCatalogCreditActive = false;
        current.freeCatalogCreditRedeemedCatalogId = catalogId;
        current.freeCatalogCreditRedeemedAt = new Date().toISOString();
        current.purchasedCatalogTestIds.push(catalogId);
        return current;
      });
      res.status(200).json({ state, consumed: true });
    } catch (error) {
      if (error instanceof Error && error.message === "catalog_credit_unavailable") {
        res.status(409).json({ error: { message: "Für dieses Konto ist kein Gratis-Katalogtest verfügbar." } });
        return;
      }
      throw error;
    }
  }
);

export const meditestCreateCheckout = onRequest(
  {
    invoker: "public",
    memory: "256MiB",
    secrets: [stripeApiKey],
    timeoutSeconds: 60
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).json({ error: { message: "Nur POST-Anfragen sind erlaubt." } });
      return;
    }

    const user = await verifiedUser(req.header("authorization") ?? "", res);
    if (!user) return;
    const kind = stringValue(req.body?.kind).toLowerCase();
    const source = stringValue(req.body?.source).toLowerCase();
    const catalogId = stringValue(req.body?.catalogId).slice(0, 200);
    const returnBaseUrl = billingReturnBaseUrl.value().replace(/\/+$/, "");
    const websiteBaseUrl = billingWebsiteBaseUrl.value().replace(/\/+$/, "");
    const state = await ensureLicenseState(user.uid);
    const stripe = stripeClient();
    const customerId = await ensureStripeCustomer(stripe, user.uid, stringValue(user.email));
    let checkoutData: any;

    if (kind === "subscription") {
      if (state.premiumActive || state.subscriptionActive) {
        res.status(409).json({ error: { message: "Für dieses Konto ist bereits ein Zugang aktiv." } });
        return;
      }
      const subscriptions = await stripe.subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 20
      });
      const activeSubscription = subscriptions.data.find(
        (subscription: any) => subscription.status === "active" || subscription.status === "trialing"
      ) as any;
      if (activeSubscription) {
        await updateLicenseState(user.uid, (current) => {
          current.subscriptionActive = true;
          current.subscriptionRenewsAt = Number.isFinite(Number(activeSubscription.current_period_end))
            ? new Date(Number(activeSubscription.current_period_end) * 1000).toISOString()
            : null;
          current.subscriptionProvider = "stripe";
          current.subscriptionCustomerId = customerId;
          return current;
        });
        res.status(409).json({ error: { message: "Für dieses Konto ist bereits ein Stripe-Abo aktiv." } });
        return;
      }
      await expireOpenCheckoutSessions(
        stripe,
        customerId,
        (session) => session.mode === "subscription"
      );

      const remainingTrialDays = Math.max(
        0,
        Math.ceil((Date.parse(state.trialEndsAt) - Date.now()) / 86_400_000)
      );
      const isLandingCheckout = source === "landing";
      const monthlyPriceCents = Math.max(1, billingMonthlyPriceCents.value());
      const currency = billingCurrency.value().trim().toLowerCase();
      const metadata = {
        meditestPurchaseType: "subscription",
        firebaseUid: user.uid,
        purchaseSource: isLandingCheckout ? "landing" : "app",
        monthlyPriceCents: String(monthlyPriceCents),
        currency: currency.toUpperCase()
      };
      checkoutData = {
        mode: "subscription",
        customer: customerId,
        line_items: [{
          price_data: {
            currency,
            unit_amount: monthlyPriceCents,
            recurring: { interval: "month" },
            product_data: {
              name: "MediTest",
              description: "Monatlicher Zugang zur MediTest Lernsoftware"
            }
          },
          quantity: 1
        }],
        client_reference_id: user.uid,
        success_url: isLandingCheckout
          ? `${websiteBaseUrl}/purchase.html?checkout=success`
          : `${returnBaseUrl}/pages/license.html?checkout=success`,
        cancel_url: isLandingCheckout
          ? `${websiteBaseUrl}/purchase.html?checkout=cancelled`
          : `${returnBaseUrl}/pages/license.html?checkout=cancelled`,
        metadata,
        subscription_data: {
          metadata,
          ...(!isLandingCheckout && remainingTrialDays > 0
            ? { trial_period_days: Math.min(60, remainingTrialDays) }
            : {})
        },
        allow_promotion_codes: false
      };
    } else if (kind === "catalog") {
      if (!catalogId) {
        res.status(400).json({ error: { message: "Katalog-ID fehlt." } });
        return;
      }
      if (state.premiumActive || state.purchasedCatalogTestIds.includes(catalogId)) {
        res.status(409).json({ error: { message: "Dieser Katalogtest ist bereits freigeschaltet." } });
        return;
      }

      const catalog = await findCatalogTest(catalogId);
      if (!catalog) {
        res.status(404).json({ error: { message: "Katalogtest nicht gefunden." } });
        return;
      }
      const isMedAt = catalog.category.toLowerCase() === "medat";
      const unitPriceId = stripeCatalogUnitPriceId.value().trim();
      const endingPriceId = stripeCatalogEndingPriceId.value().trim();
      if (!isMedAt && (!isStripePriceId(unitPriceId) || !isStripePriceId(endingPriceId))) {
        res.status(503).json({ error: { message: "Die Stripe-Preise für Katalogtests sind noch nicht konfiguriert." } });
        return;
      }
      await expireOpenCheckoutSessions(
        stripe,
        customerId,
        (session) => session.mode === "payment" && session.metadata?.catalogId === catalogId
      );

      const expectedPriceCents = isMedAt
        ? catalog.priceCents
        : catalog.questionCount * Math.max(0, billingCatalogQuestionPriceCents.value()) +
          Math.max(0, billingCatalogPriceEndingCents.value());
      const metadata = {
        meditestPurchaseType: "catalog",
        catalogId,
        firebaseUid: user.uid,
        category: catalog.category,
        questionCount: String(catalog.questionCount),
        questionPriceCents: String(Math.max(0, billingCatalogQuestionPriceCents.value())),
        priceEndingCents: String(Math.max(0, billingCatalogPriceEndingCents.value())),
        expectedPriceCents: String(expectedPriceCents),
        currency: catalog.currency
      };
      checkoutData = {
        mode: "payment",
        customer: customerId,
        line_items: isMedAt
          ? [{
            price_data: {
              currency: catalog.currency.toLowerCase(),
              unit_amount: expectedPriceCents,
              product_data: {
                name: catalog.title,
                description: "MediTest MedAT-Katalogtest"
              }
            },
            quantity: 1
          }]
          : [
            { price: unitPriceId, quantity: catalog.questionCount },
            { price: endingPriceId, quantity: 1 }
          ],
        client_reference_id: user.uid,
        success_url: `${returnBaseUrl}/pages/catalog.html?checkout=success&catalogId=${encodeURIComponent(catalogId)}`,
        cancel_url: `${returnBaseUrl}/pages/catalog.html?checkout=cancelled&catalogId=${encodeURIComponent(catalogId)}`,
        metadata,
        payment_intent_data: { metadata }
      };
    } else {
      res.status(400).json({ error: { message: "Unbekannte Checkout-Art." } });
      return;
    }

    const session = await stripe.checkout.sessions.create(checkoutData);
    if (!session.url) {
      res.status(502).json({ error: { message: "Stripe hat keinen Checkout-Link geliefert." } });
      return;
    }
    res.status(200).json({
      available: true,
      url: session.url,
      message: "Weiterleitung zum sicheren Stripe-Checkout."
    });
  }
);

export const meditestStripePortal = onRequest(
  {
    invoker: "public",
    memory: "256MiB",
    secrets: [stripeApiKey],
    timeoutSeconds: 30
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).json({ error: { message: "Nur POST-Anfragen sind erlaubt." } });
      return;
    }
    const user = await verifiedUser(req.header("authorization") ?? "", res);
    if (!user) return;

    const stripe = stripeClient();
    const customerId = await ensureStripeCustomer(stripe, user.uid, stringValue(user.email));
    const configurationId = stripePortalConfigurationId.value().trim();
    if (!configurationId.startsWith("bpc_")) {
      res.status(503).json({ error: { message: "Das Stripe-Kundenportal ist noch nicht konfiguriert." } });
      return;
    }
    const returnUrl = stringValue(req.body?.returnUrl) ||
      `${billingReturnBaseUrl.value().replace(/\/+$/, "")}/pages/license.html`;
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      configuration: configurationId,
      return_url: returnUrl
    });
    res.status(200).json({
      available: true,
      url: session.url,
      message: "Weiterleitung zum Stripe-Kundenportal."
    });
  }
);

export const meditestStripeWebhook = onRequest(
  {
    memory: "256MiB",
    secrets: [stripeApiKey, stripeWebhookSecret],
    timeoutSeconds: 60
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).send("Method not allowed");
      return;
    }
    const signature = req.header("stripe-signature");
    if (!signature) {
      res.status(400).send("Stripe signature missing");
      return;
    }

    let event: any;
    try {
      event = stripeClient().webhooks.constructEvent(req.rawBody, signature, stripeWebhookSecret.value());
    } catch (error) {
      logger.warn("Stripe webhook signature rejected", {
        message: error instanceof Error ? error.message : String(error)
      });
      res.status(400).send("Invalid Stripe signature");
      return;
    }

    try {
      await processStripeEvent(event);
      res.status(200).json({ received: true });
    } catch (error) {
      logger.error("Stripe webhook processing failed", {
        eventId: event.id,
        type: event.type,
        message: error instanceof Error ? error.message : String(error)
      });
      res.status(500).send("Webhook processing failed");
    }
  }
);

export const meditestRedeemCatalogCode = onRequest(
  {
    invoker: "public",
    memory: "256MiB",
    timeoutSeconds: 30
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).json({ error: { message: "Nur POST-Anfragen sind erlaubt." } });
      return;
    }

    const idToken = readBearerToken(req.header("authorization") ?? "");
    if (!idToken) {
      res.status(401).json({ error: { message: "Anmeldetoken fehlt." } });
      return;
    }

    let user;
    try {
      user = await getAuth().verifyIdToken(idToken);
    } catch {
      res.status(401).json({ error: { message: "Anmeldetoken ist ungültig oder abgelaufen." } });
      return;
    }
    if (user.email_verified !== true) {
      res.status(403).json({ error: { message: "Bitte bestätige zuerst deine E-Mail-Adresse." } });
      return;
    }

    const normalizedCode = normalizeAccessCode(req.body?.code);
    const codeHash = hashAccessCode(normalizedCode);
    if (!normalizedCode || !configuredFreeCatalogCodeHashes().has(codeHash)) {
      res.status(400).json({ error: { message: "Dieser Gratis-Katalog-Code ist ungültig." } });
      return;
    }

    try {
      const state = await updateLicenseState(user.uid, (current) => {
        const now = Timestamp.now();
        const alreadyUsed = current.freeCatalogCreditActive ||
          current.freeCatalogCreditRedeemedCatalogId.length > 0 ||
          current.freeCatalogCreditCodeHash.length > 0;
        if (alreadyUsed) {
          throw new Error("account_already_used_catalog_code");
        }

        current.freeCatalogCreditActive = true;
        current.freeCatalogCreditGrantedAt ||= now.toDate().toISOString();
        current.freeCatalogCreditCodeHash = codeHash;
        return current;
      });
      res.status(200).json({
        redeemed: true,
        state,
        message: "Gratis-Test wurde aktiviert."
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "account_already_used_catalog_code") {
        res.status(409).json({ error: { message: "Für dieses Konto wurde bereits ein Gratis-Katalog-Code verwendet." } });
        return;
      }
      logger.error("Catalog code redemption failed", { uid: user.uid, message: code });
      res.status(503).json({ error: { message: "Der Gratis-Katalog-Code konnte momentan nicht eingelöst werden." } });
      return;
    }
  }
);

export const meditestDeleteAccount = onRequest(
  {
    invoker: "public",
    memory: "256MiB",
    secrets: [stripeApiKey],
    timeoutSeconds: 120
  },
  async (req, res) => {
    if (req.method !== "DELETE") {
      res.set("Allow", "DELETE").status(405).json({ error: { message: "Nur DELETE-Anfragen sind erlaubt." } });
      return;
    }

    const idToken = readBearerToken(req.header("authorization") ?? "");
    if (!idToken) {
      res.status(401).json({ error: { message: "Anmeldetoken fehlt." } });
      return;
    }

    let user;
    try {
      user = await getAuth().verifyIdToken(idToken);
    } catch {
      res.status(401).json({ error: { message: "Anmeldetoken ist ungültig oder abgelaufen." } });
      return;
    }

    try {
      const userRef = db.collection("users").doc(user.uid);
      const licenseRef = db.collection("licenses").doc(user.uid);
      const deviceRef = db.collection("deviceActivations").doc(user.uid);
      const termsRef = db.collection("termsAcceptances").doc(user.uid);
      const customerRef = db.collection(stripeCustomersCollection.value()).doc(user.uid);
      const aiUsageRef = db.collection("aiUsage").doc(user.uid);
      const eventsSnapshot = await db.collection("aiGenerationEvents").where("uid", "==", user.uid).get();
      const customerData = (await customerRef.get()).data() ?? {};
      if (typeof customerData.stripeId === "string" && customerData.stripeId) {
        await stripeClient().customers.del(customerData.stripeId);
      }

      await Promise.all([
        db.recursiveDelete(userRef),
        db.recursiveDelete(deviceRef),
        licenseRef.delete(),
        termsRef.delete(),
        db.recursiveDelete(customerRef),
        db.recursiveDelete(aiUsageRef),
        deleteDocuments(eventsSnapshot.docs.map((doc) => doc.ref))
      ]);
      await getAuth().deleteUser(user.uid);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unbekannter Fehler";
      logger.error("Account deletion failed", { uid: user.uid, message });
      res.status(503).json({
        error: {
          message: "Das Konto konnte nicht vollständig gelöscht werden. Bitte versuche es später erneut."
        }
      });
      return;
    }

    res.status(200).json({
      deleted: true,
      message: "Konto und zugehörige Nutzerdaten wurden gelöscht."
    });
  }
);

async function ensureGlobalAppConfig(): Promise<GlobalAppConfig> {
  const ref = db.doc("appConfig/global");
  const snapshot = await ref.get();
  const source = snapshot.data() ?? {};
  const config: GlobalAppConfig = {
    currentAppVersion: stringValue(source.currentAppVersion) || "5.0.1",
    currentTermsVersion: stringValue(source.currentTermsVersion) || "5.0",
    currentPrivacyVersion: stringValue(source.currentPrivacyVersion) || "5.0",
    allowedOfflineDays: boundedInt(source.allowedOfflineDays, 7, 0, 30),
    supportEmail: stringValue(source.supportEmail),
    termsOfUseUrl: safeHttpUrl(source.termsOfUseUrl),
    privacyPolicyUrl: safeHttpUrl(source.privacyPolicyUrl),
    impressumUrl: safeHttpUrl(source.impressumUrl),
    licenseAgreementUrl: safeHttpUrl(source.licenseAgreementUrl),
    defaultMaxDevices: boundedInt(source.defaultMaxDevices, 2, 1, 20),
    trialDurationDays: boundedInt(source.trialDurationDays, 7, 1, 60)
  };
  if (!snapshot.exists) {
    await ref.set({
      ...config,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    });
  }
  return config;
}

async function ensureCommercialUser(user: any): Promise<{
  userId: string;
  email: string;
  displayName: string;
  role: string;
  isBlocked: boolean;
}> {
  const ref = db.doc(`users/${user.uid}`);
  const snapshot = await ref.get();
  const existing = snapshot.data() ?? {};
  const role = user.admin === true || user.isAdmin === true
    ? "admin"
    : stringValue(existing.role) || "user";
  const data = {
    email: stringValue(user.email),
    displayName: stringValue(user.name) || stringValue(existing.displayName),
    createdAt: existing.createdAt ?? Timestamp.now(),
    lastLoginAt: Timestamp.now(),
    role,
    isBlocked: existing.isBlocked === true
  };
  await ref.set(data, { merge: true });
  return {
    userId: user.uid,
    email: data.email,
    displayName: data.displayName,
    role,
    isBlocked: data.isBlocked
  };
}

async function ensureCommercialLicense(
  user: any,
  billing: LicenseState,
  config: GlobalAppConfig
): Promise<CommercialLicense> {
  const ref = db.doc(`licenses/${user.uid}`);
  const snapshot = await ref.get();
  const existing = snapshot.data() ?? {};
  if (stringValue(existing.managedBy).toLowerCase() === "manual") {
    const manual = commercialLicenseFromData(user.uid, stringValue(user.email), existing, config);
    await ref.set({
      userEmail: manual.userEmail,
      lastLicenseCheck: Timestamp.now()
    }, { merge: true });
    return manual;
  }

  const now = Date.now();
  const admin = user.admin === true || user.isAdmin === true;
  const premium = billing.premiumActive;
  const subscription = billing.subscriptionActive;
  const trialActive = Date.parse(billing.trialEndsAt) > now;
  const licenseType = admin ? "Admin" :
    premium ? "Lifetime" :
      subscription ? "Subscription" : "Trial";
  const licenseStatus = admin || premium || subscription ? "active" :
    trialActive ? "trial" : "expired";
  const licenseEndDate = admin || premium ? null :
    subscription ? billing.subscriptionRenewsAt : billing.trialEndsAt;
  const maxDevices = boundedInt(existing.maxDevices, config.defaultMaxDevices, 1, 20);
  const currentDeviceCount = boundedInt(existing.currentDeviceCount, 0, 0, maxDevices);
  const data = {
    userId: user.uid,
    userEmail: stringValue(user.email),
    licenseType,
    licenseStatus,
    licenseStartDate: Timestamp.fromDate(new Date(billing.trialStartedAt)),
    licenseEndDate: licenseEndDate ? Timestamp.fromDate(new Date(licenseEndDate)) : null,
    maxDevices,
    currentDeviceCount,
    lastLicenseCheck: Timestamp.now(),
    serverValidationRequired: existing.serverValidationRequired === true,
    managedBy: "billing",
    updatedAt: Timestamp.now()
  };
  await ref.set(data, { merge: true });
  return commercialLicenseFromData(user.uid, stringValue(user.email), data, config);
}

async function activateDevice(
  userId: string,
  deviceId: string,
  deviceName: string,
  appVersion: string
): Promise<void> {
  const licenseRef = db.doc(`licenses/${userId}`);
  const deviceRef = db.doc(`deviceActivations/${userId}/devices/${deviceId}`);
  await db.runTransaction(async (transaction) => {
    const [licenseSnapshot, deviceSnapshot] = await Promise.all([
      transaction.get(licenseRef),
      transaction.get(deviceRef)
    ]);
    const license = licenseSnapshot.data() ?? {};
    const status = stringValue(license.licenseStatus).toLowerCase();
    if (status !== "active" && status !== "trial") throw new Error("license_not_active");

    const maxDevices = boundedInt(license.maxDevices, 1, 1, 20);
    const currentDeviceCount = boundedInt(license.currentDeviceCount, 0, 0, maxDevices);
    if (!deviceSnapshot.exists && currentDeviceCount >= maxDevices)
      throw new Error("device_limit_reached");

    const now = Timestamp.now();
    transaction.set(deviceRef, {
      deviceId,
      deviceName: deviceName || "Unbenanntes Gerät",
      firstActivatedAt: deviceSnapshot.data()?.firstActivatedAt ?? now,
      lastUsedAt: now,
      appVersion
    }, { merge: true });
    if (!deviceSnapshot.exists) {
      transaction.set(licenseRef, {
        currentDeviceCount: currentDeviceCount + 1,
        updatedAt: now
      }, { merge: true });
    }
  });
}

async function saveTermsAcceptance(
  user: any,
  deviceId: string,
  appVersion: string,
  config: GlobalAppConfig
): Promise<void> {
  await db.doc(`termsAcceptances/${user.uid}`).set({
    userId: user.uid,
    userEmail: stringValue(user.email),
    termsVersion: config.currentTermsVersion,
    privacyVersion: config.currentPrivacyVersion,
    acceptedAt: Timestamp.now(),
    appVersion,
    deviceId
  });
}

function commercialLicenseFromData(
  userId: string,
  email: string,
  source: Record<string, any>,
  config: GlobalAppConfig
): CommercialLicense {
  return {
    userId,
    userEmail: stringValue(source.userEmail) || email,
    licenseType: stringValue(source.licenseType) || "Free",
    licenseStatus: stringValue(source.licenseStatus) || "inactive",
    licenseStartDate: dateValue(source.licenseStartDate),
    licenseEndDate: dateValue(source.licenseEndDate),
    maxDevices: boundedInt(source.maxDevices, config.defaultMaxDevices, 1, 20),
    currentDeviceCount: boundedInt(source.currentDeviceCount, 0, 0, 20),
    lastLicenseCheck: dateValue(source.lastLicenseCheck) ?? new Date().toISOString(),
    serverValidationRequired: source.serverValidationRequired === true,
    managedBy: stringValue(source.managedBy) || "billing"
  };
}

function deviceActivationResponse(source: Record<string, any> | undefined): Record<string, unknown> | null {
  if (!source) return null;
  return {
    deviceId: stringValue(source.deviceId),
    deviceName: stringValue(source.deviceName),
    firstActivatedAt: dateValue(source.firstActivatedAt),
    lastUsedAt: dateValue(source.lastUsedAt),
    appVersion: stringValue(source.appVersion)
  };
}

function termsAcceptanceResponse(source: Record<string, any> | undefined): Record<string, unknown> | null {
  if (!source) return null;
  return {
    userId: stringValue(source.userId),
    userEmail: stringValue(source.userEmail),
    termsVersion: stringValue(source.termsVersion),
    privacyVersion: stringValue(source.privacyVersion),
    acceptedAt: dateValue(source.acceptedAt),
    appVersion: stringValue(source.appVersion),
    deviceId: stringValue(source.deviceId)
  };
}

function evaluateCommercialAccess(
  user: { isBlocked: boolean },
  license: CommercialLicense,
  deviceActivated: boolean,
  terms: Record<string, unknown> | null,
  config: GlobalAppConfig
): Record<string, unknown> {
  const status = license.licenseStatus.toLowerCase();
  const expired = !!license.licenseEndDate && Date.parse(license.licenseEndDate) <= Date.now();
  const requiresTermsAcceptance = !terms ||
    terms.termsVersion !== config.currentTermsVersion ||
    terms.privacyVersion !== config.currentPrivacyVersion;
  let isValid = true;
  let message = status === "trial" && license.licenseEndDate
    ? `Testversion aktiv bis ${new Date(license.licenseEndDate).toLocaleDateString("de-AT")}.`
    : "Lizenz aktiv.";

  if (user.isBlocked || status === "blocked") {
    isValid = false;
    message = "Konto wurde gesperrt. Bitte Support kontaktieren.";
  } else if (status === "expired" || expired) {
    isValid = false;
    message = "Lizenz abgelaufen.";
  } else if (status !== "active" && status !== "trial") {
    isValid = false;
    message = "Keine gültige Lizenz gefunden.";
  } else if (!deviceActivated) {
    isValid = false;
    message = license.currentDeviceCount >= license.maxDevices
      ? "Maximale Geräteanzahl erreicht."
      : "Dieses Gerät ist nicht für diese Lizenz aktiviert.";
  }

  return {
    isValid,
    status,
    message,
    validUntil: license.licenseEndDate,
    requiresOnlineCheck: license.serverValidationRequired,
    requiresTermsAcceptance,
    deviceActivated,
    canActivateDevice: !deviceActivated && license.currentDeviceCount < license.maxDevices
  };
}

async function cloudEntitlement(user: any): Promise<{ allowed: boolean; message: string }> {
  const config = await ensureGlobalAppConfig();
  const billing = await ensureLicenseState(user.uid);
  const userStatus = await ensureCommercialUser(user);
  const license = await ensureCommercialLicense(user, billing, config);
  const result = evaluateCommercialAccess(
    userStatus,
    license,
    true,
    {
      termsVersion: config.currentTermsVersion,
      privacyVersion: config.currentPrivacyVersion
    },
    config
  );
  return {
    allowed: result.isValid === true,
    message: stringValue(result.message) || "Keine gültige Lizenz gefunden."
  };
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function safeHttpUrl(value: unknown): string {
  const text = stringValue(value);
  if (!text) return "";
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : "";
  } catch {
    return "";
  }
}

function dateValue(value: unknown): string | null {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (value instanceof Date) return value.toISOString();
  return validIsoString(value);
}

async function verifiedUser(authorization: string, res: any): Promise<any | null> {
  const idToken = readBearerToken(authorization);
  if (!idToken) {
    res.status(401).json({ error: { message: "Anmeldetoken fehlt." } });
    return null;
  }

  try {
    const user = await getAuth().verifyIdToken(idToken);
    if (user.email_verified !== true) {
      res.status(403).json({ error: { message: "Bitte bestätige zuerst deine E-Mail-Adresse." } });
      return null;
    }
    return user;
  } catch {
    res.status(401).json({ error: { message: "Anmeldetoken ist ungültig oder abgelaufen." } });
    return null;
  }
}

async function ensureLicenseState(uid: string): Promise<LicenseState> {
  return await updateLicenseState(uid, (state) => state);
}

async function updateLicenseState(
  uid: string,
  update: (state: LicenseState) => LicenseState
): Promise<LicenseState> {
  const authUser = await getAuth().getUser(uid);
  const createdAt = validIsoString(authUser.metadata.creationTime) ?? new Date().toISOString();
  const licenseRef = db.doc(`users/${uid}/billing/license`);

  return await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(licenseRef);
    const current = normalizeLicenseState(parseJsonObject((snapshot.data() ?? {}).dataJson), createdAt);
    const next = normalizeLicenseState(update(current), createdAt);
    next.updatedAt = new Date().toISOString();
    transaction.set(licenseRef, { dataJson: JSON.stringify(next) }, { merge: true });
    return next;
  });
}

function stripeClient(): InstanceType<typeof Stripe> {
  return new Stripe(stripeApiKey.value());
}

async function ensureStripeCustomer(
  stripe: InstanceType<typeof Stripe>,
  uid: string,
  email: string
): Promise<string> {
  const customerRef = db.collection(stripeCustomersCollection.value()).doc(uid);
  const existing = (await customerRef.get()).data() ?? {};
  if (typeof existing.stripeId === "string" && existing.stripeId) return existing.stripeId;

  const customer = await stripe.customers.create(
    {
      email: email || undefined,
      metadata: { firebaseUid: uid }
    },
    { idempotencyKey: `meditest-customer-${uid}` }
  );
  await customerRef.set({
    stripeId: customer.id,
    email,
    updatedAt: Timestamp.now()
  }, { merge: true });
  return customer.id;
}

async function expireOpenCheckoutSessions(
  stripe: InstanceType<typeof Stripe>,
  customerId: string,
  shouldExpire: (session: any) => boolean
): Promise<void> {
  const sessions = await stripe.checkout.sessions.list({
    customer: customerId,
    status: "open",
    limit: 100
  });
  await Promise.all(
    sessions.data
      .filter(shouldExpire)
      .map((session: any) => stripe.checkout.sessions.expire(session.id))
  );
}

async function processStripeEvent(event: any): Promise<void> {
  if (event.type === "checkout.session.completed") {
    const session = event.data.object as any;
    if (session.mode === "payment" && session.payment_status === "paid") {
      const uid = stringValue(session.metadata?.firebaseUid);
      const catalogId = stringValue(session.metadata?.catalogId).slice(0, 200);
      if (uid && catalogId && session.metadata?.meditestPurchaseType === "catalog") {
        await updateLicenseState(uid, (state) => {
          state.purchasedCatalogTestIds.push(catalogId);
          return state;
        });
      }
    }
  } else if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const subscription = event.data.object as any;
    const customerId = typeof subscription.customer === "string"
      ? subscription.customer
      : stringValue(subscription.customer?.id);
    const uid = stringValue(subscription.metadata?.firebaseUid) ||
      await firebaseUidForStripeCustomer(customerId);
    if (uid) {
      const active = subscription.status === "active" || subscription.status === "trialing";
      const renewsAt = Number(subscription.current_period_end);
      await updateLicenseState(uid, (state) => {
        state.subscriptionActive = active;
        state.subscriptionRenewsAt = active && Number.isFinite(renewsAt)
          ? new Date(renewsAt * 1000).toISOString()
          : null;
        state.subscriptionProvider = active ? "stripe" : "";
        state.subscriptionCustomerId = active ? customerId : "";
        return state;
      });
    }
  }

  await db.collection("stripeWebhookEvents").doc(event.id).set({
    type: event.type,
    livemode: event.livemode,
    processedAt: Timestamp.now()
  }, { merge: true });
}

async function firebaseUidForStripeCustomer(customerId: string): Promise<string> {
  if (!customerId) return "";
  const snapshot = await db.collection(stripeCustomersCollection.value())
    .where("stripeId", "==", customerId)
    .limit(1)
    .get();
  return snapshot.empty ? "" : snapshot.docs[0].id;
}

function normalizeLicenseState(source: Record<string, any>, createdAt: string): LicenseState {
  const trialDays = Math.min(60, Math.max(1, Number(billingTrialDays.value()) || 7));
  const trialStartedAt = validIsoString(source.trialStartedAt) ?? createdAt;
  const trialEndsAt = validIsoString(source.trialEndsAt) ??
    new Date(Date.parse(trialStartedAt) + trialDays * 86_400_000).toISOString();
  const purchased = Array.isArray(source.purchasedCatalogTestIds)
    ? source.purchasedCatalogTestIds.map(stringValue).filter(Boolean)
    : [];

  return {
    trialStartedAt,
    trialEndsAt,
    subscriptionActive: source.subscriptionActive === true,
    subscriptionRenewsAt: validIsoString(source.subscriptionRenewsAt),
    subscriptionProvider: stringValue(source.subscriptionProvider),
    subscriptionCustomerId: stringValue(source.subscriptionCustomerId),
    premiumActive: source.premiumActive === true,
    premiumGrantedAt: validIsoString(source.premiumGrantedAt),
    premiumProvider: stringValue(source.premiumProvider),
    premiumCodeHash: stringValue(source.premiumCodeHash),
    freeCatalogCreditActive: source.freeCatalogCreditActive === true,
    freeCatalogCreditGrantedAt: validIsoString(source.freeCatalogCreditGrantedAt),
    freeCatalogCreditCodeHash: stringValue(source.freeCatalogCreditCodeHash),
    freeCatalogCreditRedeemedCatalogId: stringValue(source.freeCatalogCreditRedeemedCatalogId),
    freeCatalogCreditRedeemedAt: validIsoString(source.freeCatalogCreditRedeemedAt),
    purchasedCatalogTestIds: [...new Set(purchased)].sort(),
    updatedAt: validIsoString(source.updatedAt) ?? new Date().toISOString()
  };
}

async function findCatalogTest(catalogId: string): Promise<{
  questionCount: number;
  title: string;
  category: string;
  priceCents: number;
  currency: string;
} | null> {
  for (const collection of ["catalogTests", "thematicTests"]) {
    const snapshot = await db.collection(collection).doc(catalogId).get();
    if (!snapshot.exists) continue;
    const data = snapshot.data() ?? {};
    let questionCount = Number(data.questionCount);
    if (!Number.isInteger(questionCount) || questionCount <= 0) {
      try {
        const questions = JSON.parse(stringValue(data.questionsJson));
        questionCount = Array.isArray(questions) ? questions.length : 0;
      } catch {
        questionCount = 0;
      }
    }
    if (questionCount > 0) {
      const category = stringValue(data.category) || "Allgemein";
      const priceCents = category.toLowerCase() === "medat"
        ? boundedInt(data.priceCents, 4999, 1, 1_000_000)
        : boundedInt(
          data.priceCents,
          questionCount * Math.max(0, billingCatalogQuestionPriceCents.value()) +
            Math.max(0, billingCatalogPriceEndingCents.value()),
          1,
          1_000_000
        );
      return {
        questionCount: Math.min(1000, questionCount),
        title: stringValue(data.title) || "MediTest Katalogtest",
        category,
        priceCents,
        currency: (stringValue(data.currency) || billingCurrency.value() || "EUR").toUpperCase()
      };
    }
  }
  return null;
}

function validIsoString(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isStripePriceId(value: string): boolean {
  return /^price_[A-Za-z0-9]+$/.test(value);
}

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
          throw new Error("Der KI-Dienst hat keine verwertbaren Fragen geliefert.");
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

function normalizeAccessCode(code: unknown): string {
  return typeof code === "string" ? code.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

function hashAccessCode(code: string): string {
  return code ? createHash("sha256").update(code, "utf8").digest("hex").toUpperCase() : "";
}

function configuredFreeCatalogCodeHashes(): Set<string> {
  return new Set(freeCatalogCodeHashList.value()
    .split(/[,\s;]+/)
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean));
}

function configuredPremiumCodeHashes(): Set<string> {
  return new Set(premiumCodeHashList.value()
    .split(/[,\s;]+/)
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean));
}

function parseJsonObject(value: unknown): Record<string, any> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function deleteDocuments(refs: Array<FirebaseFirestore.DocumentReference>): Promise<void> {
  for (let offset = 0; offset < refs.length; offset += 400) {
    const batch = db.batch();
    refs.slice(offset, offset + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
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
