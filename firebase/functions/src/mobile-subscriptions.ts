// Server-seitige Verifikation von Mobile-Store-Abos (Apple + Google).
// Ersetzt das unsichere clientseitige "subscriptionActive=true" der App:
//  - Verify-at-Purchase: die App schickt den Kaufbeleg, der Server prüft ihn.
//  - Webhooks (Apple ASSN v2 / Google RTDN): Verlängerung/Kündigung/Ablauf.
//
// WICHTIG: googleapis + die Apple-Lib werden LAZY (dynamic import) geladen –
// sonst timeouten sie die Firebase-Function-Analyse beim Deploy (googleapis ist riesig).
//
// Konfiguration (siehe Runbook im Projekt-Doc):
//  - Apple Root CA Zertifikate (öffentlich) unter functions/apple-certs/ ablegen.
//  - Google Play Service-Account-JSON als Secret GOOGLE_PLAY_SERVICE_ACCOUNT.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  JWSTransactionDecodedPayload,
  ResponseBodyV2DecodedPayload,
} from "@apple/app-store-server-library";

export const APPLE_BUNDLE_ID = "at.meduvalo.app";
export const ANDROID_PACKAGE_NAME = "at.meduvalo.app";

export type MobileSubscription = {
  active: boolean;
  productId: string;
  expiryMs: number | null;
  // Eindeutiger Schlüssel für die uid-Zuordnung (Apple: originalTransactionId,
  // Google: purchaseToken).
  linkKey: string;
};

// ─── Apple ───────────────────────────────────────────────────────────────────

function loadAppleRootCerts(): Buffer[] {
  const dir = join(__dirname, "..", "apple-certs");
  const names = [
    "AppleComputerRootCertificate.cer",
    "AppleIncRootCertificate.cer",
    "AppleRootCA-G2.cer",
    "AppleRootCA-G3.cer",
  ];
  const certs: Buffer[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (existsSync(path)) certs.push(readFileSync(path));
  }
  if (certs.length === 0) {
    throw new Error(
      "apple_root_certs_missing: Apple Root CA Zertifikate unter functions/apple-certs/ ablegen."
    );
  }
  return certs;
}

async function decodeAppleTransaction(
  signedTransaction: string,
  sandbox?: boolean
): Promise<JWSTransactionDecodedPayload> {
  const lib = await import("@apple/app-store-server-library");
  const certs = loadAppleRootCerts();
  const verifier = (prod: boolean) =>
    new lib.SignedDataVerifier(
      certs,
      true,
      prod ? lib.Environment.PRODUCTION : lib.Environment.SANDBOX,
      APPLE_BUNDLE_ID
    );
  if (sandbox !== undefined) {
    return verifier(!sandbox).verifyAndDecodeTransaction(signedTransaction);
  }
  // Produktion zuerst, sonst Sandbox (Review-/Testkäufe).
  try {
    return await verifier(true).verifyAndDecodeTransaction(signedTransaction);
  } catch (_) {
    return verifier(false).verifyAndDecodeTransaction(signedTransaction);
  }
}

function subscriptionFromTransaction(
  tx: JWSTransactionDecodedPayload
): MobileSubscription {
  const expiryMs = typeof tx.expiresDate === "number" ? tx.expiresDate : null;
  const active = expiryMs !== null ? expiryMs > Date.now() : true;
  return {
    active,
    productId: tx.productId ?? "",
    expiryMs,
    linkKey: tx.originalTransactionId ?? "",
  };
}

// Verify-at-Purchase: signierte StoreKit-Transaktion (JWS) prüfen.
export async function verifyAppleSignedTransaction(
  signedTransaction: string
): Promise<MobileSubscription & { appAccountToken: string }> {
  const tx = await decodeAppleTransaction(signedTransaction);
  return {
    ...subscriptionFromTransaction(tx),
    appAccountToken: tx.appAccountToken ?? "",
  };
}

// Webhook: signierte ASSN-v2-Notification prüfen und Transaktion extrahieren.
export async function decodeAppleNotification(signedPayload: string): Promise<{
  notificationType: string;
  subtype: string;
  subscription: MobileSubscription | null;
}> {
  const lib = await import("@apple/app-store-server-library");
  const certs = loadAppleRootCerts();
  const verifier = (prod: boolean) =>
    new lib.SignedDataVerifier(
      certs,
      true,
      prod ? lib.Environment.PRODUCTION : lib.Environment.SANDBOX,
      APPLE_BUNDLE_ID
    );
  let decoded: ResponseBodyV2DecodedPayload;
  try {
    decoded = await verifier(true).verifyAndDecodeNotification(signedPayload);
  } catch (_) {
    decoded = await verifier(false).verifyAndDecodeNotification(signedPayload);
  }
  const isSandbox = decoded.data?.environment === lib.Environment.SANDBOX;
  let subscription: MobileSubscription | null = null;
  const signedTx = decoded.data?.signedTransactionInfo;
  if (signedTx) {
    const tx = await decodeAppleTransaction(signedTx, isSandbox);
    subscription = subscriptionFromTransaction(tx);
  }
  return {
    notificationType: String(decoded.notificationType ?? ""),
    subtype: String(decoded.subtype ?? ""),
    subscription,
  };
}

// Ableitung des Aktiv-Status aus dem Notification-Typ.
export function appleNotificationActive(
  notificationType: string,
  expiryMs: number | null
): boolean {
  const revoked = ["EXPIRED", "REFUND", "REVOKE", "GRACE_PERIOD_EXPIRED"];
  if (revoked.includes(notificationType)) return false;
  if (expiryMs !== null) return expiryMs > Date.now();
  return true;
}

// ─── Google ──────────────────────────────────────────────────────────────────

// Verify-at-Purchase + Webhook: Abo-Status per Play Developer API prüfen.
export async function verifyGooglePurchase(
  productId: string,
  purchaseToken: string,
  serviceAccountJson: string
): Promise<MobileSubscription> {
  const { google } = await import("googleapis");
  const credentials = JSON.parse(serviceAccountJson);
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  const publisher = google.androidpublisher({ version: "v3", auth });
  const res = await publisher.purchases.subscriptionsv2.get({
    packageName: ANDROID_PACKAGE_NAME,
    token: purchaseToken,
  });
  const data = res.data;
  const state = String(data.subscriptionState ?? "");
  const active =
    state === "SUBSCRIPTION_STATE_ACTIVE" ||
    state === "SUBSCRIPTION_STATE_IN_GRACE_PERIOD";
  let expiryMs: number | null = null;
  const expiry = data.lineItems?.[0]?.expiryTime;
  if (expiry) {
    const parsed = Date.parse(expiry);
    if (Number.isFinite(parsed)) expiryMs = parsed;
  }
  return { active, productId, expiryMs, linkKey: purchaseToken };
}

// Google RTDN: Pub/Sub-Push-Body dekodieren.
export function decodeGoogleRtdn(body: any): {
  purchaseToken: string;
  subscriptionId: string;
  notificationType: number;
} | null {
  const dataB64 = body?.message?.data;
  if (typeof dataB64 !== "string") return null;
  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(dataB64, "base64").toString("utf8"));
  } catch (_) {
    return null;
  }
  const sub = parsed?.subscriptionNotification;
  if (!sub?.purchaseToken) return null;
  return {
    purchaseToken: String(sub.purchaseToken),
    subscriptionId: String(sub.subscriptionId ?? ""),
    notificationType: Number(sub.notificationType ?? 0),
  };
}
