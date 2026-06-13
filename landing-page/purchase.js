"use strict";

const PURCHASE_CONFIG = Object.freeze({
  authApiKey: "AIzaSyDEjGbBYXrI4mulyP95mZuJE-UEhUuZSMY",
  sessionKey: "meditest-purchase-session",
  checkoutEndpoint: "./api/purchase/checkout",
  statusEndpoint: "./api/purchase/status",
  downloadEndpoint: "./api/purchase/download",
  redeemCodeEndpoint: "./api/purchase/redeem-code"
});

const DOWNLOAD_PRODUCTS = Object.freeze({
  "windows-x64": {
    kicker: "Windows-Version",
    lead: "Melde dich an oder erstelle ein Konto. Der einmalige Kauf schaltet den Windows-MSI-Installer und eine 7-tägige Testphase mit allen Funktionen frei.",
    name: "Meduvalo für Windows 10 & 11",
    details: "64-Bit · MSI-Installer · Version 5.0.8",
    benefit: "Windows-MSI direkt nach erfolgreicher Zahlung",
    success: "Dein Kauf ist aktiv und deine 7-tägige Testphase hat begonnen. Der MSI-Installer kann jetzt heruntergeladen werden.",
    downloadLabel: "Windows MSI herunterladen",
    apple: false
  },
  "macos-arm64": {
    kicker: "macOS · Apple Silicon",
    lead: "Melde dich an oder erstelle ein Konto. Der einmalige Kauf schaltet das signierte und von Apple notarisierte DMG für Apple Silicon sowie eine 7-tägige Testphase frei.",
    name: "Meduvalo für Mac mit Apple Chip",
    details: "Apple Silicon · signiertes DMG · macOS 11+ · Version 5.0.8",
    benefit: "Notarisiertes macOS-DMG direkt nach erfolgreicher Zahlung",
    success: "Dein Kauf ist aktiv und deine 7-tägige Testphase hat begonnen. Das DMG für Apple Silicon kann jetzt heruntergeladen werden.",
    downloadLabel: "Mac-DMG für Apple Silicon herunterladen",
    apple: true
  },
  "macos-x64": {
    kicker: "macOS · Intel",
    lead: "Melde dich an oder erstelle ein Konto. Der einmalige Kauf schaltet das signierte und von Apple notarisierte DMG für Intel-Macs sowie eine 7-tägige Testphase frei.",
    name: "Meduvalo für Intel-Mac",
    details: "Intel 64-Bit · signiertes DMG · macOS 11+ · Version 5.0.8",
    benefit: "Notarisiertes macOS-DMG direkt nach erfolgreicher Zahlung",
    success: "Dein Kauf ist aktiv und deine 7-tägige Testphase hat begonnen. Das DMG für Intel-Macs kann jetzt heruntergeladen werden.",
    downloadLabel: "Mac-DMG für Intel herunterladen",
    apple: true
  }
});

function selectedDownloadPlatform() {
  const requested = new URLSearchParams(location.search).get("platform") || "";
  return Object.prototype.hasOwnProperty.call(DOWNLOAD_PRODUCTS, requested) ? requested : "windows-x64";
}

const downloadPlatform = selectedDownloadPlatform();
const downloadProduct = DOWNLOAD_PRODUCTS[downloadPlatform];
const authPanel = document.getElementById("authPanel");
const checkoutPanel = document.getElementById("checkoutPanel");
const loginTab = document.getElementById("loginTab");
const registerTab = document.getElementById("registerTab");
const authForm = document.getElementById("purchaseAuthForm");
const authSubmit = document.getElementById("authSubmit");
const emailInput = document.getElementById("purchaseEmail");
const passwordInput = document.getElementById("purchasePassword");
const resendVerification = document.getElementById("resendVerification");
const signedInEmail = document.getElementById("signedInEmail");
const logoutButton = document.getElementById("logoutButton");
const termsConsent = document.getElementById("termsConsent");
const deliveryConsent = document.getElementById("deliveryConsent");
const checkoutButton = document.getElementById("checkoutButton");
const freeProductCode = document.getElementById("freeProductCode");
const redeemProductCode = document.getElementById("redeemProductCode");
const purchaseMessage = document.getElementById("purchaseMessage");
const purchaseSuccess = document.getElementById("purchaseSuccess");
const securedDownload = document.getElementById("securedDownload");
const productKicker = document.getElementById("productKicker");
const productLead = document.getElementById("productLead");
const productName = document.getElementById("productName");
const productDetails = document.getElementById("productDetails");
const downloadBenefit = document.getElementById("downloadBenefit");
const purchaseSuccessText = document.getElementById("purchaseSuccessText");
const windowsPlatformIcon = document.getElementById("windowsPlatformIcon");
const applePlatformIcon = document.getElementById("applePlatformIcon");
let authMode = "login";
let productPurchased = false;
let pendingSecuredDownload = null;
let productCodeRedemptionPending = false;

