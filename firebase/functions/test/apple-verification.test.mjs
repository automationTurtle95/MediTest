// Sicherheitstest fuer die Apple-IAP-Belegpruefung (SEC-002).
//
// Start:  cd firebase/functions && npm run build && node --test test/
//
// Warum eine eigene Zertifikatskette: Ein Pruefer, der jeden Beleg ablehnt,
// wuerde einen reinen Ablehnungs-Test bestehen. Deshalb baut dieser Test eine
// vollstaendige, Apple-foermige Kette (Root -> Intermediate -> Leaf, ES256,
// inklusive der von der Bibliothek verlangten Apple-OIDs) und beweist beide
// Richtungen: ein korrekt signierter Beleg wird ANGENOMMEN, ein manipulierter
// oder fremd signierter wird ABGELEHNT.
//
// Es werden keine echten Apple-Belege und keine Netzverbindung gebraucht.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const { verifyAppleTransaction, evaluateAppleTransaction } = await import("../lib/index.js");

const BUNDLE_ID = "at.meduvalo.app";
const PRODUCT_ID = "at.meduvalo.app.premium";

// Von der Bibliothek geforderte Apple-Erweiterungen (jws_verification.js):
const OID_LEAF = "1.2.840.113635.100.6.11.1";
const OID_INTERMEDIATE = "1.2.840.113635.100.6.2.1";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sec002-"));
const F = (n) => path.join(tmp, n);
const ossl = (args, input) =>
  execFileSync("openssl", args, { input, stdio: ["pipe", "pipe", "pipe"] });

function buildChain() {
  // --- Root ---
  ossl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", F("root.key")]);
  ossl(["req", "-new", "-x509", "-key", F("root.key"), "-out", F("root.pem"),
        "-days", "2", "-subj", "/CN=Test Root CA"]);

  // --- Intermediate (braucht OID_INTERMEDIATE) ---
  ossl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", F("int.key")]);
  ossl(["req", "-new", "-key", F("int.key"), "-out", F("int.csr"), "-subj", "/CN=Test Intermediate"]);
  fs.writeFileSync(F("int.ext"), `basicConstraints=critical,CA:TRUE\n${OID_INTERMEDIATE}=ASN1:NULL\n`);
  ossl(["x509", "-req", "-in", F("int.csr"), "-CA", F("root.pem"), "-CAkey", F("root.key"),
        "-CAcreateserial", "-out", F("int.pem"), "-days", "2", "-extfile", F("int.ext")]);

  // --- Leaf (braucht OID_LEAF) ---
  ossl(["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", F("leaf.key")]);
  ossl(["req", "-new", "-key", F("leaf.key"), "-out", F("leaf.csr"), "-subj", "/CN=Test Leaf"]);
  fs.writeFileSync(F("leaf.ext"), `basicConstraints=critical,CA:FALSE\n${OID_LEAF}=ASN1:NULL\n`);
  ossl(["x509", "-req", "-in", F("leaf.csr"), "-CA", F("int.pem"), "-CAkey", F("int.key"),
        "-CAcreateserial", "-out", F("leaf.pem"), "-days", "2", "-extfile", F("leaf.ext")]);

  const der = (pem) => ossl(["x509", "-in", F(pem), "-outform", "DER"]);
  const b64 = (pem) => der(pem).toString("base64");

  return {
    rootDer: der("root.pem"),
    x5c: [b64("leaf.pem"), b64("int.pem"), b64("root.pem")],
    leafKey: fs.readFileSync(F("leaf.key"), "utf8"),
  };
}

const chain = buildChain();

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");

/** Baut einen JWS wie StoreKit 2: Header mit x5c-Kette, ES256-Signatur. */
function signJws(payload, { key = chain.leafKey, x5c = chain.x5c } = {}) {
  const header = b64url(JSON.stringify({ alg: "ES256", x5c }));
  const body = b64url(JSON.stringify(payload));
  const signer = crypto.createSign("SHA256");
  signer.update(`${header}.${body}`);
  signer.end();
  const sig = signer.sign({ key, dsaEncoding: "ieee-p1363" });
  return `${header}.${body}.${b64url(sig)}`;
}

const gueltigePayload = (over = {}) => ({
  bundleId: BUNDLE_ID,
  productId: PRODUCT_ID,
  transactionId: "2000000111222333",
  originalTransactionId: "2000000111222333",
  environment: "Sandbox",
  type: "Non-Consumable",
  signedDate: Date.now(),
  purchaseDate: Date.now(),
  ...over,
});

const OVERRIDES = { rootCertificates: [chain.rootDer], enableOnlineChecks: false };

// ---------------------------------------------------------------------------
// Signaturpfad – beide Richtungen
// ---------------------------------------------------------------------------

test("korrekt signierter Beleg wird ANGENOMMEN (Positivpfad)", async () => {
  const jws = signJws(gueltigePayload());
  const payload = await verifyAppleTransaction(jws, OVERRIDES);
  assert.equal(payload.bundleId, BUNDLE_ID);
  assert.equal(payload.productId, PRODUCT_ID);
  assert.equal(payload.transactionId, "2000000111222333");
});

test("nachtraeglich veraenderte Nutzlast wird ABGELEHNT", async () => {
  const jws = signJws(gueltigePayload());
  const [h, , s] = jws.split(".");
  const manipuliert = b64url(JSON.stringify(gueltigePayload({ transactionId: "9999999999" })));
  await assert.rejects(() => verifyAppleTransaction(`${h}.${manipuliert}.${s}`, OVERRIDES));
});

