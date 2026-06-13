const APP_BRAND = Object.freeze({
  productName: 'Meduvalo',
  domain: 'meduvalo.at',
  websiteUrl: 'https://meduvalo.at',
  supportEmail: 'support@meduvalo.at',
  claim: 'Prüfungsnah lernen. Sicherer bestehen.',
  shortClaim: 'Medizinfragen smart trainieren.',
  logoPath: '/assets/meduvalo-logo.svg'
});

const AUTH_SESSION_KEY = 'meditest-firebase-session';
const AUTH_CONFIG_KEY = 'meditest-auth-config';
let authConfigPromise = null;
let firebaseWebSdkPromise = null;

function readAuthSession() {
  try { return JSON.parse(sessionStorage.getItem(AUTH_SESSION_KEY) || 'null'); }
  catch { return null; }
}

function writeAuthSession(session) {
  sessionStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
}

function clearAuthSession() {
  sessionStorage.removeItem(AUTH_SESSION_KEY);
  sessionStorage.removeItem(SETTINGS_CACHE_KEY);
  sessionStorage.removeItem('meditest-trial-feedback-checked');
}

function redirectToLogin() {
  if (location.pathname.endsWith('/pages/login.html')) return;
  const next = encodeURIComponent(location.pathname + location.search);
  location.href = `/pages/login.html?returnUrl=${next}`;
}

function isPublicApi(path) {
  const value = String(path);
  return value.startsWith('/api/auth/config') || value.startsWith('/api/system/shutdown') || value.startsWith('/api/system/update');
}

async function parseResponse(res) {
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return data;
}

async function getAuthConfig(force = false) {
  if (!force && authConfigPromise) return authConfigPromise;
  authConfigPromise = (async () => {
    if (!force) {
      try {
        const cached = JSON.parse(sessionStorage.getItem(AUTH_CONFIG_KEY) || 'null');
        if (cached?.firebase?.apiKey) return cached;
      } catch {}
    }

    const res = await fetch('/api/auth/config', { headers: { 'Accept': 'application/json' } });
    const data = await parseResponse(res);
    if (!res.ok) throw new Error(data?.error || data || `HTTP ${res.status}`);
    sessionStorage.setItem(AUTH_CONFIG_KEY, JSON.stringify(data));
    return data;
  })();
  return authConfigPromise;
}

function firebaseErrorMessage(code) {
  const raw = String(code || '').replace(/^Firebase:\s*/i, '');
  if (raw.includes('OPERATION_NOT_ALLOWED')) return 'Firebase Email/Passwort ist noch nicht aktiviert. Aktiviere in Firebase Authentication den Anbieter Email/Password.';
  if (raw.includes('EMAIL_EXISTS')) return 'Diese E-Mail ist bereits registriert.';
  if (raw.includes('MISSING_EMAIL')) return 'Bitte gib deine E-Mail-Adresse ein.';
  if (raw.includes('INVALID_EMAIL')) return 'Diese E-Mail-Adresse ist ungültig.';
  if (raw.includes('INVALID_LOGIN_CREDENTIALS') || raw.includes('EMAIL_NOT_FOUND') || raw.includes('INVALID_PASSWORD')) return 'E-Mail oder Passwort ist falsch.';
  if (raw.includes('WEAK_PASSWORD')) return 'Das Passwort muss mindestens 6 Zeichen lang sein.';
  if (raw.includes('TOO_MANY_ATTEMPTS_TRY_LATER')) return 'Zu viele Versuche. Bitte später erneut versuchen.';
  if (raw.includes('USER_NOT_FOUND')) return 'Zu dieser E-Mail-Adresse wurde kein Konto gefunden.';
  if (raw.includes('INVALID_DYNAMIC_LINK_DOMAIN') || raw.includes('INVALID_CONTINUE_URI') || raw.includes('UNAUTHORIZED_DOMAIN')) return 'Firebase kann meduvalo.at noch nicht als Bestätigungslink-Domain verwenden. Bitte kontaktiere support@meduvalo.at.';
  return raw || 'Firebase-Anmeldung fehlgeschlagen.';
}

function firebaseProviderErrorMessage(error, providerLabel) {
  const code = String(error?.code || error?.message || '');
  if (code.includes('popup-closed-by-user') || code.includes('cancelled-popup-request')) return `${providerLabel}-Anmeldung wurde abgebrochen.`;
  if (code.includes('popup-blocked')) return `Das Anmeldefenster für ${providerLabel} wurde vom Browser blockiert. Erlaube Popups für ${APP_BRAND.productName}.`;
  if (code.includes('unauthorized-domain')) return `Diese lokale ${APP_BRAND.productName}-Adresse ist in Firebase noch nicht als autorisierte Domain eingetragen.`;
  if (code.includes('operation-not-allowed')) return `${providerLabel}-Anmeldung ist in Firebase noch nicht vollständig aktiviert.`;
  if (code.includes('account-exists-with-different-credential')) return 'Für diese E-Mail-Adresse besteht bereits ein Konto mit einer anderen Anmeldemethode.';
  if (code.includes('network-request-failed')) return `Die Verbindung zur ${providerLabel}-Anmeldung ist fehlgeschlagen.`;
  if (code.includes('user-disabled')) return 'Dieses Benutzerkonto wurde deaktiviert.';
  return error?.message || `${providerLabel}-Anmeldung fehlgeschlagen.`;
}

async function getFirebaseWebSdk() {
  if (firebaseWebSdkPromise) return firebaseWebSdkPromise;
  firebaseWebSdkPromise = (async () => {
    const [appSdk, authSdk, cfg] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js'),
      getAuthConfig()
    ]);
    const firebase = cfg?.firebase;
    if (!firebase?.apiKey || !firebase?.projectId) throw new Error('Firebase ist noch nicht konfiguriert.');
    const appConfig = {
      apiKey: firebase.apiKey,
      authDomain: firebase.authDomain,
      projectId: firebase.projectId,
      storageBucket: firebase.storageBucket,
      messagingSenderId: firebase.messagingSenderId,
      appId: firebase.appId,
      measurementId: firebase.measurementId
    };
    const app = appSdk.getApps().length ? appSdk.getApp() : appSdk.initializeApp(appConfig);
    const auth = authSdk.getAuth(app);
    auth.languageCode = 'de';
    await authSdk.setPersistence(auth, authSdk.inMemoryPersistence);
    return { ...authSdk, auth };
  })().catch(error => {
    firebaseWebSdkPromise = null;
    throw error;
  });
  return firebaseWebSdkPromise;
}

async function firebaseAuthRequest(action, payload) {
  const cfg = await getAuthConfig();
  const apiKey = cfg?.firebase?.apiKey;
  if (!apiKey) throw new Error('Firebase ist noch nicht konfiguriert.');

  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(firebaseErrorMessage(data?.error?.message || data));
  return data;
}

async function refreshFirebaseSession(session) {
  const cfg = await getAuthConfig();
  const apiKey = cfg?.firebase?.apiKey;
  if (!apiKey || !session?.refreshToken) throw new Error('Keine gültige Firebase-Sitzung.');

  const body = new URLSearchParams();
  body.set('grant_type', 'refresh_token');
  body.set('refresh_token', session.refreshToken);

  const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await parseResponse(res);
  if (!res.ok) throw new Error(firebaseErrorMessage(data?.error?.message || data));

  const expiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
  const next = {
    ...session,
    idToken: data.id_token,
    refreshToken: data.refresh_token || session.refreshToken,
    expiresAt,
    user: {
      ...session.user,
      userId: data.user_id || session.user?.userId || '',
      expiresAt: new Date(expiresAt).toISOString()
    }
  };
  writeAuthSession(next);
  return next;
}

