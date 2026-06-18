import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import * as logger from "firebase-functions/logger";
import { defineInt, defineSecret, defineString } from "firebase-functions/params";
import { onRequest } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2/options";
import { GoogleGenAI } from "@google/genai";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import nodemailer from "nodemailer";
import Stripe from "stripe";
import {
  CommerceProduct,
  StripeProductConfigurationError,
  assertStripeCheckoutProduct,
  loadCommerceProducts,
  resolveCommerceProduct,
  resolveCommerceProductByPriceId,
  validateStripeProducts
} from "./stripe-products";

initializeApp();

setGlobalOptions({
  region: "europe-west3",
  maxInstances: 10
});

const BRAND = Object.freeze({
  productName: "Meduvalo",
  domain: "meduvalo.at",
  websiteUrl: "https://meduvalo.at",
  supportEmail: "support@meduvalo.at",
  claim: "Prüfungsnah lernen. Sicherer bestehen.",
  shortClaim: "Medizinfragen smart trainieren."
});

const geminiApiKey = defineSecret("GEMINI_API_KEY");
const stripeApiKey = defineSecret("MEDITEST_STRIPE_API_KEY");
const stripeWebhookSecret = defineSecret("MEDITEST_STRIPE_WEBHOOK_SECRET");
const stripeValidationToken = defineSecret("MEDITEST_STRIPE_VALIDATION_TOKEN");
const supportSmtpPassword = defineSecret("MEDITEST_SMTP_PASSWORD");
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
const freeProductCodeHashList = defineString("FREE_PRODUCT_CODE_HASHES", {
  default: ""
});
const evergreenFreeProductCodeHashes = new Set([
  "422421B6739671C8F7605935DC9D9CD3CD93757DE6ED95D7DB102349F012F398",
  "DC884B6F529DA62BA9AB4BE61D629E6AE7C3BA7DF2649F0413C95CF10CD14FDE"
]);
const premiumCodeHashList = defineString("PREMIUM_CODE_HASHES", {
  default: ""
});
const billingTrialDays = defineInt("BILLING_TRIAL_DAYS", { default: 7 });
const billingProductPriceCents = defineInt("BILLING_PRODUCT_PRICE_CENTS", { default: 2499 });
const billingMonthlyPriceCents = defineInt("BILLING_MONTHLY_PRICE_CENTS", { default: 999 });
const billingCatalogQuestionPriceCents = defineInt("BILLING_CATALOG_QUESTION_PRICE_CENTS", { default: 10 });
const billingCatalogPriceEndingCents = defineInt("BILLING_CATALOG_PRICE_ENDING_CENTS", { default: 9 });
const billingCurrency = defineString("BILLING_CURRENCY", { default: "EUR" });
const installationAuthorizationTtlHours = defineInt("INSTALLATION_AUTHORIZATION_TTL_HOURS", { default: 24 });
const licensingDefaultMaxDevices = defineInt("LICENSING_DEFAULT_MAX_DEVICES", { default: 2 });
const supportMaxDailyRequests = defineInt("SUPPORT_MAX_DAILY_REQUESTS", { default: 5 });
const supportRecipientEmail = defineString("SUPPORT_RECIPIENT_EMAIL", { default: BRAND.supportEmail });
const supportFromEmail = defineString("SUPPORT_FROM_EMAIL", { default: "Meduvalo Support <support@meduvalo.at>" });
const supportSmtpHost = defineString("SUPPORT_SMTP_HOST", { default: "smtp.ionos.de" });
const supportSmtpPort = defineInt("SUPPORT_SMTP_PORT", { default: 465 });
const supportSmtpUsername = defineString("SUPPORT_SMTP_USERNAME", { default: BRAND.supportEmail });
const billingReturnBaseUrl = defineString("BILLING_RETURN_BASE_URL", { default: "http://127.0.0.1:55000" });
const billingWebsiteBaseUrl = defineString("BILLING_WEBSITE_BASE_URL", {
  default: BRAND.websiteUrl
});
const stripeCustomersCollection = defineString("STRIPE_CUSTOMERS_COLLECTION", { default: "customers" });
const stripePortalConfigurationId = defineString("STRIPE_PORTAL_CONFIGURATION_ID", { default: "not-configured" });
const currentAppVersion = defineString("CURRENT_APP_VERSION", { default: "5.0.15" });
const windowsDownloadUrl = defineString("WINDOWS_DOWNLOAD_URL", {
  default: "https://github.com/automationTurtle95/MediTest/releases/download/v5.0.15/MediTest-Setup-5.0.15-win-x64.msi"
});
const macosArm64DownloadUrl = defineString("MACOS_ARM64_DOWNLOAD_URL", {
  default: "https://github.com/automationTurtle95/MediTest/releases/download/v5.0.15/MediTest-Setup-5.0.15-macos-arm64.dmg"
});
const macosX64DownloadUrl = defineString("MACOS_X64_DOWNLOAD_URL", {
  default: "https://github.com/automationTurtle95/MediTest/releases/download/v5.0.15/MediTest-Setup-5.0.15-macos-x64.dmg"
});
const db = getFirestore();
const legacyExpiredTrialDate = "1970-01-01T00:00:00.000Z";

type DownloadPlatform = "windows-x64" | "macos-arm64" | "macos-x64";

type GenerateQuestionsRequest = {
  messages?: unknown;
  model?: unknown;
  temperature?: unknown;
  questionCount?: unknown;
};

type SupportRequestPayload = {
  category?: unknown;
  subject?: unknown;
  message?: unknown;
  diagnostics?: unknown;
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
  baseProductPurchased: boolean;
  baseProductPurchasedAt: string | null;
  baseProductProvider: string;
  baseProductCheckoutSessionId: string;
  baseProductCodeHash: string;
  installationAuthorizationRequired: boolean;
  installationAuthorizedDeviceId: string;
  activeInstallationTokenHash: string;
  trialStartedAt: string | null;
  trialEndsAt: string | null;
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

let genAiClient: GoogleGenAI | null = null;

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
      const message = safeAiErrorMessage(error);
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
    res.status(200).json({ state: licenseStateResponse(state) });
  }
);

export const meditestPricing = onRequest(
  {
    invoker: "public",
    memory: "256MiB",
    timeoutSeconds: 15
  },
  async (req, res) => {
    if (req.method !== "GET") {
      res.set("Allow", "GET").status(405).json({ error: { message: "Nur GET-Anfragen sind erlaubt." } });
      return;
    }

    const products = await loadCommerceProducts(db, stripeProductConfig());
    const baseProduct = products.find((product) => product.localProductKey === "base-product");
    const subscription = products.find((product) => product.localProductKey === "subscription-monthly");
    res.set("Cache-Control", "public, max-age=300");
    res.status(200).json({
      productPriceCents: baseProduct?.priceAmount ?? commercialPricing().productPriceCents,
      monthlyPriceCents: subscription?.priceAmount ?? commercialPricing().monthlyPriceCents,
      currency: (baseProduct?.currency || subscription?.currency || commercialPricing().currency).toUpperCase()
    });
  }
);