function applySelectedProduct() {
  productKicker.textContent = downloadProduct.kicker;
  productLead.textContent = downloadProduct.lead;
  productName.textContent = downloadProduct.name;
  productDetails.textContent = downloadProduct.details;
  downloadBenefit.textContent = downloadProduct.benefit;
  purchaseSuccessText.textContent = downloadProduct.success;
  securedDownload.textContent = downloadProduct.downloadLabel;
  windowsPlatformIcon.classList.toggle("hidden", downloadProduct.apple);
  applePlatformIcon.classList.toggle("hidden", !downloadProduct.apple);
  document.title = `${downloadProduct.name} kaufen | Meduvalo`;
}

function showMessage(message, type = "") {
  purchaseMessage.textContent = message;
  purchaseMessage.className = `purchase-message${type ? ` ${type}` : ""}`;
}

function clearMessage() {
  purchaseMessage.textContent = "";
  purchaseMessage.className = "purchase-message hidden";
}

function authErrorMessage(code) {
  const value = String(code || "");
  if (value.includes("EMAIL_EXISTS")) return "Für diese E-Mail-Adresse besteht bereits ein Konto.";
  if (value.includes("INVALID_LOGIN_CREDENTIALS")) return "E-Mail-Adresse oder Passwort ist nicht korrekt.";
  if (value.includes("WEAK_PASSWORD")) return "Das Passwort muss mindestens sechs Zeichen lang sein.";
  if (value.includes("TOO_MANY_ATTEMPTS")) return "Zu viele Versuche. Bitte warte kurz und versuche es erneut.";
  if (value.includes("INVALID_DYNAMIC_LINK_DOMAIN") || value.includes("INVALID_CONTINUE_URI") || value.includes("UNAUTHORIZED_DOMAIN")) return "Firebase kann meduvalo.at noch nicht als Bestätigungslink-Domain verwenden. Bitte kontaktiere support@meduvalo.at.";
  return "Die Anmeldung konnte nicht abgeschlossen werden.";
}

async function authRequest(action, payload) {
  const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${encodeURIComponent(PURCHASE_CONFIG.authApiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(authErrorMessage(data?.error?.message));
  return data;
}

function readSession() {
  try {
    return JSON.parse(sessionStorage.getItem(PURCHASE_CONFIG.sessionKey) || "null");
  } catch {
    return null;
  }
}

function saveSession(auth) {
  const session = {
    idToken: auth.idToken,
    refreshToken: auth.refreshToken,
    email: auth.email || "",
    expiresAt: Date.now() + (Number(auth.expiresIn) || 3600) * 1000
  };
  sessionStorage.setItem(PURCHASE_CONFIG.sessionKey, JSON.stringify(session));
  return session;
}

function clearSession() {
  sessionStorage.removeItem(PURCHASE_CONFIG.sessionKey);
}

async function currentSession() {
  const session = readSession();
  if (!session) return null;
  if (session.expiresAt > Date.now() + 60_000) return session;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.refreshToken
  });
  const response = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(PURCHASE_CONFIG.authApiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    clearSession();
    return null;
  }

  return saveSession({
    idToken: data.id_token,
    refreshToken: data.refresh_token || session.refreshToken,
    email: session.email,
    expiresIn: data.expires_in
  });
}