function saveFirebaseSession(auth, displayName = '') {
  const expiresAt = Date.now() + (Number(auth.expiresIn) || 3600) * 1000;
  const email = auth.email || '';
  const name = (displayName || auth.displayName || email.split('@')[0] || `${APP_BRAND.productName} Nutzer`).trim();
  const user = {
    userId: auth.localId || auth.user_id || '',
    email,
    displayName: name,
    plan: 'Kostenlos',
    licenseStatus: 'Aktiv',
    authMode: 'firebase',
    emailVerified: auth.emailVerified === true,
    providerId: auth.providerId || 'password',
    expiresAt: new Date(expiresAt).toISOString()
  };
  writeAuthSession({
    idToken: auth.idToken,
    refreshToken: auth.refreshToken,
    expiresAt,
    user
  });
  return { user };
}

async function registerWithFirebase(payload) {
  const created = await firebaseAuthRequest('signUp', {
    email: payload.email,
    password: payload.password,
    returnSecureToken: true
  });
  let auth = { ...created, providerId: 'password' };
  if (payload.displayName) {
    const updated = await firebaseAuthRequest('update', {
      idToken: created.idToken,
      displayName: payload.displayName,
      returnSecureToken: true
    });
    auth = { ...created, ...updated, localId: updated.localId || created.localId, email: updated.email || created.email };
  }
  await firebaseAuthRequest('sendOobCode', {
    requestType: 'VERIFY_EMAIL',
    idToken: auth.idToken,
    continueUrl: `${APP_BRAND.websiteUrl}/purchase.html?emailVerified=1`
  });
  clearAuthSession();
  return {
    verificationRequired: true,
    email: auth.email || payload.email,
    message: 'Konto erstellt. Bitte bestätige deine E-Mail-Adresse über den Link in der zugesandten E-Mail.'
  };
}

async function loginWithFirebase(payload) {
  const auth = await firebaseAuthRequest('signInWithPassword', {
    email: payload.email,
    password: payload.password,
    returnSecureToken: true
  });
  const lookup = await firebaseAuthRequest('lookup', { idToken: auth.idToken });
  const account = Array.isArray(lookup.users) ? lookup.users[0] : null;
  if (account?.emailVerified !== true) {
    const error = new Error('Bitte bestätige zuerst deine E-Mail-Adresse. Danach kannst du dich anmelden.');
    error.emailVerificationRequired = true;
    error.email = auth.email || payload.email;
    throw error;
  }
  auth.emailVerified = true;
  auth.providerId = 'password';
  saveFirebaseSession(auth, auth.displayName);
  try { return await api('/api/auth/me'); }
  catch (err) { clearAuthSession(); throw err; }
}

async function loginWithFirebaseProvider(providerId) {
  const sdk = await getFirebaseWebSdk();
  const providerLabel = providerId === 'apple.com' ? 'Apple' : 'Google';
  let provider;
  if (providerId === 'apple.com') {
    provider = new sdk.OAuthProvider('apple.com');
    provider.addScope('email');
    provider.addScope('name');
    provider.setCustomParameters({ locale: 'de' });
  } else {
    provider = new sdk.GoogleAuthProvider();
    provider.addScope('email');
    provider.addScope('profile');
    provider.setCustomParameters({ prompt: 'select_account' });
  }

  try {
    const result = await sdk.signInWithPopup(sdk.auth, provider);
    const user = result.user;
    const [idToken, tokenResult] = await Promise.all([
      user.getIdToken(true),
      user.getIdTokenResult()
    ]);
    const expiresIn = Math.max(60, Math.floor((new Date(tokenResult.expirationTime).getTime() - Date.now()) / 1000));
    saveFirebaseSession({
      idToken,
      refreshToken: user.refreshToken,
      expiresIn,
      localId: user.uid,
      email: user.email || '',
      displayName: user.displayName || '',
      emailVerified: user.emailVerified,
      providerId
    }, user.displayName || '');
    try { return await api('/api/auth/me'); }
    catch (error) { clearAuthSession(); throw error; }
  } catch (error) {
    clearAuthSession();
    throw new Error(firebaseProviderErrorMessage(error, providerLabel));
  }
}

async function prepareFirebaseProviderAccountDeletion() {
  const session = readAuthSession();
  if (session?.user?.providerId !== 'apple.com') return;

  const sdk = await getFirebaseWebSdk();
  const provider = new sdk.OAuthProvider('apple.com');
  provider.addScope('email');
  provider.addScope('name');
  provider.setCustomParameters({ locale: 'de' });
  try {
    const result = await sdk.signInWithPopup(sdk.auth, provider);
    if (result.user.uid !== session.user.userId) {
      throw new Error(`Das bestätigte Apple-Konto stimmt nicht mit dem angemeldeten ${APP_BRAND.productName}-Konto überein.`);
    }
    const credential = sdk.OAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Das Apple-Zugriffstoken konnte nicht widerrufen werden.');
    }
    await sdk.revokeAccessToken(sdk.auth, credential.accessToken);
  } catch (error) {
    throw new Error(firebaseProviderErrorMessage(error, 'Apple'));
  }
}

async function resendFirebaseEmailVerification(payload) {
  const email = String(payload?.email || '').trim();
  const password = String(payload?.password || '');
  if (!email || !password) throw new Error('Gib E-Mail-Adresse und Passwort ein, um die Bestätigungs-E-Mail erneut zu senden.');
  const auth = await firebaseAuthRequest('signInWithPassword', {
    email,
    password,
    returnSecureToken: true
  });
  const lookup = await firebaseAuthRequest('lookup', { idToken: auth.idToken });
  const account = Array.isArray(lookup.users) ? lookup.users[0] : null;
  if (account?.emailVerified === true) return { verified: true, message: 'Die E-Mail-Adresse ist bereits bestätigt. Du kannst dich jetzt anmelden.' };
  await firebaseAuthRequest('sendOobCode', {
    requestType: 'VERIFY_EMAIL',
    idToken: auth.idToken,
    continueUrl: `${APP_BRAND.websiteUrl}/purchase.html?emailVerified=1`
  });
  return { verified: false, message: 'Bestätigungs-E-Mail wurde erneut gesendet.' };
}

async function sendFirebasePasswordReset(email) {
  email = String(email || '').trim();
  if (!email) throw new Error('Bitte gib deine E-Mail-Adresse ein.');
  try {
    await firebaseAuthRequest('sendOobCode', {
      requestType: 'PASSWORD_RESET',
      email
    });
  } catch (err) {
    const message = String(err?.message || '');
    if (!message.includes('Konto gefunden') && !message.includes('E-Mail oder Passwort')) throw err;
  }
  return { message: 'Wenn ein Konto existiert, wurde eine E-Mail zum Zurücksetzen gesendet.' };
}

async function changeFirebasePassword(payload) {
  const session = readAuthSession();
  const email = session?.user?.email || '';
  if (!email) throw new Error('Keine angemeldete E-Mail-Adresse gefunden.');
  if (!payload?.currentPassword) throw new Error('Bitte gib dein aktuelles Passwort ein.');
  if (!payload?.newPassword || payload.newPassword.length < 6) throw new Error('Das neue Passwort muss mindestens 6 Zeichen lang sein.');
  if (payload.newPassword !== payload.confirmPassword) throw new Error('Die neuen Passwörter stimmen nicht überein.');

  const auth = await firebaseAuthRequest('signInWithPassword', {
    email,
    password: payload.currentPassword,
    returnSecureToken: true
  });
  const updated = await firebaseAuthRequest('update', {
    idToken: auth.idToken,
    password: payload.newPassword,
    returnSecureToken: true
  });
  saveFirebaseSession({ ...auth, ...updated, email: updated.email || email, localId: updated.localId || auth.localId, providerId: 'password' }, session.user?.displayName || '');
  try { await api('/api/auth/me'); } catch {}
  return { message: 'Passwort wurde geändert.' };
}