export const meditestValidateStripeProducts = onRequest(
  {
    invoker: "public",
    memory: "256MiB",
    secrets: [stripeApiKey, stripeValidationToken],
    timeoutSeconds: 120
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).json({ error: { message: "Nur POST-Anfragen sind erlaubt." } });
      return;
    }
    const maintenanceAuthorized = secureTokenMatches(
      req.header("x-meduvalo-validation-token") ?? "",
      stripeValidationToken.value()
    );
    let requestedBy = "deployment-validation";
    if (!maintenanceAuthorized) {
      const user = await verifiedUser(req.header("authorization") ?? "", res);
      if (!user) return;
      if (user.admin !== true && user.isAdmin !== true) {
        res.status(403).json({ error: { message: "Nur Admin-Konten dürfen Stripe-Produkte prüfen." } });
        return;
      }
      requestedBy = user.uid;
    }

    const repair = req.body?.createMissing === true;
    try {
      const report = await validateStripeProducts(stripeClient(), db, stripeProductConfig(), repair);
      res.status(200).json(report);
    } catch (error: any) {
      logger.error("Stripe product validation failed", {
        requestedBy,
        repair,
        code: stringValue(error?.code),
        message: stringValue(error?.message)
      });
      res.status(502).json({
        error: {
          message: repair
            ? "Der Stripe-Produktabgleich konnte nicht vollständig ausgeführt werden. Prüfe die Schreibrechte des Stripe-API-Schlüssels."
            : "Die Stripe-Produkte konnten momentan nicht validiert werden."
        }
      });
    }
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

    const requestedPlatform = normalizeDownloadPlatform(req.body?.platform);
    if (req.body?.platform && !requestedPlatform) {
      res.status(400).json({ error: { message: "Diese Download-Plattform wird nicht unterstützt." } });
      return;
    }

    const platform = requestedPlatform ?? "windows-x64";
    const isAdmin = user.admin === true || user.isAdmin === true;
    let state = await ensureLicenseState(user.uid);
    const downloadAllowed = isAdmin ||
      state.baseProductPurchased ||
      state.premiumActive ||
      state.subscriptionActive;
    if (!downloadAllowed) {
      res.status(403).json({
        error: {
          message: "Der Software-Download wird nach erfolgreichem Kauf freigeschaltet."
        }
      });
      return;
    }
    if (!isAdmin && !state.installationAuthorizationRequired) {
      state = await updateLicenseState(user.uid, (current) => {
        current.installationAuthorizationRequired = true;
        current.installationAuthorizedDeviceId = "";
        current.activeInstallationTokenHash = "";
        return current;
      });
    }
    const appConfig = await ensureGlobalAppConfig();
    const license = await ensureCommercialLicense(user, state, appConfig);
    const activatedDevices = await db.collection(`deviceActivations/${user.uid}/devices`).get();

    const version = currentAppVersion.value().trim() || "5.0.8";
    const downloads: Record<DownloadPlatform, { fileName: string; url: string }> = {
      "windows-x64": {
        fileName: `MediTest-Setup-${version}-win-x64.msi`,
        url: windowsDownloadUrl.value().trim()
      },
      "macos-arm64": {
        fileName: `MediTest-Setup-${version}-macos-arm64.dmg`,
        url: macosArm64DownloadUrl.value().trim()
      },
      "macos-x64": {
        fileName: `MediTest-Setup-${version}-macos-x64.dmg`,
        url: macosX64DownloadUrl.value().trim()
      }
    };
    const download = downloads[platform];
    if (!download.url) {
      res.status(503).json({ error: { message: "Der ausgewählte Download ist noch nicht konfiguriert." } });
      return;
    }

    let installationAuthorization: Record<string, unknown> | null = null;
    if (state.installationAuthorizationRequired && activatedDevices.size < license.maxDevices) {
      const token = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
      const ttlHours = Math.min(168, Math.max(1, Number(installationAuthorizationTtlHours.value()) || 24));
      const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
      const authorizationRef = db.doc(`installationAuthorizations/${tokenHash}`);
      await authorizationRef.set({
        uid: user.uid,
        platform,
        version,
        createdAt: Timestamp.now(),
        expiresAt: Timestamp.fromDate(expiresAt),
        consumedAt: null,
        consumedDeviceId: ""
      });
      const updatedState = await updateLicenseState(user.uid, (current) => {
        current.activeInstallationTokenHash = tokenHash;
        return current;
      });
      const previousTokenHash = state.activeInstallationTokenHash;
      if (previousTokenHash && previousTokenHash !== tokenHash) {
        await db.doc(`installationAuthorizations/${previousTokenHash}`).delete().catch(() => undefined);
      }
      if (updatedState.activeInstallationTokenHash === tokenHash) {
        installationAuthorization = {
          schemaVersion: 1,
          token,
          platform,
          version,
          expiresAt: expiresAt.toISOString()
        };
      } else {
        await authorizationRef.delete();
      }
    }

    res.status(200).json({
      platform,
      version,
      fileName: download.fileName,
      url: download.url,
      installationAuthorization
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
    const platform = normalizeDownloadPlatform(req.body?.platform);
    const installationToken = stringValue(req.body?.installationToken).slice(0, 200);
    const appVersion = stringValue(req.body?.appVersion).slice(0, 40) || "0.0.0";
    if (!/^[a-f0-9]{64}$/.test(deviceId)) {
      res.status(400).json({ error: { message: "Die Geräte-ID ist ungültig." } });
      return;
    }

    try {
      const appConfig = await ensureGlobalAppConfig();
      let billingState = await ensureLicenseState(user.uid);
      const userStatus = await ensureCommercialUser(user);
      let license = await ensureCommercialLicense(user, billingState, appConfig);

      if (action === "acceptTerms") {
        if (req.body?.acceptTerms !== true || req.body?.acceptPrivacy !== true) {
          res.status(400).json({ error: { message: "AGB und Datenschutzerklärung müssen beide akzeptiert werden." } });
          return;
        }
        await saveTermsAcceptance(user, deviceId, appVersion, appConfig);
      } else if (action === "activateDevice") {
        await activateLicensedDevice(
          user.uid,
          billingState,
          installationToken,
          platform,
          deviceId,
          deviceName,
          appVersion);
      } else if (action === "check") {
        const currentDevice = await db.doc(`deviceActivations/${user.uid}/devices/${deviceId}`).get();
        const deviceEligible = (
          license.licenseStatus === "active" ||
          license.licenseStatus === "trial" ||
          license.licenseStatus === "restricted"
        ) &&
          (!license.licenseEndDate || Date.parse(license.licenseEndDate) > Date.now());
        if (!currentDevice.exists && deviceEligible && !userStatus.isBlocked) {
          try {
            await activateLicensedDevice(
              user.uid,
              billingState,
              installationToken,
              platform,
              deviceId,
              deviceName,
              appVersion);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== "device_limit_reached") throw error;
          }
        } else if (
          currentDevice.exists
        ) {
          await currentDevice.ref.set({
            lastUsedAt: Timestamp.now(),
            appVersion
          }, { merge: true });
        }
      } else {
        res.status(400).json({ error: { message: "Unbekannte Lizenzaktion." } });
        return;
      }

      billingState = await ensureLicenseState(user.uid);
      const [deviceSnapshot, termsSnapshot, licenseSnapshot] = await Promise.all([
        db.doc(`deviceActivations/${user.uid}/devices/${deviceId}`).get(),
        db.doc(`termsAcceptances/${user.uid}`).get(),
        db.doc(`licenses/${user.uid}`).get()
      ]);
      license = commercialLicenseFromData(user.uid, stringValue(user.email), licenseSnapshot.data() ?? {}, appConfig);
      const terms = termsAcceptanceResponse(termsSnapshot.data());
      const device = deviceActivationResponse(deviceSnapshot.data());
      const result = evaluateCommercialAccess(userStatus, license, !!device, terms, appConfig);
      if (!device && billingState.installationAuthorizationRequired) {
        result.canActivateDevice = false;
        result.message = license.currentDeviceCount >= license.maxDevices
          ? "Maximale Geräteanzahl erreicht."
          : "Die Installationsberechtigung fehlt oder ist abgelaufen. Lade den Installer auf diesem Gerät erneut über meduvalo.at herunter.";
      }

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
      if (code === "installation_authorization_missing") {
        res.status(409).json({ error: { message: "Die Installationsberechtigung fehlt. Lade den Installer auf diesem Gerät erneut über meduvalo.at herunter." } });
        return;
      }
      if (code === "installation_authorization_invalid") {
        res.status(409).json({ error: { message: "Die Installationsberechtigung ist ungültig, abgelaufen oder wurde bereits verwendet." } });
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

export const meditestRedeemProductCode = onRequest(
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
    if (!normalizedCode || !configuredFreeProductCodeHashes().has(codeHash)) {
      res.status(400).json({ error: { message: "Dieser Gratis-Code ist ungültig." } });
      return;
    }

    const state = await updateLicenseState(user.uid, (current) => {
      if (current.baseProductPurchased || current.premiumActive || current.subscriptionActive) return current;
      const purchasedAt = new Date().toISOString();
      const trialDays = Math.min(60, Math.max(1, Number(billingTrialDays.value()) || 7));
      current.baseProductPurchased = true;
      current.baseProductPurchasedAt = purchasedAt;
      current.baseProductProvider = "product-code";
      current.baseProductCheckoutSessionId = "";
      current.baseProductCodeHash = codeHash;
      current.installationAuthorizationRequired = true;
      current.installationAuthorizedDeviceId = "";
      current.activeInstallationTokenHash = "";
      current.trialStartedAt = purchasedAt;
      current.trialEndsAt = new Date(Date.parse(purchasedAt) + trialDays * 86_400_000).toISOString();
      return current;
    });
    res.status(200).json({
      redeemed: true,
      state: licenseStateResponse(state),
      message: `${BRAND.productName} wurde kostenlos freigeschaltet.`
    });
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
        if (current.purchasedCatalogTestIds.includes(catalogId)) return current;
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
    const requestedPlatform = normalizeDownloadPlatform(req.body?.platform);
    if (kind === "product" && req.body?.platform && !requestedPlatform) {
      res.status(400).json({ error: { message: "Diese Kaufplattform wird nicht unterstützt." } });
      return;
    }
    const downloadPlatform = requestedPlatform ?? "windows-x64";
    const returnBaseUrl = billingReturnBaseUrl.value().replace(/\/+$/, "");
    const websiteBaseUrl = billingWebsiteBaseUrl.value().replace(/\/+$/, "");
    if (websiteBaseUrl === BRAND.websiteUrl && stripeApiMode() !== "live") {
      logger.error("Production checkout blocked because Stripe is not configured for live mode", {
        stripeMode: stripeApiMode()
      });
      res.status(503).json({
        error: {
          message: "Stripe ist serverseitig noch im Testmodus konfiguriert. Der Live-Schlüssel muss in Firebase hinterlegt werden."
        }
      });
      return;
    }
    try {
      const state = await ensureLicenseState(user.uid);
      const stripe = stripeClient();
      const customerId = await ensureStripeCustomer(stripe, user.uid, stringValue(user.email));
      let checkoutData: any;

    if (kind === "product") {
      if (state.baseProductPurchased || state.premiumActive || state.subscriptionActive) {
        res.status(409).json({ error: { message: `${BRAND.productName} wurde für dieses Konto bereits gekauft.` } });
        return;
      }
      await expireOpenCheckoutSessions(
        stripe,
        customerId,
        (session) => session.mode === "payment" && session.metadata?.meditestPurchaseType === "base-product"
      );

      const commerceProduct = await resolveCommerceProduct(db, stripeProductConfig(), "base-product");
      await assertStripeCheckoutProduct(stripe, commerceProduct);
      const metadata = {
        meditestPurchaseType: "base-product",
        localProductKey: commerceProduct.localProductKey,
        stripeProductId: commerceProduct.stripeProductId,
        stripePriceId: commerceProduct.stripePriceId,
        firebaseUid: user.uid,
        purchaseSource: source === "landing" ? "landing" : "app",
        downloadPlatform,
        productPriceCents: String(commerceProduct.priceAmount),
        trialDays: String(Math.min(60, Math.max(1, Number(billingTrialDays.value()) || 7))),
        currency: commerceProduct.currency.toUpperCase()
      };
      checkoutData = {
        mode: "payment",
        customer: customerId,
        line_items: [{
          price: commerceProduct.stripePriceId,
          quantity: 1
        }],
        client_reference_id: user.uid,
        success_url: `${websiteBaseUrl}/purchase.html?checkout=success&platform=${downloadPlatform}`,
        cancel_url: `${websiteBaseUrl}/purchase.html?checkout=cancelled&platform=${downloadPlatform}`,
        metadata,
        payment_intent_data: { metadata },
        invoice_creation: {
          enabled: true,
          invoice_data: { metadata }
        }
      };
    } else if (kind === "subscription") {
      if (state.premiumActive || state.subscriptionActive) {
        res.status(409).json({ error: { message: "Für dieses Konto ist bereits ein Zugang aktiv." } });
        return;
      }
      if (!state.baseProductPurchased) {
        res.status(403).json({
          error: {
            message: `Das Monatsabo ist nach dem einmaligen Kauf von ${BRAND.productName} verfügbar.`
          }
        });
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
        Math.ceil(((state.trialEndsAt ? Date.parse(state.trialEndsAt) : 0) - Date.now()) / 86_400_000)
      );
      const commerceProduct = await resolveCommerceProduct(db, stripeProductConfig(), "subscription");
      await assertStripeCheckoutProduct(stripe, commerceProduct);
      const metadata = {
        meditestPurchaseType: "subscription",
        localProductKey: commerceProduct.localProductKey,
        stripeProductId: commerceProduct.stripeProductId,
        stripePriceId: commerceProduct.stripePriceId,
        firebaseUid: user.uid,
        purchaseSource: "app",
        monthlyPriceCents: String(commerceProduct.priceAmount),
        currency: commerceProduct.currency.toUpperCase()
      };
      checkoutData = {
        mode: "subscription",
        customer: customerId,
        line_items: [{
          price: commerceProduct.stripePriceId,
          quantity: 1
        }],
        client_reference_id: user.uid,
        success_url: `${returnBaseUrl}/pages/license.html?checkout=success`,
        cancel_url: `${returnBaseUrl}/pages/license.html?checkout=cancelled`,
        metadata,
        subscription_data: {
          metadata,
          ...(remainingTrialDays > 0
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
      if (state.purchasedCatalogTestIds.includes(catalogId)) {
        res.status(409).json({ error: { message: "Dieser Katalogtest ist bereits freigeschaltet." } });
        return;
      }

      const catalog = await findCatalogTest(catalogId);
      if (!catalog) {
        res.status(404).json({ error: { message: "Katalogtest nicht gefunden." } });
        return;
      }
      await expireOpenCheckoutSessions(
        stripe,
        customerId,
        (session) => session.mode === "payment" && session.metadata?.catalogId === catalogId
      );

      const commerceProduct = await resolveCommerceProduct(db, stripeProductConfig(), "catalog", catalogId);
      await assertStripeCheckoutProduct(stripe, commerceProduct);
      const metadata = {
        meditestPurchaseType: "catalog",
        localProductKey: commerceProduct.localProductKey,
        stripeProductId: commerceProduct.stripeProductId,
        stripePriceId: commerceProduct.stripePriceId,
        catalogId,
        firebaseUid: user.uid,
        category: catalog.category,
        questionCount: String(catalog.questionCount),
        expectedPriceCents: String(commerceProduct.priceAmount),
        currency: commerceProduct.currency.toUpperCase()
      };
      checkoutData = {
        mode: "payment",
        customer: customerId,
        line_items: [{
          price: commerceProduct.stripePriceId,
          quantity: 1
        }],
        client_reference_id: user.uid,
        success_url: `${returnBaseUrl}/pages/catalog.html?checkout=success&catalogId=${encodeURIComponent(catalogId)}`,
        cancel_url: `${returnBaseUrl}/pages/catalog.html?checkout=cancelled&catalogId=${encodeURIComponent(catalogId)}`,
        metadata,
        payment_intent_data: { metadata },
        invoice_creation: {
          enabled: true,
          invoice_data: { metadata }
        }
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
    } catch (error: any) {
      logger.error("Stripe checkout creation failed", {
        uid: user.uid,
        kind,
        stripeMode: stripeApiMode(),
        code: stringValue(error?.code),
        message: stringValue(error?.message)
      });
      const message = error instanceof StripeProductConfigurationError
        ? error.message
        : error?.code === "resource_missing"
          ? "Stripe-Live-Konfiguration und hinterlegte Preis- oder Kunden-IDs passen nicht zusammen."
          : "Der Stripe-Checkout konnte momentan nicht erstellt werden.";
      res.status(502).json({ error: { message } });
    }
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
    if (billingWebsiteBaseUrl.value().replace(/\/+$/, "") === BRAND.websiteUrl &&
        stripeApiMode() !== "live") {
      res.status(503).json({
        error: {
          message: "Stripe ist serverseitig noch im Testmodus konfiguriert. Der Live-Schlüssel muss in Firebase hinterlegt werden."
        }
      });
      return;
    }

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
    if (event.livemode !== (stripeApiMode() === "live")) {
      logger.warn("Stripe webhook mode does not match configured API key", {
        eventId: event.id,
        eventLivemode: event.livemode,
        stripeMode: stripeApiMode()
      });
      res.status(400).send("Stripe mode mismatch");
      return;
    }

    try {
      const claimed = await claimStripeEvent(event);
      if (!claimed) {
        res.status(200).json({ received: true, duplicate: true });
        return;
      }
      await processStripeEvent(event);
      await markStripeEventProcessed(event);
      res.status(200).json({ received: true });
    } catch (error) {
      await markStripeEventFailed(event, error).catch(() => undefined);
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
      const supportRequestsSnapshot = await db.collection("supportRequests").where("uid", "==", user.uid).get();
      const supportRateLimitRef = db.collection("supportRateLimits").doc(user.uid);
      const installationAuthorizationsSnapshot = await db.collection("installationAuthorizations")
        .where("uid", "==", user.uid)
        .get();
      const customerData = (await customerRef.get()).data() ?? {};
      const stripeCustomerId = stripeApiMode() === "live"
        ? stringValue(customerData.stripeLiveId) || stringValue(customerData.stripeId)
        : stringValue(customerData.stripeTestId) || stringValue(customerData.stripeId);
      if (stripeCustomerId) {
        try {
          await stripeClient().customers.del(stripeCustomerId);
        } catch (error: any) {
          if (error?.code !== "resource_missing") throw error;
        }
      }

      await Promise.all([
        db.recursiveDelete(userRef),
        db.recursiveDelete(deviceRef),
        licenseRef.delete(),
        termsRef.delete(),
        db.recursiveDelete(customerRef),
        db.recursiveDelete(aiUsageRef),
        db.recursiveDelete(supportRateLimitRef),
        deleteDocuments(eventsSnapshot.docs.map((doc) => doc.ref)),
        deleteDocuments(supportRequestsSnapshot.docs.map((doc) => doc.ref)),
        deleteDocuments(installationAuthorizationsSnapshot.docs.map((doc) => doc.ref))
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

export const meditestSupportRequest = onRequest(
  {
    invoker: "public",
    memory: "256MiB",
    secrets: [supportSmtpPassword],
    timeoutSeconds: 30
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.set("Allow", "POST").status(405).json({ error: { message: "Nur POST-Anfragen sind erlaubt." } });
      return;
    }

    const user = await verifiedUser(req.header("authorization") ?? "", res);
    if (!user) return;

    const request = (req.body ?? {}) as SupportRequestPayload;
    const category = normalizeSupportCategory(request.category);
    const subject = stringValue(request.subject).trim().slice(0, 160);
    const message = stringValue(request.message).trim().slice(0, 5000);
    if (!subject) {
      res.status(400).json({ error: { message: "Bitte gib einen Betreff ein." } });
      return;
    }
    if (message.length < 10) {
      res.status(400).json({ error: { message: "Bitte beschreibe dein Anliegen mit mindestens 10 Zeichen." } });
      return;
    }

    const diagnosticsSource = request.diagnostics && typeof request.diagnostics === "object"
      ? request.diagnostics as Record<string, unknown>
      : {};
    const diagnostics = {
      appVersion: stringValue(diagnosticsSource.appVersion).slice(0, 80),
      currentPage: stringValue(diagnosticsSource.currentPage).slice(0, 500),
      userAgent: stringValue(diagnosticsSource.userAgent).slice(0, 500)
    };
    const now = Timestamp.now();
    const dayKey = now.toDate().toISOString().slice(0, 10);
    const rateRef = db.doc(`supportRateLimits/${user.uid}/days/${dayKey}`);
    const ticketRef = db.collection("supportRequests").doc();
    const userEmail = stringValue(user.email);
    const displayName = stringValue(user.name) || userEmail.split("@")[0] || "Meduvalo Nutzer";
    const maxDailyRequests = Math.min(20, Math.max(1, Number(supportMaxDailyRequests.value()) || 5));

    try {
      await db.runTransaction(async (transaction) => {
        const rateSnapshot = await transaction.get(rateRef);
        const requestCount = numberField(rateSnapshot.data() ?? {}, "requestCount");
        if (requestCount >= maxDailyRequests) throw new Error("support_rate_limit");

        transaction.set(rateRef, {
          requestCount: FieldValue.increment(1),
          lastRequestedAt: now,
          expiresAt: Timestamp.fromMillis(now.toMillis() + 35 * 24 * 60 * 60 * 1000)
        }, { merge: true });
        transaction.set(ticketRef, {
          uid: user.uid,
          userEmail,
          displayName,
          category,
          subject,
          message,
          diagnostics,
          recipientEmail: supportRecipientEmail.value().trim() || BRAND.supportEmail,
          status: "new",
          deliveryStatus: "stored",
          createdAt: now,
          updatedAt: now
        });
      });
    } catch (error) {
      if (error instanceof Error && error.message === "support_rate_limit") {
        res.status(429).json({
          error: { message: `Du kannst höchstens ${maxDailyRequests} Supportanfragen pro Tag senden.` }
        });
        return;
      }
      logger.error("Support ticket storage failed", {
        uid: user.uid,
        message: error instanceof Error ? error.message : String(error)
      });
      res.status(503).json({ error: { message: "Die Supportanfrage konnte momentan nicht gespeichert werden." } });
      return;
    }

    let emailSent = false;
    const smtpPassword = supportSmtpPassword.value().trim();
    if (smtpPassword) {
      try {
        const recipient = supportRecipientEmail.value().trim() || BRAND.supportEmail;
        const smtpUsername = supportSmtpUsername.value().trim() || BRAND.supportEmail;
        const smtpPort = supportSmtpPort.value();
        const categoryLabel = supportCategoryLabel(category);
        const diagnosticText = diagnostics.appVersion || diagnostics.currentPage || diagnostics.userAgent
          ? `\n\nTechnische Angaben:\nVersion: ${diagnostics.appVersion || "-"}\nSeite: ${diagnostics.currentPage || "-"}\nBrowser: ${diagnostics.userAgent || "-"}`
          : "";
        const transporter = nodemailer.createTransport({
          host: supportSmtpHost.value().trim() || "smtp.ionos.de",
          port: smtpPort,
          secure: smtpPort === 465,
          requireTLS: smtpPort !== 465,
          auth: {
            user: smtpUsername,
            pass: smtpPassword
          },
          tls: {
            minVersion: "TLSv1.2"
          }
        });
        const emailResult = await transporter.sendMail({
          from: supportFromEmail.value().trim() || "Meduvalo Support <support@meduvalo.at>",
          to: recipient,
          replyTo: userEmail,
          subject: `[Meduvalo Support · ${categoryLabel}] ${subject}`,
          text: `Neue Supportanfrage von ${displayName} (${userEmail})\n\nKategorie: ${categoryLabel}\nBetreff: ${subject}\n\n${message}${diagnosticText}\n\nTicket: ${ticketRef.id}`,
          html: supportEmailHtml(displayName, userEmail, categoryLabel, subject, message, diagnostics, ticketRef.id)
        });
        emailSent = true;
        await ticketRef.set({
          deliveryStatus: "sent",
          emailProvider: "ionos-smtp",
          emailProviderId: stringValue(emailResult.messageId),
          emailSentAt: Timestamp.now(),
          updatedAt: Timestamp.now()
        }, { merge: true });
      } catch (error) {
        logger.error("Support email delivery failed", {
          uid: user.uid,
          ticketId: ticketRef.id,
          message: error instanceof Error ? error.message : String(error)
        });
        await ticketRef.set({
          deliveryStatus: "failed",
          deliveryError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          updatedAt: Timestamp.now()
        }, { merge: true });
      }
    } else {
      logger.warn("Support email delivery is not configured", { ticketId: ticketRef.id });
    }

    res.status(200).json({
      submitted: true,
      ticketId: ticketRef.id,
      emailSent,
      supportEmail: supportRecipientEmail.value().trim() || BRAND.supportEmail,
      message: emailSent
        ? `Deine Supportanfrage wurde an ${supportRecipientEmail.value().trim() || BRAND.supportEmail} gesendet.`
        : "Deine Supportanfrage wurde sicher gespeichert. Der Support kann das Ticket im Support-Postfach bearbeiten."
    });
  }
);

async function ensureGlobalAppConfig(): Promise<GlobalAppConfig> {
  const ref = db.doc("appConfig/global");
  const snapshot = await ref.get();
  const source = snapshot.data() ?? {};
  const storedAppVersion = stringValue(source.currentAppVersion);
  const storedTermsVersion = stringValue(source.currentTermsVersion);
  const config: GlobalAppConfig = {
    currentAppVersion: !storedAppVersion || ["5.0.2", "5.0.3", "5.0.4", "5.0.5", "5.0.6", "5.0.7"].includes(storedAppVersion)
      ? "5.0.8"
      : storedAppVersion,
    currentTermsVersion: !storedTermsVersion || storedTermsVersion === "5.0" ? "5.1" : storedTermsVersion,
    currentPrivacyVersion: !stringValue(source.currentPrivacyVersion) || stringValue(source.currentPrivacyVersion) === "5.0"
      ? "5.1"
      : stringValue(source.currentPrivacyVersion),
    allowedOfflineDays: boundedInt(source.allowedOfflineDays, 7, 0, 30),
    supportEmail: stringValue(source.supportEmail) || BRAND.supportEmail,
    termsOfUseUrl: safeHttpUrl(source.termsOfUseUrl),
    privacyPolicyUrl: safeHttpUrl(source.privacyPolicyUrl),
    impressumUrl: safeHttpUrl(source.impressumUrl),
    licenseAgreementUrl: safeHttpUrl(source.licenseAgreementUrl),
    defaultMaxDevices: Math.min(20, Math.max(1, Number(licensingDefaultMaxDevices.value()) || 2)),
    trialDurationDays: boundedInt(source.trialDurationDays, 7, 1, 60)
  };
  if (!snapshot.exists) {
    await ref.set({
      ...config,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    });
  } else if (
    storedAppVersion !== config.currentAppVersion ||
    storedTermsVersion !== config.currentTermsVersion ||
    source.supportEmail !== config.supportEmail ||
    source.defaultMaxDevices !== config.defaultMaxDevices
  ) {
    await ref.set({
      currentAppVersion: config.currentAppVersion,
      currentTermsVersion: config.currentTermsVersion,
      supportEmail: config.supportEmail,
      defaultMaxDevices: config.defaultMaxDevices,
      updatedAt: Timestamp.now()
    }, { merge: true });
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
  const purchased = billing.baseProductPurchased;
  const trialActive = purchased && !!billing.trialEndsAt && Date.parse(billing.trialEndsAt) > now;
  const licenseType = admin ? "Admin" :
    premium ? "Lifetime" :
      subscription ? "Subscription" :
        trialActive ? "Trial" :
          purchased ? "Base" : "Free";
  const licenseStatus = admin || premium || subscription ? "active" :
    trialActive ? "trial" :
      purchased ? "restricted" : "inactive";
  const licenseEndDate = admin || premium ? null :
    subscription ? billing.subscriptionRenewsAt :
      trialActive ? billing.trialEndsAt : null;
  const licenseStartDate = billing.baseProductPurchasedAt ?? billing.trialStartedAt;
  const maxDevices = config.defaultMaxDevices;
  const activatedDevices = await db.collection(`deviceActivations/${user.uid}/devices`).get();
  const currentDeviceCount = Math.min(maxDevices, activatedDevices.size);
  const data = {
    userId: user.uid,
    userEmail: stringValue(user.email),
    licenseType,
    licenseStatus,
    licenseStartDate: licenseStartDate ? Timestamp.fromDate(new Date(licenseStartDate)) : null,
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

async function activateLicensedDevice(
  userId: string,
  billing: LicenseState,
  installationToken: string,
  platform: DownloadPlatform | null,
  deviceId: string,
  deviceName: string,
  appVersion: string
): Promise<void> {
  const currentDevice = await db.doc(`deviceActivations/${userId}/devices/${deviceId}`).get();
  if (currentDevice.exists) {
    await activateDevice(userId, deviceId, deviceName, appVersion);
    return;
  }
  const licenseSnapshot = await db.doc(`licenses/${userId}`).get();
  const license = licenseSnapshot.data() ?? {};
  const maxDevices = boundedInt(license.maxDevices, 2, 1, 20);
  const currentDeviceCount = boundedInt(license.currentDeviceCount, 0, 0, maxDevices);
  if (currentDeviceCount >= maxDevices)
    throw new Error("device_limit_reached");
  if (!billing.installationAuthorizationRequired) {
    await activateDevice(userId, deviceId, deviceName, appVersion);
    return;
  }
  if (!installationToken || !platform)
    throw new Error("installation_authorization_missing");

  await consumeInstallationAuthorization(
    userId,
    installationToken,
    platform,
    deviceId,
    deviceName,
    appVersion);
}

async function consumeInstallationAuthorization(
  userId: string,
  token: string,
  platform: DownloadPlatform,
  deviceId: string,
  deviceName: string,
  appVersion: string
): Promise<void> {
  const tokenHash = createHash("sha256").update(token, "utf8").digest("hex");
  const authorizationRef = db.doc(`installationAuthorizations/${tokenHash}`);
  const billingRef = db.doc(`users/${userId}/billing/license`);
  const licenseRef = db.doc(`licenses/${userId}`);
  const deviceRef = db.doc(`deviceActivations/${userId}/devices/${deviceId}`);

  await db.runTransaction(async (transaction) => {
    const [authorizationSnapshot, billingSnapshot, licenseSnapshot, deviceSnapshot] = await Promise.all([
      transaction.get(authorizationRef),
      transaction.get(billingRef),
      transaction.get(licenseRef),
      transaction.get(deviceRef)
    ]);
    const authorization = authorizationSnapshot.data() ?? {};
    const billingData = billingSnapshot.data() ?? {};
    const billingState = parseJsonObject(billingData.dataJson);
    const expiresAt = dateValue(authorization.expiresAt);
    const valid = authorizationSnapshot.exists &&
      stringValue(authorization.uid) === userId &&
      stringValue(authorization.platform) === platform &&
      !authorization.consumedAt &&
      !!expiresAt &&
      Date.parse(expiresAt) > Date.now() &&
      stringValue(billingState.activeInstallationTokenHash) === tokenHash;
    if (!valid)
      throw new Error("installation_authorization_invalid");

    const license = licenseSnapshot.data() ?? {};
    const status = stringValue(license.licenseStatus).toLowerCase();
    if (status !== "active" && status !== "trial" && status !== "restricted")
      throw new Error("license_not_active");
    const maxDevices = boundedInt(license.maxDevices, 2, 1, 20);
    const currentDeviceCount = boundedInt(license.currentDeviceCount, 0, 0, maxDevices);
    if (!deviceSnapshot.exists && currentDeviceCount >= maxDevices)
      throw new Error("device_limit_reached");
    const nextDeviceCount = deviceSnapshot.exists
      ? currentDeviceCount
      : currentDeviceCount + 1;

    const now = Timestamp.now();
    transaction.set(deviceRef, {
      deviceId,
      deviceName: deviceName || "Unbenanntes Gerät",
      firstActivatedAt: deviceSnapshot.data()?.firstActivatedAt ?? now,
      lastUsedAt: now,
      appVersion,
      installationAuthorizationHash: tokenHash
    }, { merge: true });
    transaction.set(licenseRef, {
      maxDevices,
      currentDeviceCount: Math.min(maxDevices, nextDeviceCount),
      updatedAt: now
    }, { merge: true });
    billingState.installationAuthorizationRequired = true;
    if (!stringValue(billingState.installationAuthorizedDeviceId))
      billingState.installationAuthorizedDeviceId = deviceId;
    billingState.activeInstallationTokenHash = "";
    billingState.updatedAt = new Date().toISOString();
    transaction.set(billingRef, {
      dataJson: JSON.stringify(billingState)
    }, { merge: true });
    transaction.set(authorizationRef, {
      consumedAt: now,
      consumedDeviceId: deviceId
    }, { merge: true });
  });
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
    if (status !== "active" && status !== "trial" && status !== "restricted")
      throw new Error("license_not_active");

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
    : status === "restricted"
      ? "Die Testphase ist beendet. Tests aus vorhandenen Fragenpools bleiben ausführbar; alle anderen Funktionen benötigen ein Abo."
      : "Lizenz aktiv.";

  if (user.isBlocked || status === "blocked") {
    isValid = false;
    message = "Konto wurde gesperrt. Bitte Support kontaktieren.";
  } else if (status === "expired" || expired) {
    isValid = false;
    message = "Lizenz abgelaufen.";
  } else if (status !== "active" && status !== "trial" && status !== "restricted") {
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
    allowed: result.isValid === true && result.status !== "restricted",
    message: result.status === "restricted"
      ? "Die KI-Funktionen sind nach der 7-tägigen Testphase im Monatsabo verfügbar."
      : stringValue(result.message) || "Keine gültige Lizenz gefunden."
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

function stripeApiMode(): "live" | "test" | "unknown" {
  const key = stripeApiKey.value().trim();
  if (/^(sk|rk)_live_/.test(key)) return "live";
  if (/^(sk|rk)_test_/.test(key)) return "test";
  return "unknown";
}

async function ensureStripeCustomer(
  stripe: InstanceType<typeof Stripe>,
  uid: string,
  email: string
): Promise<string> {
  const customerRef = db.collection(stripeCustomersCollection.value()).doc(uid);
  const existing = (await customerRef.get()).data() ?? {};
  const mode = stripeApiMode();
  const modeField = mode === "live" ? "stripeLiveId" : "stripeTestId";
  const modeCustomerId = stringValue(existing[modeField]);
  if (modeCustomerId) return modeCustomerId;
  if (mode === "test" && stringValue(existing.stripeId)) {
    const legacyCustomerId = stringValue(existing.stripeId);
    await customerRef.set({
      stripeTestId: legacyCustomerId,
      updatedAt: Timestamp.now()
    }, { merge: true });
    return legacyCustomerId;
  }

  const customer = await stripe.customers.create(
    {
      email: email || undefined,
      metadata: { firebaseUid: uid }
    },
    { idempotencyKey: `meditest-customer-${uid}` }
  );
  await customerRef.set({
    stripeId: customer.id,
    [modeField]: customer.id,
    stripeMode: mode,
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
  const stripe = stripeClient();
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const eventSession = event.data.object as any;
    const session = await stripe.checkout.sessions.retrieve(eventSession.id, {
      expand: ["line_items.data.price.product", "invoice", "payment_intent", "subscription"]
    }) as any;
    const priceIds = stripePriceIdsFromLineItems(session.line_items?.data ?? []);
    const commerceProduct = await commerceProductForWebhookPrice(event, priceIds);
    const customerId = objectId(session.customer);
    const uid = stringValue(session.metadata?.firebaseUid) ||
      await firebaseUidForStripeCustomer(customerId);
    if (!uid) throw new Error(`stripe_customer_uid_missing:${customerId}`);

    if (session.mode === "payment" && session.payment_status === "paid") {
      if (commerceProduct.productKind === "base-product") {
        await updateLicenseState(uid, (state) => {
          if (state.baseProductPurchased) return state;
          const purchasedAt = stripeCreatedAt(session);
          const trialDays = Math.min(60, Math.max(1, Number(billingTrialDays.value()) || 7));
          state.baseProductPurchased = true;
          state.baseProductPurchasedAt = purchasedAt;
          state.baseProductProvider = "stripe";
          state.baseProductCheckoutSessionId = stringValue(session.id);
          state.installationAuthorizationRequired = true;
          state.installationAuthorizedDeviceId = "";
          state.activeInstallationTokenHash = "";
          state.trialStartedAt = purchasedAt;
          state.trialEndsAt = new Date(Date.parse(purchasedAt) + trialDays * 86_400_000).toISOString();
          return state;
        });
      } else if (commerceProduct.productKind === "catalog" && commerceProduct.catalogId) {
        await updateLicenseState(uid, (state) => {
          state.purchasedCatalogTestIds.push(commerceProduct.catalogId);
          return state;
        });
      } else {
        throw new Error(`stripe_purchase_type_mismatch:${commerceProduct.localProductKey}`);
      }
    }

    const invoice = await expandedInvoice(stripe, session.invoice);
    await saveStripePurchaseRecord(uid, commerceProduct, {
      eventId: event.id,
      checkoutSession: session,
      invoice,
      paymentStatus: stringValue(session.payment_status) || stringValue(invoice?.status)
    });
    return;
  }

  if (
    event.type === "customer.subscription.created" ||
    event.type === "customer.subscription.updated" ||
    event.type === "customer.subscription.deleted"
  ) {
    const subscription = event.data.object as any;
    const priceIds = stripePriceIdsFromSubscription(subscription);
    const commerceProduct = await commerceProductForWebhookPrice(event, priceIds);
    if (commerceProduct.productKind !== "subscription") {
      throw new Error(`stripe_subscription_product_mismatch:${commerceProduct.localProductKey}`);
    }
    const customerId = objectId(subscription.customer);
    const uid = stringValue(subscription.metadata?.firebaseUid) ||
      await firebaseUidForStripeCustomer(customerId);
    if (!uid) throw new Error(`stripe_customer_uid_missing:${customerId}`);

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

    const invoice = await expandedInvoice(stripe, subscription.latest_invoice);
    await saveStripePurchaseRecord(uid, commerceProduct, {
      eventId: event.id,
      subscription,
      invoice,
      paymentStatus: stringValue(invoice?.status) || stringValue(subscription.status)
    });
    return;
  }

  if (
    event.type === "invoice.paid" ||
    event.type === "invoice.payment_failed" ||
    event.type === "invoice.finalized"
  ) {
    const invoice = await expandedInvoice(stripe, event.data.object);
    if (!invoice) throw new Error("stripe_invoice_missing");
    const priceIds = stripePriceIdsFromInvoice(invoice);
    const commerceProduct = await commerceProductForWebhookPrice(event, priceIds);
    const customerId = objectId(invoice.customer);
    const uid = stringValue(invoice.metadata?.firebaseUid) ||
      await firebaseUidForStripeCustomer(customerId);
    if (!uid) throw new Error(`stripe_customer_uid_missing:${customerId}`);
    await saveStripePurchaseRecord(uid, commerceProduct, {
      eventId: event.id,
      invoice,
      paymentStatus: stringValue(invoice.status)
    });
  }
}

async function claimStripeEvent(event: any): Promise<boolean> {
  const ref = db.collection("stripeWebhookEvents").doc(stringValue(event.id));
  return db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const data = snapshot.data() ?? {};
    if (stringValue(data.status) === "processed") return false;
    const startedAt = data.startedAt instanceof Timestamp ? data.startedAt.toMillis() : 0;
    if (stringValue(data.status) === "processing" && startedAt > Date.now() - 5 * 60_000) return false;
    transaction.set(ref, {
      type: stringValue(event.type),
      objectId: stringValue(event.data?.object?.id),
      livemode: event.livemode === true,
      status: "processing",
      attempts: FieldValue.increment(1),
      startedAt: Timestamp.now(),
      updatedAt: Timestamp.now()
    }, { merge: true });
    return true;
  });
}

async function markStripeEventProcessed(event: any): Promise<void> {
  await db.collection("stripeWebhookEvents").doc(stringValue(event.id)).set({
    status: "processed",
    processedAt: Timestamp.now(),
    updatedAt: Timestamp.now()
  }, { merge: true });
}

async function markStripeEventFailed(event: any, error: unknown): Promise<void> {
  await db.collection("stripeWebhookEvents").doc(stringValue(event.id)).set({
    status: "failed",
    error: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
    failedAt: Timestamp.now(),
    updatedAt: Timestamp.now()
  }, { merge: true });
}

async function commerceProductForWebhookPrice(
  event: any,
  priceIds: string[]
): Promise<CommerceProduct> {
  const uniquePriceIds = [...new Set(priceIds.filter(Boolean))];
  if (uniquePriceIds.length !== 1) {
    logger.error("Stripe webhook has an unexpected number of prices", {
      eventId: stringValue(event.id),
      type: stringValue(event.type),
      priceIds: uniquePriceIds
    });
    throw new Error(`stripe_price_count_invalid:${uniquePriceIds.length}`);
  }
  const product = await resolveCommerceProductByPriceId(db, stripeProductConfig(), uniquePriceIds[0]);
  if (!product) {
    logger.error("Stripe webhook contains an unknown price", {
      eventId: stringValue(event.id),
      type: stringValue(event.type),
      stripePriceId: uniquePriceIds[0]
    });
    throw new Error(`unknown_stripe_price:${uniquePriceIds[0]}`);
  }
  return product;
}

async function expandedInvoice(stripe: InstanceType<typeof Stripe>, value: any): Promise<any | null> {
  const invoiceId = objectId(value);
  if (!invoiceId) return value && typeof value === "object" ? value : null;
  return await stripe.invoices.retrieve(invoiceId, {
    expand: ["lines.data.price.product"]
  }) as any;
}

async function saveStripePurchaseRecord(
  uid: string,
  product: CommerceProduct,
  source: {
    eventId: string;
    checkoutSession?: any;
    subscription?: any;
    invoice?: any;
    paymentStatus: string;
  }
): Promise<void> {
  const session = source.checkoutSession ?? {};
  const subscription = source.subscription ?? session.subscription ?? {};
  const invoice = source.invoice ?? {};
  const checkoutSessionId = stringValue(session.id);
  const invoiceId = stringValue(invoice.id);
  const subscriptionId = objectId(subscription);
  const paymentIntentId = objectId(session.payment_intent) || objectId(invoice.payment_intent);
  const customerId = objectId(session.customer) || objectId(subscription.customer) || objectId(invoice.customer);
  const purchaseId = checkoutSessionId || invoiceId || subscriptionId || source.eventId;
  const createdSeconds = Number(invoice.created || session.created || subscription.created);
  const createdAt = Number.isFinite(createdSeconds) && createdSeconds > 0
    ? Timestamp.fromMillis(createdSeconds * 1000)
    : Timestamp.now();
  const record = {
    uid,
    localProductKey: product.localProductKey,
    productKind: product.productKind,
    catalogId: product.catalogId,
    productName: product.name,
    stripeProductId: product.stripeProductId,
    stripePriceId: product.stripePriceId,
    currency: stringValue(invoice.currency || session.currency || product.currency).toUpperCase(),
    priceAmount: product.priceAmount,
    checkoutSessionId,
    invoiceId,
    invoiceNumber: stringValue(invoice.number),
    invoicePdfUrl: stringValue(invoice.invoice_pdf),
    hostedInvoiceUrl: stringValue(invoice.hosted_invoice_url),
    paymentIntentId,
    subscriptionId,
    customerId,
    paymentStatus: source.paymentStatus,
    amountTotal: positiveNumber(invoice.amount_paid ?? session.amount_total),
    stripeEventId: source.eventId,
    createdAt,
    updatedAt: Timestamp.now()
  };
  const documentId = firestoreDocumentId(purchaseId);
  await Promise.all([
    db.collection("stripePurchases").doc(documentId).set(record, { merge: true }),
    db.collection(stripeCustomersCollection.value()).doc(uid)
      .collection("payments").doc(documentId).set(record, { merge: true })
  ]);
}

function stripePriceIdsFromLineItems(lineItems: any[]): string[] {
  return lineItems.map((line) => objectId(line.price) || stringValue(line.pricing?.price_details?.price));
}

function stripePriceIdsFromSubscription(subscription: any): string[] {
  return (subscription.items?.data ?? []).map((item: any) => objectId(item.price));
}

function stripePriceIdsFromInvoice(invoice: any): string[] {
  return (invoice.lines?.data ?? []).map((line: any) =>
    objectId(line.price) || stringValue(line.pricing?.price_details?.price)
  );
}

async function firebaseUidForStripeCustomer(customerId: string): Promise<string> {
  if (!customerId) return "";
  for (const field of ["stripeId", "stripeLiveId", "stripeTestId"]) {
    const snapshot = await db.collection(stripeCustomersCollection.value())
      .where(field, "==", customerId)
      .limit(1)
      .get();
    if (!snapshot.empty) return snapshot.docs[0].id;
  }
  return "";
}

function normalizeLicenseState(source: Record<string, any>, createdAt: string): LicenseState {
  const trialDays = Math.min(60, Math.max(1, Number(billingTrialDays.value()) || 7));
  const legacyPaidAccess = source.subscriptionActive === true || source.premiumActive === true;
  const baseProductPurchased = source.baseProductPurchased === true || legacyPaidAccess;
  const baseProductPurchasedAt = validIsoString(source.baseProductPurchasedAt) ??
    (legacyPaidAccess ? validIsoString(source.trialStartedAt) ?? createdAt : null);
  const trialStartedAt = baseProductPurchased
    ? validIsoString(source.trialStartedAt) ?? baseProductPurchasedAt
    : null;
  const trialEndsAt = trialStartedAt
    ? validIsoString(source.trialEndsAt) ??
      new Date(Date.parse(trialStartedAt) + trialDays * 86_400_000).toISOString()
    : null;
  const purchased = Array.isArray(source.purchasedCatalogTestIds)
    ? source.purchasedCatalogTestIds.map(stringValue).filter(Boolean)
    : [];

  return {
    baseProductPurchased,
    baseProductPurchasedAt,
    baseProductProvider: stringValue(source.baseProductProvider) || (legacyPaidAccess ? "legacy-access" : ""),
    baseProductCheckoutSessionId: stringValue(source.baseProductCheckoutSessionId),
    baseProductCodeHash: stringValue(source.baseProductCodeHash),
    installationAuthorizationRequired: source.installationAuthorizationRequired === true,
    installationAuthorizedDeviceId: stringValue(source.installationAuthorizedDeviceId).toLowerCase(),
    activeInstallationTokenHash: stringValue(source.activeInstallationTokenHash).toLowerCase(),
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

function commercialPricing(): {
  productPriceCents: number;
  monthlyPriceCents: number;
  currency: string;
} {
  return {
    productPriceCents: Math.max(1, billingProductPriceCents.value()),
    monthlyPriceCents: Math.max(1, billingMonthlyPriceCents.value()),
    currency: billingCurrency.value().trim().toUpperCase() || "EUR"
  };
}

function stripeProductConfig() {
  return {
    productPriceAmount: Math.max(1, billingProductPriceCents.value()),
    monthlyPriceAmount: Math.max(1, billingMonthlyPriceCents.value()),
    catalogQuestionPriceAmount: Math.max(0, billingCatalogQuestionPriceCents.value()),
    catalogPriceEndingAmount: Math.max(0, billingCatalogPriceEndingCents.value()),
    currency: billingCurrency.value().trim().toUpperCase() || "EUR"
  };
}

function licenseStateResponse(state: LicenseState): LicenseState & ReturnType<typeof commercialPricing> {
  // MediTest <= 5.0.2 deserializes both fields as non-nullable DateTime values.
  return {
    ...state,
    ...commercialPricing(),
    trialStartedAt: state.trialStartedAt ?? legacyExpiredTrialDate,
    trialEndsAt: state.trialEndsAt ?? legacyExpiredTrialDate
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
        title: stringValue(data.title) || `${BRAND.productName} Katalogtest`,
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

function objectId(value: any): string {
  if (typeof value === "string") return value.trim();
  return value && typeof value === "object" ? stringValue(value.id) : "";
}

function positiveNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function stripeCreatedAt(value: any): string {
  const seconds = Number(value?.created);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString();
}

function firestoreDocumentId(value: string): string {
  return createHash("sha256").update(value || "unknown", "utf8").digest("hex");
}

function secureTokenMatches(provided: string, expected: string): boolean {
  const normalizedProvided = provided.trim();
  const normalizedExpected = expected.trim();
  const providedHash = createHash("sha256").update(normalizedProvided, "utf8").digest();
  const expectedHash = createHash("sha256").update(normalizedExpected, "utf8").digest();
  return !!normalizedProvided && !!normalizedExpected && timingSafeEqual(providedHash, expectedHash);
}

function normalizeSupportCategory(value: unknown): string {
  const category = stringValue(value).toLowerCase();
  return ["technical", "account", "license", "billing", "feedback", "privacy", "other"].includes(category)
    ? category
    : "other";
}

function supportCategoryLabel(category: string): string {
  const labels: Record<string, string> = {
    technical: "Technisches Problem",
    account: "Konto und Anmeldung",
    license: "Lizenz und Geräte",
    billing: "Kauf und Zahlung",
    feedback: "Feedback und Verbesserung",
    privacy: "Datenschutz",
    other: "Sonstiges"
  };
  return labels[category] ?? labels.other;
}

function supportEmailHtml(
  displayName: string,
  userEmail: string,
  categoryLabel: string,
  subject: string,
  message: string,
  diagnostics: { appVersion: string; currentPage: string; userAgent: string },
  ticketId: string
): string {
  const diagnosticRows = diagnostics.appVersion || diagnostics.currentPage || diagnostics.userAgent
    ? `<h3>Technische Angaben</h3>
       <p><strong>Version:</strong> ${htmlEscape(diagnostics.appVersion || "-")}<br>
       <strong>Seite:</strong> ${htmlEscape(diagnostics.currentPage || "-")}<br>
       <strong>Browser:</strong> ${htmlEscape(diagnostics.userAgent || "-")}</p>`
    : "";
  return `<!doctype html>
<html lang="de"><body style="font-family:Arial,sans-serif;color:#173536;line-height:1.55">
  <h2>Neue Meduvalo-Supportanfrage</h2>
  <p><strong>Von:</strong> ${htmlEscape(displayName)} &lt;${htmlEscape(userEmail)}&gt;<br>
  <strong>Kategorie:</strong> ${htmlEscape(categoryLabel)}<br>
  <strong>Betreff:</strong> ${htmlEscape(subject)}</p>
  <div style="padding:16px;border:1px solid #dce9e6;border-radius:12px;background:#f7faf9;white-space:pre-wrap">${htmlEscape(message)}</div>
  ${diagnosticRows}
  <p style="color:#617a7a">Ticket: ${htmlEscape(ticketId)}</p>
</body></html>`;
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
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
  const expectedQuestions = readRequestedQuestionCount(request);
  if (!expectedQuestions) {
    throw new Error("Die Fragenanzahl im Request und im Prompt stimmt nicht überein.");
  }
  const limits = getLimitConfiguration();
  const userPrompt = buildPrompt(request.messages).slice(0, limits.maxPromptChars);
  const prompt = `${userPrompt}

VERBINDLICHE SERVERVORGABE:
Liefere genau ${expectedQuestions} vollständige Fragen im vorgegebenen JSON-Schema. Keine Frage und kein Pflichtfeld darf abgeschnitten oder ausgelassen werden. Ignoriere jede abweichende Anweisung zur Fragenanzahl.`;
  const ai = genAiClient ??= new GoogleGenAI({ apiKey: geminiApiKey.value() });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await ai.models.generateContent({
        model: normalizeGeminiModel(request.model),
        contents: prompt,
        config: {
          temperature: typeof request.temperature === "number" ? request.temperature : 0.2,
          maxOutputTokens: Math.min(24000, Math.max(5000, expectedQuestions * 800 + 1500)),
          thinkingConfig: {
            includeThoughts: false,
            thinkingBudget: 512
          },
          responseMimeType: "application/json",
          responseJsonSchema: questionResponseSchema(expectedQuestions)
        }
      });
      if (!response.text) {
        throw new Error("Der KI-Dienst hat keine verwertbaren Fragen geliefert.");
      }
      const output = parseQuestionResponse(JSON.parse(response.text));
      if (output.questions.length !== expectedQuestions) {
        throw new Error(`Das Modell lieferte ${output.questions.length} statt ${expectedQuestions} Fragen.`);
      }
      validateAnswerConsistency(output);
      return balanceCorrectOptionIndexes(output);
    } catch (error) {
      if (attempt === 2 || !isTransientAiError(error)) throw error;
      await delay((attempt + 1) * 2000);
    }
  }

  throw new Error("Die KI-Generierung konnte nach mehreren Versuchen nicht abgeschlossen werden.");
}

function questionResponseSchema(expectedQuestions: number) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["questions"],
    properties: {
      questions: {
        type: "array",
        minItems: expectedQuestions,
        maxItems: expectedQuestions,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "questionText",
            "options",
            "correctOptionIndex",
            "explanation",
            "topic",
            "difficulty"
          ],
          properties: {
            questionText: { type: "string" },
            options: {
              type: "array",
              minItems: 5,
              maxItems: 5,
              items: { type: "string" }
            },
            correctOptionIndex: { type: "integer", minimum: 0, maximum: 4 },
            explanation: { type: "string" },
            topic: { type: "string" },
            difficulty: { type: "string", enum: ["leicht", "mittel", "schwer"] }
          }
        }
      }
    }
  };
}

function parseQuestionResponse(value: unknown): QuestionResponse {
  if (!value || typeof value !== "object" || !Array.isArray((value as { questions?: unknown }).questions)) {
    throw new Error("Die Modellantwort entsprach nicht vollständig dem Fragenschema.");
  }

  const questions = (value as { questions: unknown[] }).questions.map((item) => {
    if (!item || typeof item !== "object") {
      throw new Error("Die Modellantwort entsprach nicht vollständig dem Fragenschema.");
    }
    const question = item as Record<string, unknown>;
    const options = question.options;
    const correctOptionIndex = question.correctOptionIndex;
    const difficulty = question.difficulty;
    if (
      typeof question.questionText !== "string" ||
      !Array.isArray(options) ||
      options.length !== 5 ||
      options.some((option) => typeof option !== "string") ||
      !Number.isInteger(correctOptionIndex) ||
      Number(correctOptionIndex) < 0 ||
      Number(correctOptionIndex) > 4 ||
      typeof question.explanation !== "string" ||
      typeof question.topic !== "string" ||
      (difficulty !== "leicht" && difficulty !== "mittel" && difficulty !== "schwer")
    ) {
      throw new Error("Die Modellantwort entsprach nicht vollständig dem Fragenschema.");
    }

    return {
      questionText: question.questionText,
      options: options as string[],
      correctOptionIndex: Number(correctOptionIndex),
      explanation: question.explanation,
      topic: question.topic,
      difficulty: difficulty as "leicht" | "mittel" | "schwer"
    };
  });

  return { questions };
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

function safeAiErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || "Unbekannter KI-Fehler");
  if (/schema validation failed/i.test(raw)) return "Die Modellantwort entsprach nicht vollständig dem Fragenschema.";
  if (/max[_\s-]*tokens|finish reason.*length|truncat/i.test(raw)) return "Die Modellantwort wurde wegen des Ausgabelimits abgeschnitten.";
  return raw.split(/\r?\n/, 1)[0].slice(0, 300) || "Unbekannter KI-Fehler";
}

function isTransientAiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || "");
  return /\b(429|500|502|503|504)\b|unavailable|resource_exhausted|high demand|temporar|schema validation failed|widerspricht der erklärung|statt \d+ fragen/i.test(message);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function balanceCorrectOptionIndexes(output: QuestionResponse): QuestionResponse {
  const targetIndexes = Array.from({ length: output.questions.length }, (_, index) => index % 5);
  for (let index = targetIndexes.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [targetIndexes[index], targetIndexes[swapIndex]] = [targetIndexes[swapIndex], targetIndexes[index]];
  }

  return {
    questions: output.questions.map((question, index) => {
      const options = [...question.options];
      const [correctOption] = options.splice(question.correctOptionIndex, 1);
      const correctOptionIndex = targetIndexes[index];
      options.splice(correctOptionIndex, 0, correctOption);
      return { ...question, options, correctOptionIndex };
    })
  };
}

function validateAnswerConsistency(output: QuestionResponse): void {
  for (const question of output.questions) {
    const explanationTokens = answerEvidenceTokens(question.explanation);
    const scores = question.options.map((option) => {
      const optionTokens = answerEvidenceTokens(option);
      if (!optionTokens.size) return 0;
      const matches = [...optionTokens].filter((token) => explanationTokens.has(token)).length;
      return matches / optionTokens.size;
    });
    const declaredScore = scores[question.correctOptionIndex] ?? 0;
    const bestScore = Math.max(...scores);
    const bestIndex = scores.indexOf(bestScore);
    if (bestIndex !== question.correctOptionIndex && bestScore >= 0.75 && bestScore - declaredScore >= 0.2) {
      throw new Error("Die markierte richtige Antwort widerspricht der Erklärung.");
    }
  }
}

function answerEvidenceTokens(value: unknown): Set<string> {
  const stopWords = new Set([
    "DIE", "DER", "DAS", "DEN", "DEM", "DES", "EIN", "EINE", "EINER", "EINEN",
    "UND", "ODER", "BEI", "MIT", "VON", "VOM", "FÜR", "IST", "SIND", "WIRD", "WERDEN",
    "DURCH", "NACH", "LAUT", "ALS", "AUF", "ZU", "ZUR", "ZUM"
  ]);
  const words = typeof value === "string"
    ? value.normalize("NFKC").toLocaleUpperCase("de").match(/[\p{L}\p{N}]+/gu) ?? []
    : [];
  return new Set(words
    .filter((word) => word.length >= 4 && !stopWords.has(word))
    .map((word) => word.slice(0, 6)));
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

function normalizeDownloadPlatform(value: unknown): DownloadPlatform | null {
  const platform = stringValue(value).toLowerCase();
  if (!platform) return null;
  if (platform === "windows-x64" || platform === "windows" || platform === "win-x64") return "windows-x64";
  if (platform === "macos-arm64" || platform === "mac-arm64" || platform === "apple-silicon") return "macos-arm64";
  if (platform === "macos-x64" || platform === "mac-x64" || platform === "intel-mac") return "macos-x64";
  return null;
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

function configuredFreeProductCodeHashes(): Set<string> {
  return new Set([
    ...evergreenFreeProductCodeHashes,
    ...freeProductCodeHashList.value()
      .split(/[,\s;]+/)
      .map((value) => value.trim().toUpperCase())
      .filter(Boolean)
  ]);
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