async function authorizedRequest(url, options = {}) {
  const session = await currentSession();
  if (!session) throw new Error("Bitte melde dich zuerst an.");
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.idToken}`,
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || "Die Anfrage konnte nicht abgeschlossen werden.");
  return data;
}

function updateCheckoutButton() {
  const consentMissing = !(termsConsent.checked && deliveryConsent.checked);
  checkoutButton.disabled = productPurchased || consentMissing;
  redeemProductCode.disabled = productCodeRedemptionPending || !freeProductCode.value.trim();
}

function setAuthenticated(session) {
  authPanel.classList.add("hidden");
  checkoutPanel.classList.remove("hidden");
  signedInEmail.textContent = session.email;
  updateCheckoutButton();
}

function setLoggedOut() {
  productPurchased = false;
  pendingSecuredDownload = null;
  productCodeRedemptionPending = false;
  authPanel.classList.remove("hidden");
  checkoutPanel.classList.add("hidden");
  purchaseSuccess.classList.add("hidden");
  securedDownload.removeAttribute("href");
  checkoutButton.textContent = `Für ${formatSitePrice(SITE_CONFIG.productPriceCents)} kaufen`;
  freeProductCode.value = "";
  redeemProductCode.textContent = "Gratis herunterladen";
}

function setMode(mode) {
  authMode = mode;
  const registering = mode === "register";
  loginTab.classList.toggle("active", !registering);
  registerTab.classList.toggle("active", registering);
  loginTab.setAttribute("aria-selected", String(!registering));
  registerTab.setAttribute("aria-selected", String(registering));
  authSubmit.textContent = registering ? "Konto erstellen" : "Anmelden";
  passwordInput.autocomplete = registering ? "new-password" : "current-password";
  resendVerification.classList.add("hidden");
  clearMessage();
}

async function register(email, password) {
  const created = await authRequest("signUp", {
    email,
    password,
    returnSecureToken: true
  });
  await authRequest("sendOobCode", {
    requestType: "VERIFY_EMAIL",
    idToken: created.idToken,
    continueUrl: `${SITE_CONFIG.websiteUrl}/purchase.html?emailVerified=1`
  });
  setMode("login");
  emailInput.value = email;
  passwordInput.value = "";
  resendVerification.classList.remove("hidden");
  showMessage("Konto erstellt. Bitte bestätige deine E-Mail-Adresse und melde dich danach an.", "success");
}

async function login(email, password) {
  const auth = await authRequest("signInWithPassword", {
    email,
    password,
    returnSecureToken: true
  });
  const lookup = await authRequest("lookup", { idToken: auth.idToken });
  const account = Array.isArray(lookup.users) ? lookup.users[0] : null;
  if (account?.emailVerified !== true) {
    resendVerification.classList.remove("hidden");
    throw new Error("Bitte bestätige zuerst deine E-Mail-Adresse.");
  }
  const session = saveSession(auth);
  clearMessage();
  setAuthenticated(session);
  if (new URLSearchParams(location.search).get("checkout")) await handleCheckoutReturn();
  else await refreshPurchaseAccess();
}

async function requestSecuredDownload() {
  const download = await authorizedRequest(PURCHASE_CONFIG.downloadEndpoint, {
    method: "POST",
    body: JSON.stringify({ platform: downloadPlatform })
  });
  pendingSecuredDownload = download;
  securedDownload.href = download.url;
  securedDownload.removeAttribute("download");
  purchaseSuccess.classList.remove("hidden");
  purchaseSuccess.scrollIntoView({ behavior: "smooth", block: "center" });
}

function downloadInstallationAuthorization(authorization) {
  if (!authorization?.token) return;
  const payload = JSON.stringify({
    schemaVersion: authorization.schemaVersion,
    token: authorization.token,
    platform: authorization.platform,
    version: authorization.version,
    expiresAt: authorization.expiresAt
  }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `Meduvalo-Installationsberechtigung-${authorization.version}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

securedDownload.addEventListener("click", (event) => {
  if (!pendingSecuredDownload?.url) return;
  event.preventDefault();
  downloadInstallationAuthorization(pendingSecuredDownload.installationAuthorization);
  showMessage(
    pendingSecuredDownload.installationAuthorization
      ? "Installationsberechtigung gespeichert. Der Installer wird jetzt heruntergeladen. Lass beide Dateien im Download-Ordner."
      : "Der Installer wird jetzt heruntergeladen.",
    "success"
  );
  setTimeout(() => {
    location.href = pendingSecuredDownload.url;
  }, pendingSecuredDownload.installationAuthorization ? 350 : 0);
});

async function refreshPurchaseAccess() {
  const status = await authorizedRequest(PURCHASE_CONFIG.statusEndpoint, { method: "GET" });
  const state = status?.state || {};
  if (!(state.baseProductPurchased || state.subscriptionActive || state.premiumActive)) return false;
  productPurchased = true;
  checkoutButton.textContent = "Bereits gekauft";
  redeemProductCode.textContent = "Mit Gratis-Code erneut herunterladen";
  updateCheckoutButton();
  await requestSecuredDownload();
  showMessage("Meduvalo ist für dieses Konto bereits freigeschaltet.", "success");
  return true;
}