async function ensureAuthToken(redirect = true) {
  let session = readAuthSession();
  if (!session?.idToken) {
    if (redirect) redirectToLogin();
    return null;
  }

  if (Number(session.expiresAt) > Date.now() + 60000) return session.idToken;

  try {
    session = await refreshFirebaseSession(session);
    return session.idToken;
  } catch {
    clearAuthSession();
    if (redirect) redirectToLogin();
    return null;
  }
}

async function currentAuthUser(redirect = false) {
  const token = await ensureAuthToken(redirect);
  if (!token) return null;
  return readAuthSession()?.user || null;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (!isPublicApi(path)) {
    const token = await ensureAuthToken(true);
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(path, { ...options, headers });
  const data = await parseResponse(res);
  if (!res.ok) {
    if (res.status === 403 && data?.emailVerificationRequired) {
      clearAuthSession();
      if (!location.pathname.endsWith('/pages/login.html')) {
        location.href = '/pages/login.html?verificationRequired=1';
      }
    }
    if (res.status === 401 && !location.pathname.endsWith('/pages/login.html')) {
      clearAuthSession();
      redirectToLogin();
    }
    const msg = data?.error || data || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function downloadApiFile(path, fallbackName = `${APP_BRAND.productName}.pdf`) {
  const headers = new Headers();
  const token = await ensureAuthToken(true);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(path, { headers });
  if (!res.ok) {
    const data = await parseResponse(res);
    if (res.status === 401) {
      clearAuthSession();
      redirectToLogin();
    }
    throw new Error(data?.error || data || `HTTP ${res.status}`);
  }

  const blob = await res.blob();
  const disposition = res.headers.get('Content-Disposition') || '';
  const match = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disposition);
  const fileName = match ? decodeURIComponent(match[1].replace(/"/g, '')) : fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

window.getAuthConfig = getAuthConfig;
window.registerWithFirebase = registerWithFirebase;
window.loginWithFirebase = loginWithFirebase;
window.loginWithFirebaseProvider = loginWithFirebaseProvider;
window.prepareFirebaseProviderAccountDeletion = prepareFirebaseProviderAccountDeletion;
window.resendFirebaseEmailVerification = resendFirebaseEmailVerification;
window.sendFirebasePasswordReset = sendFirebasePasswordReset;
window.changeFirebasePassword = changeFirebasePassword;
window.currentAuthUser = currentAuthUser;
window.downloadApiFile = downloadApiFile;

async function readImageFileAsDataUrl(input, maxBytes = 600 * 1024) {
  const file = input?.files?.[0];
  if (!file) return null;
  if (!/^image\/(png|jpe?g|webp|gif)$/i.test(file.type)) {
    throw new Error('Bitte ein Bild als PNG, JPEG, WebP oder GIF auswählen.');
  }
  if (file.size > maxBytes) {
    throw new Error('Das Bild ist zu groß. Maximum: 600 KB.');
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Das Bild konnte nicht gelesen werden.'));
    reader.readAsDataURL(file);
  });
  return { imageDataUrl: dataUrl, imageFileName: file.name };
}

function priceLabel(cents, currency = 'EUR') {
  return new Intl.NumberFormat('de-AT', { style: 'currency', currency: currency || 'EUR' }).format((Number(cents) || 0) / 100);
}

window.readImageFileAsDataUrl = readImageFileAsDataUrl;
window.priceLabel = priceLabel;

function qs(name){ return new URLSearchParams(location.search).get(name); }
function status(el, msg, type='status'){ el.className = type; el.textContent = msg; el.classList.remove('hidden'); }

function openActionPopup(message, title = 'Aktion wird ausgeführt') {
  document.getElementById('actionProgressModal')?.remove();
  const modal = document.createElement('div');
  modal.id = 'actionProgressModal';
  modal.className = 'modal-backdrop action-progress-backdrop';
  modal.innerHTML = `
    <section class="modal-panel action-progress-modal" role="status" aria-live="polite" aria-labelledby="actionProgressTitle">
      <span class="action-progress-spinner" aria-hidden="true"></span>
      <div>
        <p class="eyebrow">Bitte warten</p>
        <h2 id="actionProgressTitle">${esc(title)}</h2>
        <p id="actionProgressMessage" class="muted">${esc(message)}</p>
        <div id="actionProgressActions" class="actions hidden">
          <button type="button" onclick="closeActionPopup()">Schließen</button>
        </div>
      </div>
    </section>`;
  document.body.appendChild(modal);

  return {
    update(nextMessage, nextTitle = '') {
      const messageElement = document.getElementById('actionProgressMessage');
      const titleElement = document.getElementById('actionProgressTitle');
      if (messageElement) messageElement.textContent = nextMessage;
      if (nextTitle && titleElement) titleElement.textContent = nextTitle;
    },
    success(nextMessage = 'Fertig.') {
      modal.classList.add('action-progress-success');
      modal.querySelector('.action-progress-spinner')?.classList.add('action-progress-check');
      const messageElement = document.getElementById('actionProgressMessage');
      if (messageElement) messageElement.textContent = nextMessage;
      setTimeout(() => closeActionPopup(), 650);
    },
    fail(errorMessage) {
      modal.classList.add('action-progress-error');
      modal.querySelector('.action-progress-spinner')?.classList.add('action-progress-failed');
      const titleElement = document.getElementById('actionProgressTitle');
      const messageElement = document.getElementById('actionProgressMessage');
      const actions = document.getElementById('actionProgressActions');
      if (titleElement) titleElement.textContent = 'Aktion fehlgeschlagen';
      if (messageElement) messageElement.textContent = errorMessage;
      actions?.classList.remove('hidden');
    }
  };
}

function closeActionPopup() {
  document.getElementById('actionProgressModal')?.remove();
}
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

const HELP_BY_HEADING = new Map([
  ['Multiple-Choice-Tests aus Skripten, PDFs und Folien.', `${APP_BRAND.productName} erstellt aus deinen Unterlagen Fragenpools. Daraus kannst du Tests starten, Ergebnisse auswerten und schwierige Themen gezielt wiederholen.`],
  ['Dokumente & Fragenpools', 'Hier verwaltest du alle Lernunterlagen und Fragenpools. Du kannst Dateien hochladen, Fragen importieren oder generieren und anschließend einen Test starten.'],
  ['Unterlage hochladen', `Wähle eine PDF-, PPTX- oder TXT-Datei. ${APP_BRAND.productName} extrahiert den Text und legt daraus einen neuen Fragenpool an.`],
  ['Fragen aus TXT importieren', 'Importiere bereits vorbereitete Multiple-Choice-Fragen aus einer TXT-Datei. Der optionale Name wird als Name des Fragenpools verwendet.'],
  ['Gespeicherte Dokumente', 'Jede Karte ist ein Fragenpool. Lege die Anzahl der Fragen fest, generiere neue Fragen, bearbeite den Pool oder starte direkt einen Test.'],
  ['Frage manuell erstellen', 'Erstelle eine eigene Frage mit fünf Antwortmöglichkeiten. Wähle die richtige Antwort und ergänze bei Bedarf Thema, Erklärung und Bild.'],
  ['Gespeicherte Tests', 'Hier findest du offene und abgeschlossene Tests. Offene Tests lassen sich fortsetzen, abgeschlossene Tests können erneut ausgewertet werden.'],
  ['Gesamtstatistik', 'Die Statistik fasst deine abgeschlossenen Tests zusammen. Über die Auswahl kannst du alle Ergebnisse oder nur einen bestimmten Test anzeigen.'],
  ['Testverlauf', 'Der Verlauf zeigt die Ergebnisse deiner letzten Tests. Ein Klick auf einen Balken öffnet die jeweilige Auswertung.'],
  ['Visuelle Auswertung', 'Die Diagramme zeigen Bestehensquote, Antwortgenauigkeit, Prüfungsstand und Leistung nach Schwierigkeitsgrad.'],
  ['Lernempfehlung', `${APP_BRAND.productName} erkennt Themen mit erhöhter Fehlerquote und schlägt passende Fragen für die Wiederholung vor.`],
  ['Themenanalyse', 'Hier werden Antworten nach Themen gruppiert. Eine hohe Fehlerquote weist auf Themen hin, die du gezielt wiederholen solltest.'],
  ['Schwache Fragen', 'Hier erscheinen Fragen, die wiederholt falsch beantwortet wurden. Öffne sie, um Inhalt und Erklärung noch einmal zu prüfen.'],
  ['Einstellungen', 'Passe Profildaten und Darstellung an, prüfe auf Updates oder ändere dein Passwort.'],
  ['Profil', 'Diese Angaben werden für dein Profil gespeichert und unter anderem im exportierten Testprotokoll verwendet.'],
  ['Programm', 'Wähle eine helle, dunkle oder automatisch an dein Betriebssystem angepasste Darstellung.'],
  ['Updates', `Prüfe, ob eine neuere ${APP_BRAND.productName}-Version verfügbar ist, und öffne bei Bedarf den passenden Download.`],
  ['Sicherheit', 'Ändere das Passwort deines angemeldeten Kontos. Dafür wird zuerst dein aktuelles Passwort geprüft.'],
  ['Firestore-Katalog', `Im Katalog findest du veröffentlichte, themenspezifische Tests, die du in dein ${APP_BRAND.productName}-Konto herunterladen kannst.`],
  ['Verfügbare Tests', 'Wähle einen Katalogtest aus. Je nach Freischaltung kannst du ihn direkt herunterladen, gratis aktivieren oder kaufen.'],
  ['Admin', 'Administratoren können einen vorhandenen Fragenpool mit Titel, Beschreibung, Thema und Schwierigkeit im Katalog veröffentlichen.'],
  ['Lizenz und Premium', 'Hier siehst du Basiskauf, 7-tägige Testphase, Monatsabo und den eingeschränkten Modus. Katalogtests werden separat gekauft.'],
  ['Katalogtests', 'Katalogtests können einzeln freigeschaltet und anschließend in die eigenen Fragenpools heruntergeladen werden.'],
  ['Katalog-Code', 'Ein gültiger Gratis-Code schaltet genau einen noch gesperrten Katalogtest deiner Wahl frei.'],
  ['Code einlösen', `Ein administrativer Premium-Code schaltet ${APP_BRAND.productName}-Vollfunktionen frei. Katalogtests bleiben separate Kaufartikel.`],
  ['Auswertung', 'Die Auswertung zeigt Ergebnis, Bestehensstatus und alle Antworten. Falsche Antworten werden mit der richtigen Lösung und Erklärung ergänzt.'],
  ['Fehlerschwerpunkte', 'Diese Übersicht gruppiert deine Fehler nach Thema, damit du erkennst, welche Inhalte du zuerst wiederholen solltest.']
]);

const HELP_BY_HEADING_PREFIX = [
  ['Fragen:', 'Hier siehst du alle Fragen dieses Fragenpools. Richtige Antworten sind markiert und jede Frage kann direkt bearbeitet werden.'],
  ['Thema:', 'Hier siehst du alle gespeicherten Fragen zu diesem Thema, auch wenn sie aus unterschiedlichen Fragenpools stammen.'],
  ['Themenanalyse', HELP_BY_HEADING.get('Themenanalyse')]
];

let helpPopoverId = 0;

function plainHeadingText(heading) {
  const clone = heading.cloneNode(true);
  clone.querySelectorAll('.help-tip').forEach(el => el.remove());
  return (clone.textContent || '').replace(/\s+/g, ' ').trim();
}

function helpTextForHeading(heading) {
  const text = plainHeadingText(heading);
  return HELP_BY_HEADING.get(text)
    || HELP_BY_HEADING_PREFIX.find(([prefix]) => text.startsWith(prefix))?.[1]
    || '';
}

function positionHelpPopover(wrapper) {
  const icon = wrapper.querySelector('.help-icon');
  const popover = wrapper.querySelector('.help-popover');
  if (!icon || !popover) return;

  const iconRect = icon.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const gap = 9;
  const edge = 12;
  const left = Math.min(
    window.innerWidth - popoverRect.width - edge,
    Math.max(edge, iconRect.left + iconRect.width / 2 - popoverRect.width / 2)
  );
  const below = iconRect.bottom + gap;
  const top = below + popoverRect.height <= window.innerHeight - edge
    ? below
    : Math.max(edge, iconRect.top - popoverRect.height - gap);

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}

function addHelpIcon(heading, text) {
  if (!heading || !text || heading.querySelector(':scope > .help-tip')) return;

  const wrapper = document.createElement('span');
  wrapper.className = 'help-tip';

  const icon = document.createElement('button');
  const popover = document.createElement('span');
  const id = `help-popover-${++helpPopoverId}`;
  icon.className = 'help-icon';
  icon.type = 'button';
  icon.textContent = 'i';
  icon.setAttribute('aria-label', `Hilfe zu ${plainHeadingText(heading)}`);
  icon.setAttribute('aria-describedby', id);
  popover.id = id;
  popover.className = 'help-popover';
  popover.setAttribute('role', 'tooltip');
  popover.textContent = text;

  wrapper.append(icon, popover);
  wrapper.addEventListener('mouseenter', () => positionHelpPopover(wrapper));
  wrapper.addEventListener('focusin', () => positionHelpPopover(wrapper));
  icon.addEventListener('keydown', event => {
    if (event.key === 'Escape') icon.blur();
  });
  heading.appendChild(wrapper);
}

function enhanceHelp(root = document) {
  const headings = [];
  if (root.matches?.('h1,h2')) headings.push(root);
  root.querySelectorAll?.('h1,h2').forEach(heading => headings.push(heading));
  headings.forEach(heading => addHelpIcon(heading, helpTextForHeading(heading)));
}

const TOOLTIP_BY_TEXT = new Map([
  ['Dokumente', 'Unterlagen hochladen, Fragenpools verwalten und Tests starten.'],
  ['Katalog', 'Themenspezifische Firestore-Tests herunterladen.'],
  ['Manuell', 'Eigene Multiple-Choice-Fragen ohne Datei anlegen.'],
  ['Tests', 'Gestartete und abgeschlossene Tests ansehen.'],
  ['Statistik', 'Ergebnisse und Fehlerschwerpunkte auswerten.'],
  ['Support', 'Kontaktformular für Fragen und Supportanfragen öffnen.'],
  ['Rechtliches & Lizenz', 'Produktdaten, Rechtstexte, Geräte und Lizenzstatus ansehen.'],
  ['Einstellungen', 'Profil und Darstellung konfigurieren.'],
  ['Einloggen', `Mit deinem ${APP_BRAND.productName}-Konto anmelden.`],
  ['Konto erstellen', `Neuen ${APP_BRAND.productName}-Zugang anlegen.`],
  ['Registrieren', 'Neues Konto erstellen und direkt anmelden.'],
  ['Passwort vergessen?', 'E-Mail zum Zurücksetzen des Passworts senden.'],
  ['Passwort ändern', 'Aktuelles Passwort prüfen und ein neues Passwort setzen.'],
  ['Abmelden', 'Aktuelle Sitzung beenden.'],
  ['Schließen', `${APP_BRAND.productName} lokal beenden.`],
  ['Dokumente verwalten', 'Zur kombinierten Dokumenten- und Hochladen-Seite wechseln.'],
  ['Tests anzeigen', 'Gespeicherte Tests öffnen.'],
  ['Dokumente anzeigen', 'Zur Dokumentenübersicht wechseln.'],
  ['Fragenpool mit neuen Fragen öffnen', 'Den gesamten Fragenpool öffnen; neue Fragen stehen oben.'],
  ['Herunterladen', 'Firestore-Test in deine Firestore-Dokumente importieren.'],
  ['Veröffentlichen', 'Lokalen Fragenpool als Admin im Firestore-Katalog bereitstellen.'],
  ['Programm schließen', `${APP_BRAND.productName} lokal beenden.`],
  ['Hochladen & Text extrahieren', 'Datei speichern und Text für spätere Fragenpools extrahieren.'],
  ['Zur Übersicht', 'Zur Dokumentenübersicht zurückkehren.'],
  ['Importieren', 'Fragen aus der ausgewählten TXT-Datei importieren.'],
  ['Generieren', 'Neue Fragen erzeugen.'],
  ['Dokument ansehen', 'Gespeicherten Inhalt des hochgeladenen Dokuments anzeigen.'],
  ['Fragen ansehen', 'Fragenliste öffnen und Fragen bearbeiten.'],
  ['Test starten', 'Aus diesem Fragenpool einen neuen Test starten.'],
  ['Export .txt', 'Fragenpool als TXT-Datei exportieren.'],
  ['Löschen', 'Dokument inklusive Fragen und zugehöriger Tests löschen.'],
  ['Frage speichern', 'Manuell erstellte Frage im gewählten Fragenpool speichern.'],
  ['Bearbeiten', 'Fragetext, Antworten und Erklärung bearbeiten.'],
  ['Speichern', 'Änderungen dauerhaft speichern.'],
  ['Abbrechen', 'Bearbeitung verwerfen und zur Ansicht zurückkehren.'],
  ['Zurück', 'Zur vorherigen Testfrage wechseln.'],
  ['Weiter', 'Zur nächsten Testfrage wechseln.'],
  ['Test abgeben', 'Test auswerten und zur Auswertung wechseln.'],
  ['Test fortsetzen', 'Offenen Test mit dem gespeicherten Zwischenstand weiterbearbeiten.'],
  ['Umbenennen', 'Testnamen ändern.'],
  ['Auswertung öffnen', 'Auswertung dieses Tests öffnen.'],
  ['PDF herunterladen', 'Testprotokoll mit Profilangaben als PDF herunterladen.'],
  ['Kaufen', 'Kauf oder Checkout für diesen Katalogtest vorbereiten.'],
  ['Konto endgültig löschen', 'Konto und sämtliche zugehörigen Nutzerdaten dauerhaft entfernen.'],
  ['Bestätigungs-E-Mail erneut senden', 'Neue E-Mail mit einem Link zur Bestätigung der Konto-Adresse senden.'],
  ['An Support senden', 'Supportanfrage sicher übermitteln.'],
  ['Abo starten', 'Vollzugang zum angezeigten Monatspreis nach der Testphase abschließen.'],
  ['Code einlösen', 'Premium-Code prüfen und dieses Konto freischalten.'],
  ['Aktualisieren', 'Statistik mit der aktuellen Auswahl neu laden.'],
  ['Zum Thema springen', 'Ausgewähltes Thema öffnen und alle enthaltenen Fragen anzeigen.'],
  ['Fragen öffnen', 'Die empfohlenen Fragen zur Wiederholung öffnen.'],
  ['Frage öffnen', 'Diese Frage in der Themenansicht öffnen.'],
  ['Tests & Statistik zurücksetzen', 'Alle Tests und Statistikdaten löschen; Fragenpools bleiben erhalten.'],
  ['Neuen Test starten', 'Zur Dokumentenübersicht wechseln und einen weiteren Test starten.'],
  ['Verwerfen', 'Gespeicherte Einstellungen neu laden.'],
  ['← Zurück zur Dokumentenübersicht', 'Zurück zur Liste der Dokumente und Fragenpools.']
]);

const TOOLTIP_BY_SELECTOR = [
  ['.brand', 'Zur Dokumentenübersicht wechseln.'],
  ['#file', 'PDF, PPTX oder TXT auswählen.'],
  ['#importFile', 'TXT-Datei mit Fragen im Importformat auswählen.'],
  ['#importName', 'Optionaler Name für den importierten Fragenpool.'],
  ['#theme', 'Darstellung automatisch, hell oder dunkel wählen.'],
  ['#testSelect', 'Statistik auf einen bestimmten Test einschränken.'],
  ['#topicSelect', 'Thema auswählen, um direkt zur Fragenliste zu springen.'],
  ['select[id^="count-"]', 'Anzahl der neu zu generierenden KI-Fragen wählen.'],
  ['input[id^="testcount-"]', 'Anzahl der Fragen für den nächsten Test festlegen.'],
  ['input[id^="testname-"]', 'Optionalen Namen für den neuen Test vergeben.']
];

function tooltipText(el) {
  return (el.textContent || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
}

function applyTooltip(el, text) {
  if (!el || !text || el.title) return;
  el.title = text;
  el.dataset.tooltip = text;
  if ((el.tagName === 'BUTTON' || el.classList.contains('button')) && !el.getAttribute('aria-label')) {
    el.setAttribute('aria-label', tooltipText(el) || text);
  }
}

function enhanceTooltips(root = document) {
  enhanceHelp(root);

  TOOLTIP_BY_SELECTOR.forEach(([selector, text]) => {
    root.querySelectorAll?.(selector).forEach(el => applyTooltip(el, text));
  });

  root.querySelectorAll?.('a[href],button,input,select,textarea,label.checkline').forEach(el => {
    const text = TOOLTIP_BY_TEXT.get(tooltipText(el));
    if (text) applyTooltip(el, text);
  });
}

window.enhanceTooltips = enhanceTooltips;
window.enhanceHelp = enhanceHelp;

const SETTINGS_CACHE_KEY = 'meditest-settings';
const TRIAL_FEEDBACK_SESSION_KEY = 'meditest-trial-feedback-checked';
let appSettingsPromise = null;

function applyTheme(theme = 'system') {
  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
  const resolved = theme === 'dark' || (theme === 'system' && prefersDark) ? 'dark' : 'light';
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themeMode = theme;
}

function cachedSettings() {
  try { return JSON.parse(sessionStorage.getItem(SETTINGS_CACHE_KEY) || 'null'); }
  catch { return null; }
}

async function getAppSettings(force = false) {
  if (!force && appSettingsPromise) return appSettingsPromise;
  appSettingsPromise = api('/api/settings')
    .then(settings => {
      sessionStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings));
      applyTheme(settings.theme);
      window.mediTestSettings = settings;
      return settings;
    })
    .catch(err => {
      const cached = cachedSettings();
      if (cached) {
        applyTheme(cached.theme);
        window.mediTestSettings = cached;
        return cached;
      }
      throw err;
    });
  return appSettingsPromise;
}

function cacheAppSettings(settings) {
  sessionStorage.setItem(SETTINGS_CACHE_KEY, JSON.stringify(settings));
  applyTheme(settings.theme);
  window.mediTestSettings = settings;
  appSettingsPromise = Promise.resolve(settings);
  return settings;
}

const initialSettings = cachedSettings();
if (initialSettings?.theme) applyTheme(initialSettings.theme);

function accountMetaLabel(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.toLowerCase() === 'free') return 'Kostenlos';
  if (text.toLowerCase() === 'active') return 'Aktiv';
  return text;
}

function updateSizeLabel(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return '';
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${value} B`;
}

function dismissUpdateModal() {
  document.getElementById('updateModal')?.remove();
  const redirect = window.mediTestPostUpdateRedirect;
  if (redirect) {
    window.mediTestPostUpdateRedirect = '';
    location.href = redirect;
  }
}

function renderUpdateModal(info) {
  if (!info?.updateAvailable || document.getElementById('updateModal')) return;
  const download = info.recommendedDownload;
  const downloadUrl = download?.url || info.releaseUrl || '';
  if (!downloadUrl) return;

  const size = updateSizeLabel(download?.sizeBytes);
  const modal = document.createElement('div');
  modal.id = 'updateModal';
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="updateTitle">
      <p class="eyebrow">Update verfügbar</p>
      <h2 id="updateTitle">${APP_BRAND.productName} ${esc(info.latestVersion || '')}</h2>
      <p>Du nutzt Version ${esc(info.currentVersion || '')}. Eine neuere Version ist verfügbar.</p>
      <p class="muted">${esc(info.notes || info.message || 'Lade den passenden Installer herunter und installiere ihn über die bestehende Version.')}</p>
      <div class="actions">
        <a class="button primary" href="${esc(downloadUrl)}" target="_blank" rel="noopener">Update herunterladen${size ? ` · ${esc(size)}` : ''}</a>
        ${info.releaseUrl ? `<a class="button" href="${esc(info.releaseUrl)}" target="_blank" rel="noopener">Release anzeigen</a>` : ''}
        <button type="button" onclick="dismissUpdateModal()">Später</button>
      </div>
    </section>`;
  document.body.appendChild(modal);
  enhanceTooltips(modal);
}

async function checkForAppUpdatePopup() {
  try {
    const info = await api('/api/system/update');
    renderUpdateModal(info);
    return info;
  } catch {
    return null;
  }
}

async function shutdownApp() {
  if (!confirm(`${APP_BRAND.productName} wirklich schließen?`)) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-backdrop';
  overlay.innerHTML = `
    <section class="modal-panel" role="status" aria-live="polite">
      <p class="eyebrow">${APP_BRAND.productName} wird beendet</p>
      <h2>Alle Programmfenster werden geschlossen.</h2>
      <p class="muted">Laufende ${APP_BRAND.productName}-Prozesse und das zugehörige App-Fenster werden jetzt beendet.</p>
    </section>`;
  document.body.appendChild(overlay);
  try { await fetch('/api/system/shutdown', { method: 'POST' }); } catch {}
  setTimeout(() => window.close(), 150);
}

async function logoutApp() {
  const token = await ensureAuthToken(false);
  try {
    await fetch('/api/auth/logout', { method: 'POST', headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
  } catch {}
  clearAuthSession();
  location.href = '/pages/login.html';
}

let pendingLegalLicenseState = null;

const RESTRICTED_ALLOWED_PAGES = new Set([
  '/pages/tests.html',
  '/pages/test.html',
  '/pages/review.html',
  '/pages/license.html',
  '/pages/settings.html'
]);

function applyRestrictedNavigation() {
  const lockedPages = new Set([
    '/pages/documents.html',
    '/pages/upload.html',
    '/pages/questions.html',
    '/pages/manual.html',
    '/pages/catalog.html',
    '/pages/stats.html'
  ]);
  document.querySelectorAll('header.topbar nav a[href]').forEach(link => {
    if (lockedPages.has(link.getAttribute('href'))) link.remove();
  });
  document.querySelectorAll('a.brand').forEach(link => {
    link.href = '/pages/tests.html';
  });
}

function showRestrictedModeBanner(license) {
  window.mediTestRestrictedMode = true;
  applyRestrictedNavigation();
  if (document.getElementById('restrictedModeBanner')) return;
  const main = document.querySelector('main');
  if (!main) return;
  const monthlyPrice = priceLabel(license?.monthlyPriceCents || 999, license?.currency || 'EUR');
  const banner = document.createElement('section');
  banner.id = 'restrictedModeBanner';
  banner.className = 'status restricted-mode-banner';
  banner.innerHTML = `
    <div>
      <strong>Eingeschränkter Modus</strong>
      <span>Die 7-tägige Testphase ist beendet. Tests aus vorhandenen Fragenpools können weiterhin gestartet, fortgesetzt und ausgewertet werden.</span>
    </div>
    <a class="button primary" href="/pages/license.html">Vollzugang für ${esc(monthlyPrice)} / Monat</a>`;
  main.prepend(banner);
}

function showTermsAcceptanceModal(state) {
  pendingLegalLicenseState = state;
  if (document.getElementById('termsAcceptanceModal')) return;
  const legal = state?.legal || {};
  const config = state?.access?.appConfig || {};
  const modal = document.createElement('div');
  modal.id = 'termsAcceptanceModal';
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <section class="modal-panel terms-modal" role="dialog" aria-modal="true" aria-labelledby="termsAcceptanceTitle">
      <p class="eyebrow">Zustimmung erforderlich</p>
      <h2 id="termsAcceptanceTitle">Nutzungsbedingungen & Datenschutz</h2>
      <p>Bitte bestätige die aktuell hinterlegten Versionen, bevor du ${APP_BRAND.productName} weiter nutzt.</p>
      <p class="muted">AGB-Version ${esc(config.currentTermsVersion || '-')} · Datenschutz-Version ${esc(config.currentPrivacyVersion || '-')}</p>
      <label class="checkline"><input id="acceptTermsCheck" type="checkbox"> <span>Ich akzeptiere die Nutzungsbedingungen.</span></label>
      <label class="checkline"><input id="acceptPrivacyCheck" type="checkbox"> <span>Ich akzeptiere die Datenschutzerklärung.</span></label>
      <div class="actions">
        ${config.termsOfUseUrl || legal.termsOfUseUrl ? `<a class="button" href="${esc(config.termsOfUseUrl || legal.termsOfUseUrl)}" target="_blank" rel="noopener">AGB öffnen</a>` : ''}
        ${config.privacyPolicyUrl || legal.privacyPolicyUrl ? `<a class="button" href="${esc(config.privacyPolicyUrl || legal.privacyPolicyUrl)}" target="_blank" rel="noopener">Datenschutz öffnen</a>` : ''}
        <button id="acceptTermsContinue" class="primary" type="button" disabled>Fortfahren</button>
        <button type="button" onclick="logoutApp()">Abmelden</button>
      </div>
      <div id="termsAcceptanceStatus" class="hidden"></div>
    </section>`;
  document.body.appendChild(modal);
  const terms = document.getElementById('acceptTermsCheck');
  const privacy = document.getElementById('acceptPrivacyCheck');
  const button = document.getElementById('acceptTermsContinue');
  const update = () => { button.disabled = !(terms.checked && privacy.checked); };
  terms.addEventListener('change', update);
  privacy.addEventListener('change', update);
  button.addEventListener('click', async () => {
    const msg = document.getElementById('termsAcceptanceStatus');
    button.disabled = true;
    status(msg, 'Speichere Zustimmung...');
    try {
      const access = await api('/api/legal-license/terms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ acceptTerms: true, acceptPrivacy: true })
      });
      pendingLegalLicenseState = { ...(pendingLegalLicenseState || {}), access };
      location.reload();
    } catch (error) {
      status(msg, error.message, 'status error');
      update();
    }
  });
  enhanceTooltips(modal);
}

function showLicenseAccessModal(state) {
  if (location.pathname.endsWith('/pages/license.html') || location.pathname.endsWith('/pages/contact.html')) return;
  const result = state?.access?.result || {};
  if (result.isValid || document.getElementById('licenseAccessModal')) return;
  const modal = document.createElement('div');
  modal.id = 'licenseAccessModal';
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="licenseAccessTitle">
      <p class="eyebrow">Lizenzprüfung</p>
      <h2 id="licenseAccessTitle">${esc(result.status === 'expired' ? 'Lizenz abgelaufen' : 'Zugriff nicht freigegeben')}</h2>
      <p>${esc(result.message || 'Keine gültige Lizenz gefunden.')}</p>
      <div class="actions">
        <a class="button primary" href="/pages/license.html">Rechtliches & Lizenz öffnen</a>
        <button type="button" onclick="logoutApp()">Abmelden</button>
      </div>
    </section>`;
  document.body.appendChild(modal);
  enhanceTooltips(modal);
}

async function ensureLegalLicenseCompliance() {
  if (location.pathname.endsWith('/pages/login.html')) return null;
  const user = await currentAuthUser(false);
  if (!user) return null;
  const state = await api('/api/legal-license/status');
  pendingLegalLicenseState = state;
  if (state.access?.result?.requiresTermsAcceptance) showTermsAcceptanceModal(state);
  else if (state.access?.result?.status === 'restricted') {
    const license = await api('/api/license/status').catch(() => null);
    showRestrictedModeBanner(license);
    if (!RESTRICTED_ALLOWED_PAGES.has(location.pathname)) {
      location.replace('/pages/tests.html?restricted=1');
    }
  }
  else if (!state.access?.result?.isValid) showLicenseAccessModal(state);
  return state;
}

function showProfileCompletionModal(settings, user) {
  return new Promise(resolve => {
    if (document.getElementById('profileCompletionModal')) return;
    const modal = document.createElement('div');
    modal.id = 'profileCompletionModal';
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <section class="modal-panel profile-onboarding-modal" role="dialog" aria-modal="true" aria-labelledby="profileCompletionTitle">
        <p class="eyebrow">Erster Login</p>
        <h2 id="profileCompletionTitle">Vervollständige bitte dein Profil</h2>
        <p>Diese Angaben helfen dabei, deinen Lernbereich sinnvoll zuzuordnen. Die Matrikelnummer ist optional.</p>
        <form id="profileCompletionForm">
          <label for="profileDisplayName">Vor- und Nachname</label>
          <input id="profileDisplayName" type="text" autocomplete="name" maxlength="200" required value="${esc(settings.displayName || user.displayName || '')}">
          <label for="profileStudyProgram">Studiengang</label>
          <input id="profileStudyProgram" type="text" maxlength="200" required placeholder="z. B. Humanmedizin" value="${esc(settings.studyProgram || '')}">
          <label for="profileUniversity">Hochschule / Universität</label>
          <input id="profileUniversity" type="text" autocomplete="organization" maxlength="200" required value="${esc(settings.university || '')}">
          <div class="field-row">
            <div>
              <label for="profileSemester">Semester</label>
              <input id="profileSemester" type="text" maxlength="80" required placeholder="z. B. 6. Semester" value="${esc(settings.semester || '')}">
            </div>
            <div>
              <label for="profileMatriculationNumber">Matrikelnummer <span class="muted">(optional)</span></label>
              <input id="profileMatriculationNumber" type="text" maxlength="80" autocomplete="off" value="${esc(settings.matriculationNumber || '')}">
            </div>
          </div>
          <p class="muted">Konto-E-Mail: ${esc(user.email || settings.email || '-')}</p>
          <div class="actions">
            <button class="primary" type="submit" id="completeProfileButton">Profil speichern</button>
            <button type="button" onclick="logoutApp()">Abmelden</button>
          </div>
          <div id="profileCompletionStatus" class="hidden"></div>
        </form>
      </section>`;
    document.body.appendChild(modal);
    const form = document.getElementById('profileCompletionForm');
    form.addEventListener('submit', async event => {
      event.preventDefault();
      const button = document.getElementById('completeProfileButton');
      const msg = document.getElementById('profileCompletionStatus');
      button.disabled = true;
      status(msg, 'Profil wird gespeichert...');
      try {
        const saved = await api('/api/profile/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            displayName: document.getElementById('profileDisplayName').value.trim(),
            studyProgram: document.getElementById('profileStudyProgram').value.trim(),
            university: document.getElementById('profileUniversity').value.trim(),
            semester: document.getElementById('profileSemester').value.trim(),
            matriculationNumber: document.getElementById('profileMatriculationNumber').value.trim()
          })
        });
        cacheAppSettings(saved);
        modal.remove();
        resolve(saved);
      } catch (error) {
        status(msg, error.message, 'status error');
        button.disabled = false;
      }
    });
    enhanceTooltips(modal);
    document.getElementById('profileDisplayName')?.focus();
  });
}

async function ensureProfileCompletion(user) {
  const settings = await getAppSettings();
  if (settings.profileCompleted) return settings;
  return showProfileCompletionModal(settings, user);
}

function showTrialFeedbackModal(settings) {
  if (document.getElementById('trialFeedbackModal')) return;
  const modal = document.createElement('div');
  modal.id = 'trialFeedbackModal';
  modal.className = 'modal-backdrop';
  modal.innerHTML = `
    <section class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="trialFeedbackTitle">
      <p class="eyebrow">7-tägige Testphase beendet</p>
      <h2 id="trialFeedbackTitle">Wie war deine Erfahrung mit ${APP_BRAND.productName}?</h2>
      <p>Dein kurzes Feedback hilft uns, Lernabläufe und Funktionen gezielt zu verbessern.</p>
      <p class="muted">Das Formular speichert dein Feedback in deinem Benutzerkonto und versendet keine E-Mail. Für eine Nachricht an den Support nutze das <a href="/pages/contact.html">Kontaktformular</a>.</p>
      <form id="trialFeedbackForm">
        <label for="trialFeedbackRating">Gesamtbewertung</label>
        <select id="trialFeedbackRating" required>
          <option value="">Bitte auswählen</option>
          <option value="5">5 – Sehr gut</option>
          <option value="4">4 – Gut</option>
          <option value="3">3 – In Ordnung</option>
          <option value="2">2 – Verbesserungswürdig</option>
          <option value="1">1 – Nicht überzeugend</option>
        </select>
        <label for="trialFeedbackComment">Was hat dir gefallen oder gefehlt? <span class="muted">(optional)</span></label>
        <textarea id="trialFeedbackComment" maxlength="2000" rows="5" placeholder="Dein Feedback"></textarea>
        <div class="actions">
          <button class="primary" type="submit" id="submitTrialFeedbackButton">Feedback speichern</button>
          <button type="button" id="deferTrialFeedbackButton">In 7 Tagen erinnern</button>
        </div>
        <div id="trialFeedbackStatus" class="hidden"></div>
      </form>
    </section>`;
  document.body.appendChild(modal);

  const submit = async action => {
    const submitButton = document.getElementById('submitTrialFeedbackButton');
    const deferButton = document.getElementById('deferTrialFeedbackButton');
    const msg = document.getElementById('trialFeedbackStatus');
    submitButton.disabled = true;
    deferButton.disabled = true;
    status(msg, action === 'submit' ? 'Feedback wird gespeichert...' : 'Erinnerung wird gespeichert...');
    try {
      const result = await api('/api/trial-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          rating: action === 'submit' ? Number(document.getElementById('trialFeedbackRating').value) : null,
          comment: action === 'submit' ? document.getElementById('trialFeedbackComment').value.trim() : ''
        })
      });
      if (action === 'submit') {
        cacheAppSettings({ ...settings, trialFeedbackSubmittedAt: new Date().toISOString() });
        status(msg, result.message || 'Vielen Dank für dein Feedback.', 'status success');
        setTimeout(() => modal.remove(), 700);
      } else {
        modal.remove();
      }
    } catch (error) {
      status(msg, error.message, 'status error');
      submitButton.disabled = false;
      deferButton.disabled = false;
    }
  };

  document.getElementById('trialFeedbackForm').addEventListener('submit', event => {
    event.preventDefault();
    submit('submit');
  });
  document.getElementById('deferTrialFeedbackButton').addEventListener('click', () => submit('later'));
  enhanceTooltips(modal);
}

async function ensureTrialFeedback(settings) {
  if (document.getElementById('termsAcceptanceModal') || document.getElementById('licenseAccessModal')) return;
  if (sessionStorage.getItem(TRIAL_FEEDBACK_SESSION_KEY) === '1') return;
  sessionStorage.setItem(TRIAL_FEEDBACK_SESSION_KEY, '1');
  if (settings.trialFeedbackSubmittedAt) return;

  const license = await api('/api/license/status');
  const trialEnd = license.trialEndsAt ? new Date(license.trialEndsAt).getTime() : 0;
  const nextPrompt = settings.trialFeedbackNextPromptAt ? new Date(settings.trialFeedbackNextPromptAt).getTime() : 0;
  if (!license.baseProductPurchased || !trialEnd || trialEnd > Date.now() || nextPrompt > Date.now()) return;
  showTrialFeedbackModal(settings);
}

async function ensureUserOnboarding() {
  if (location.pathname.endsWith('/pages/login.html') || location.pathname.endsWith('/pages/contact.html')) return;
  const user = await currentAuthUser(false);
  if (!user) return;
  const legalState = await ensureLegalLicenseCompliance();
  const restricted = legalState?.access?.result?.status === 'restricted';
  const settings = restricted ? await getAppSettings() : await ensureProfileCompletion(user);
  await ensureTrialFeedback(settings);
}

function renderAccountDock(user) {
  if (!user || document.getElementById('accountDock')) return;

  const dock = document.createElement('aside');
  dock.id = 'accountDock';
  dock.className = 'account-dock';
  dock.setAttribute('aria-label', 'Angemeldeter Benutzer');

  const userInfo = document.createElement('span');
  userInfo.className = 'account-dock-user';
  userInfo.textContent = user.displayName || user.email;
  userInfo.title = [user.email, accountMetaLabel(user.plan || 'Kostenlos'), accountMetaLabel(user.licenseStatus || 'Aktiv')].filter(Boolean).join(' · ');
  dock.appendChild(userInfo);

  const logout = document.createElement('button');
  logout.id = 'logoutBtn';
  logout.className = 'account-dock-logout';
  logout.type = 'button';
  logout.textContent = 'Abmelden';
  logout.onclick = logoutApp;
  dock.appendChild(logout);

  document.body.appendChild(dock);
  enhanceTooltips(dock);
}

const productLogoMarkup = `
  <span class="brand-mark" aria-hidden="true">
    <img src="${APP_BRAND.logoPath}" alt="">
  </span>`;

function applyProductBranding() {
  document.querySelectorAll('a.brand').forEach(link => {
    if (link.querySelector('.brand-mark')) return;
    link.innerHTML = `${productLogoMarkup}<span>${APP_BRAND.productName}</span>`;
    link.setAttribute('aria-label', `${APP_BRAND.productName} Startseite`);
  });

  const authTitle = document.querySelector('.auth-brand h1');
  if (authTitle && !authTitle.querySelector('.brand-mark')) {
    authTitle.classList.add('auth-brand-logo');
    authTitle.innerHTML = `${productLogoMarkup}<span>${APP_BRAND.productName}</span>`;
  }

  const successLogo = document.querySelector('.login-success-logo');
  if (successLogo) {
    successLogo.innerHTML = `<img src="${APP_BRAND.logoPath}" alt="">`;
  }

  if (!document.querySelector('link[rel="icon"]')) {
    const favicon = document.createElement('link');
    favicon.rel = 'icon';
    favicon.type = 'image/svg+xml';
    favicon.href = APP_BRAND.logoPath;
    document.head.appendChild(favicon);
  }
}

document.addEventListener('DOMContentLoaded', applyProductBranding);

document.addEventListener('DOMContentLoaded', () => {
  const nav = document.querySelector('header.topbar nav');
  if (!nav) return;
  if (!nav.querySelector('a[href="/pages/catalog.html"]')) {
    const link = document.createElement('a');
    link.href = '/pages/catalog.html';
    link.textContent = 'Katalog';
    const manualLink = nav.querySelector('a[href="/pages/manual.html"]');
    if (manualLink) nav.insertBefore(link, manualLink);
    else nav.appendChild(link);
  }
  if (!nav.querySelector('a[href="/pages/license.html"]')) {
    const license = document.createElement('a');
    license.href = '/pages/license.html';
    license.textContent = 'Rechtliches & Lizenz';
    nav.appendChild(license);
  }
  if (!nav.querySelector('a[href="/pages/contact.html"]')) {
    const support = document.createElement('a');
    support.href = '/pages/contact.html';
    support.textContent = 'Support';
    const license = nav.querySelector('a[href="/pages/license.html"]');
    if (license) nav.insertBefore(support, license);
    else nav.appendChild(support);
  }
  if (!nav.querySelector('a[href="/pages/settings.html"]')) {
    const link = document.createElement('a');
    link.href = '/pages/settings.html';
    link.textContent = 'Einstellungen';
    nav.appendChild(link);
  }
  nav.querySelectorAll('a[href]').forEach(a => {
    if (a.getAttribute('href') === location.pathname) a.classList.add('active');
  });
  if (document.getElementById('shutdownBtn')) return;
  const btn = document.createElement('button');
  btn.id = 'shutdownBtn';
  btn.className = 'danger nav-shutdown';
  btn.type = 'button';
  btn.textContent = 'Schließen';
  btn.onclick = shutdownApp;
  nav.appendChild(btn);
  currentAuthUser(false).then(user => {
    if (user) renderAccountDock(user);
  }).catch(() => {});
});

document.addEventListener('DOMContentLoaded', () => {
  if (location.pathname.endsWith('/pages/login.html')) return;
  ensureUserOnboarding().catch(error => {
    console.warn('Onboarding-Prüfung nicht verfügbar:', error?.message || 'Unbekannter Fehler');
  });
});

document.addEventListener('DOMContentLoaded', () => {
  enhanceTooltips();
  const observer = new MutationObserver(mutations => {
    mutations.forEach(mutation => mutation.addedNodes.forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE) enhanceTooltips(node);
    }));
  });
  observer.observe(document.body, { childList: true, subtree: true });
});

window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  const settings = window.mediTestSettings || cachedSettings();
  if (!settings || settings.theme === 'system') applyTheme(settings?.theme || 'system');
});
