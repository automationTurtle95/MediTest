const AUTH_SESSION_KEY = 'meditest-firebase-session';
const AUTH_CONFIG_KEY = 'meditest-auth-config';
let authConfigPromise = null;

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
  return raw || 'Firebase-Anmeldung fehlgeschlagen.';
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
  const name = (displayName || auth.displayName || email.split('@')[0] || 'MediTest Nutzer').trim();
  const user = {
    userId: auth.localId || auth.user_id || '',
    email,
    displayName: name,
    plan: 'Kostenlos',
    licenseStatus: 'Aktiv',
    authMode: 'firebase',
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
  let auth = created;
  if (payload.displayName) {
    const updated = await firebaseAuthRequest('update', {
      idToken: created.idToken,
      displayName: payload.displayName,
      returnSecureToken: true
    });
    auth = { ...created, ...updated, localId: updated.localId || created.localId, email: updated.email || created.email };
  }
  saveFirebaseSession(auth, payload.displayName);
  try { return await api('/api/auth/me'); }
  catch (err) { clearAuthSession(); throw err; }
}

async function loginWithFirebase(payload) {
  const auth = await firebaseAuthRequest('signInWithPassword', {
    email: payload.email,
    password: payload.password,
    returnSecureToken: true
  });
  saveFirebaseSession(auth, auth.displayName);
  try { return await api('/api/auth/me'); }
  catch (err) { clearAuthSession(); throw err; }
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
  saveFirebaseSession({ ...auth, ...updated, email: updated.email || email, localId: updated.localId || auth.localId }, session.user?.displayName || '');
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
    if (res.status === 401 && !location.pathname.endsWith('/pages/login.html')) {
      clearAuthSession();
      redirectToLogin();
    }
    const msg = data?.error || data || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

async function downloadApiFile(path, fallbackName = 'MediTest.pdf') {
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
function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

const TOOLTIP_BY_TEXT = new Map([
  ['Dokumente', 'Unterlagen hochladen, Fragenpools verwalten und Tests starten.'],
  ['Katalog', 'Themenspezifische Firestore-Tests herunterladen.'],
  ['Manuell', 'Eigene Multiple-Choice-Fragen ohne Datei anlegen.'],
  ['Tests', 'Gestartete und abgeschlossene Tests ansehen.'],
  ['Statistik', 'Ergebnisse und Fehlerschwerpunkte auswerten.'],
  ['Lizenz', 'Testphase, Abo und Katalogzugang ansehen.'],
  ['Einstellungen', 'Profil und Darstellung konfigurieren.'],
  ['Einloggen', 'Mit deinem MediTest-Konto anmelden.'],
  ['Konto erstellen', 'Neuen MediTest-Zugang anlegen.'],
  ['Registrieren', 'Neues Konto erstellen und direkt anmelden.'],
  ['Passwort vergessen?', 'E-Mail zum Zurücksetzen des Passworts senden.'],
  ['Passwort ändern', 'Aktuelles Passwort prüfen und ein neues Passwort setzen.'],
  ['Abmelden', 'Aktuelle Sitzung beenden.'],
  ['Schließen', 'MediTest lokal beenden.'],
  ['Dokumente verwalten', 'Zur kombinierten Dokumenten- und Hochladen-Seite wechseln.'],
  ['Tests anzeigen', 'Gespeicherte Tests öffnen.'],
  ['Dokumente anzeigen', 'Zur Dokumentenübersicht wechseln.'],
  ['Fragenpool mit neuen Fragen öffnen', 'Den gesamten Fragenpool öffnen; neue Fragen stehen oben.'],
  ['Herunterladen', 'Firestore-Test in deine Firestore-Dokumente importieren.'],
  ['Veröffentlichen', 'Lokalen Fragenpool als Admin im Firestore-Katalog bereitstellen.'],
  ['Programm schließen', 'MediTest lokal beenden.'],
  ['Hochladen & Text extrahieren', 'Datei speichern und Text für spätere Fragenpools extrahieren.'],
  ['Zur Übersicht', 'Zur Dokumentenübersicht zurückkehren.'],
  ['Importieren', 'Fragen aus der ausgewählten TXT-Datei importieren.'],
  ['Generieren', 'Neue Fragen erzeugen.'],
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
  ['Abo starten', 'Monatsabo nach der Testphase vorbereiten.'],
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
  TOOLTIP_BY_SELECTOR.forEach(([selector, text]) => {
    root.querySelectorAll?.(selector).forEach(el => applyTooltip(el, text));
  });

  root.querySelectorAll?.('a[href],button,input,select,textarea,label.checkline').forEach(el => {
    const text = TOOLTIP_BY_TEXT.get(tooltipText(el));
    if (text) applyTooltip(el, text);
  });
}

window.enhanceTooltips = enhanceTooltips;

const SETTINGS_CACHE_KEY = 'meditest-settings';
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

const initialSettings = cachedSettings();
if (initialSettings?.theme) applyTheme(initialSettings.theme);

function accountMetaLabel(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.toLowerCase() === 'free') return 'Kostenlos';
  if (text.toLowerCase() === 'active') return 'Aktiv';
  return text;
}

async function shutdownApp() {
  if (!confirm('MediTest wirklich schließen?')) return;
  try { await fetch('/api/system/shutdown', { method: 'POST' }); } catch {}
  alert('MediTest wird beendet. Das Browserfenster kann geschlossen werden.');
}

async function logoutApp() {
  const token = await ensureAuthToken(false);
  try {
    await fetch('/api/auth/logout', { method: 'POST', headers: token ? { 'Authorization': `Bearer ${token}` } : {} });
  } catch {}
  clearAuthSession();
  location.href = '/pages/login.html';
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
    license.textContent = 'Lizenz';
    nav.appendChild(license);
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
  getAppSettings().catch(() => {});
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