async function waitForPurchaseActivation() {
  showMessage("Zahlung erfolgreich. Die Freischaltung wird geprüft...", "success");
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const status = await authorizedRequest(PURCHASE_CONFIG.statusEndpoint, { method: "GET" });
    if (status?.state?.baseProductPurchased || status?.state?.subscriptionActive || status?.state?.premiumActive) {
      productPurchased = true;
      checkoutButton.textContent = "Bereits gekauft";
      updateCheckoutButton();
      await requestSecuredDownload();
      showMessage("Dein Kauf ist aktiv. Die 7-tägige Testphase läuft ab jetzt.", "success");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  showMessage("Die Zahlung ist eingegangen. Die Freischaltung dauert noch einen Moment. Bitte lade die Seite gleich erneut.", "success");
}

async function handleCheckoutReturn() {
  const checkout = new URLSearchParams(location.search).get("checkout");
  if (checkout === "success") {
    await waitForPurchaseActivation();
  } else if (checkout === "cancelled") {
    showMessage("Der Kauf wurde abgebrochen. Es wurde nichts berechnet.");
  }
}

loginTab.addEventListener("click", () => setMode("login"));
registerTab.addEventListener("click", () => setMode("register"));
termsConsent.addEventListener("change", updateCheckoutButton);
deliveryConsent.addEventListener("change", updateCheckoutButton);
freeProductCode.addEventListener("input", updateCheckoutButton);

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  authSubmit.disabled = true;
  showMessage(authMode === "register" ? "Konto wird erstellt..." : "Anmeldung läuft...");
  try {
    if (authMode === "register") await register(email, password);
    else await login(email, password);
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    authSubmit.disabled = false;
  }
});

resendVerification.addEventListener("click", async () => {
  try {
    const auth = await authRequest("signInWithPassword", {
      email: emailInput.value.trim(),
      password: passwordInput.value,
      returnSecureToken: true
    });
    await authRequest("sendOobCode", {
      requestType: "VERIFY_EMAIL",
      idToken: auth.idToken,
      continueUrl: `${SITE_CONFIG.websiteUrl}/purchase.html?emailVerified=1`
    });
    showMessage("Bestätigungs-E-Mail wurde erneut gesendet.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  }
});

logoutButton.addEventListener("click", () => {
  clearSession();
  setLoggedOut();
  clearMessage();
});

checkoutButton.addEventListener("click", async () => {
  checkoutButton.disabled = true;
  showMessage("Sicherer Checkout wird vorbereitet...");
  try {
    const checkout = await authorizedRequest(PURCHASE_CONFIG.checkoutEndpoint, {
      method: "POST",
      body: JSON.stringify({ kind: "product", source: "landing", platform: downloadPlatform })
    });
    location.href = checkout.url;
  } catch (error) {
    showMessage(error.message, "error");
    updateCheckoutButton();
  }
});

redeemProductCode.addEventListener("click", async () => {
  productCodeRedemptionPending = true;
  updateCheckoutButton();
  showMessage("Gratis-Code wird geprüft...");
  try {
    const result = await authorizedRequest(PURCHASE_CONFIG.redeemCodeEndpoint, {
      method: "POST",
      body: JSON.stringify({ code: freeProductCode.value.trim() })
    });
    productPurchased = true;
    checkoutButton.textContent = "Bereits freigeschaltet";
    redeemProductCode.textContent = "Erneut herunterladen";
    await requestSecuredDownload();
    showMessage(result.message || "Meduvalo wurde kostenlos freigeschaltet.", "success");
  } catch (error) {
    showMessage(error.message, "error");
  } finally {
    productCodeRedemptionPending = false;
    updateCheckoutButton();
  }
});

applySelectedProduct();

(async () => {
  const session = await currentSession();
  if (session) {
    setAuthenticated(session);
    if (new URLSearchParams(location.search).get("checkout")) await handleCheckoutReturn();
    else await refreshPurchaseAccess();
  } else {
    setLoggedOut();
    if (new URLSearchParams(location.search).get("checkout") === "success") {
      showMessage("Zahlung abgeschlossen. Bitte melde dich erneut an, um den Download freizuschalten.", "success");
    } else if (new URLSearchParams(location.search).get("emailVerified") === "1") {
      showMessage("E-Mail-Adresse bestätigt. Du kannst dich jetzt anmelden.", "success");
    }
  }
})().catch((error) => showMessage(error.message, "error"));