test("Beleg mit fremder Wurzel-CA wird ABGELEHNT", async () => {
  const fremd = buildChain();
  const jws = signJws(gueltigePayload(), { key: fremd.leafKey, x5c: fremd.x5c });
  // Verifiziert gegen UNSERE Wurzel -> Kette passt nicht.
  await assert.rejects(() => verifyAppleTransaction(jws, OVERRIDES));
});

test("Beleg ohne Signatur wird ABGELEHNT", async () => {
  const header = b64url(JSON.stringify({ alg: "none", x5c: chain.x5c }));
  const body = b64url(JSON.stringify(gueltigePayload()));
  await assert.rejects(() => verifyAppleTransaction(`${header}.${body}.`, OVERRIDES));
});

test("environment Xcode erreicht den Skip-Pfad der Bibliothek NICHT", async () => {
  // jws_verification.js ueberspringt bei XCODE/LOCAL_TESTING die
  // Signaturpruefung. peekEnvironment darf diese Werte deshalb nie uebernehmen.
  const jws = signJws(gueltigePayload({ environment: "Xcode" }));
  await assert.rejects(() => verifyAppleTransaction(jws, OVERRIDES));
});

test("fremde bundleId wird schon von der Bibliothek ABGELEHNT", async () => {
  const jws = signJws(gueltigePayload({ bundleId: "com.angreifer.app" }));
  await assert.rejects(() => verifyAppleTransaction(jws, OVERRIDES));
});

// ---------------------------------------------------------------------------
// Inhaltliche Pruefung
// ---------------------------------------------------------------------------

test("gueltiger Beleg passiert die inhaltliche Pruefung", () => {
  const r = evaluateAppleTransaction(gueltigePayload());
  assert.equal(r.ok, true);
  assert.equal(r.originalTransactionId, "2000000111222333");
});

test("fremdes Produkt wird abgewiesen", () => {
  const r = evaluateAppleTransaction(gueltigePayload({ productId: "at.meduvalo.app.irgendwas" }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "product_mismatch");
});

test("fremde App wird abgewiesen", () => {
  const r = evaluateAppleTransaction(gueltigePayload({ bundleId: "com.angreifer.app" }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "bundle_mismatch");
});

test("zurueckerstatteter Kauf schaltet nichts frei", () => {
  const mitDatum = evaluateAppleTransaction(gueltigePayload({ revocationDate: Date.now() }));
  assert.equal(mitDatum.code, "transaction_revoked");
  const mitGrund = evaluateAppleTransaction(gueltigePayload({ revocationReason: 0 }));
  assert.equal(mitGrund.code, "transaction_revoked", "revocationReason 0 muss ebenfalls greifen");
});

test("fehlende Transaktionsnummer wird abgewiesen", () => {
  const r = evaluateAppleTransaction(gueltigePayload({ transactionId: "", originalTransactionId: "" }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "invalid_transaction");
});

test("originalTransactionId faellt auf transactionId zurueck", () => {
  const r = evaluateAppleTransaction(gueltigePayload({ originalTransactionId: "" }));
  assert.equal(r.ok, true);
  assert.equal(r.originalTransactionId, "2000000111222333");
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Entzug beim Uebertragen eines Belegs (11.11.2026)
// ---------------------------------------------------------------------------

const { entzieheIosAnspruch } = await import("../lib/index.js");

const zustand = (over = {}) => ({
  premiumActive: true,
  premiumProvider: "ios_iap",
  premiumGrantedAt: "2026-11-11T14:45:41.881Z",
  baseProductPurchased: true,
  baseProductProvider: "ios_iap",
  baseProductPurchasedAt: "2026-11-11T14:45:41.881Z",
  subscriptionActive: false,
  subscriptionProvider: "",
  ...over,
});

test("Entzug nimmt den iOS-Anspruch weg", () => {
  const s = entzieheIosAnspruch(zustand());
  assert.equal(s.premiumActive, false);
  assert.equal(s.premiumProvider, "");
  assert.equal(s.premiumGrantedAt, null);
  assert.equal(s.baseProductPurchased, false);
  assert.equal(s.baseProductProvider, "");
});

test("Entzug laesst einen per Stripe bezahlten Anspruch unberuehrt", () => {
  // Der wichtigere Fall: Wer unabhaengig per Stripe bezahlt hat, darf durch
  // die Uebertragung eines iOS-Belegs nichts verlieren.
  const s = entzieheIosAnspruch(zustand({
    premiumProvider: "stripe",
    baseProductProvider: "stripe",
  }));
  assert.equal(s.premiumActive, true, "Stripe-Premium muss bleiben");
  assert.equal(s.premiumProvider, "stripe");
  assert.equal(s.baseProductPurchased, true, "Stripe-Kauf muss bleiben");
  assert.equal(s.baseProductProvider, "stripe");
});

test("Entzug laesst einen per Code freigeschalteten Anspruch unberuehrt", () => {
  const s = entzieheIosAnspruch(zustand({
    premiumProvider: "premium-code",
    baseProductProvider: "product-code",
  }));
  assert.equal(s.premiumActive, true);
  assert.equal(s.baseProductPurchased, true);
});

test("Entzug greift feldweise, nicht pauschal", () => {
  // Mischfall: Premium per Code, Grundprodukt per iOS-Kauf.
  const s = entzieheIosAnspruch(zustand({ premiumProvider: "premium-code" }));
  assert.equal(s.premiumActive, true, "Code-Premium bleibt");
  assert.equal(s.baseProductPurchased, false, "iOS-Grundprodukt geht weg");
});

test("Entzug ist mehrfach anwendbar ohne Nebenwirkung", () => {
  const einmal = entzieheIosAnspruch(zustand());
  const zweimal = entzieheIosAnspruch({ ...einmal });
  assert.deepEqual(zweimal.premiumActive, einmal.premiumActive);
  assert.equal(zweimal.premiumProvider, "");
});
