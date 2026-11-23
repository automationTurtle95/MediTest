// Sicherheitstest fuer die PRODUKTIV freigegebenen Firestore-Regeln (SEC-001).
//
// Holt das aktuell released Ruleset von cloud.firestore und laesst es von
// Googles Rules-Test-API auswerten. Prueft nichts textuell, sondern das
// Verhalten - ein frueherer Textcheck hatte sich an der Kommentarzeile
// verschluckt, in der die alte Regel zitiert wird.
//
// Start:
//   export FIREBASE_TOKEN="$(tr -d '[:space:]' < .claudian/firebase_token.txt)"

//   node firebase/tools/rules-security-test.mjs
//
// Token NIE als Argument uebergeben (siehe CLAUDE.md) - nur per Umgebungsvariable.
// Der Lauf ist rein lesend und veraendert nichts am Projekt.

const REFRESH = process.env.FIREBASE_TOKEN;
const CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";
const PROJECT = "meditest-12354";

const tr = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    refresh_token: REFRESH, grant_type: "refresh_token" }),
});
const token = (await tr.json()).access_token;
const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const rel = await (await fetch(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/releases`, { headers: H })).json();
const fsRel = rel.releases.find(r => r.name.endsWith("/cloud.firestore"));
const rsId = fsRel.rulesetName.split("/").pop();
const rs = await (await fetch(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}/rulesets/${rsId}`, { headers: H })).json();
const live = rs.source.files[0].content;   // exakt das, was produktiv ausgeliefert wird

const UID = "angreifer-uid";
const tc = (exp, method, path, data) => ({
  expectation: exp,
  request: { auth: { uid: UID, token: { email_verified: true } },
    method, path: `/databases/(default)/documents/${path}`, ...(data ? { data } : {}) },
  functionMocks: [], pathEncoding: "URL_ENCODED", expressionReportLevel: "NONE",
});

const cases = [
  tc("DENY",  "create", `users/${UID}/billing/license`, { dataJson: JSON.stringify({ premiumActive: true, subscriptionActive: true, baseProductPurchased: true }) }),
  tc("DENY",  "update", `users/${UID}/billing/license`, { dataJson: JSON.stringify({ premiumActive: true }) }),
  tc("DENY",  "delete", `users/${UID}/billing/license`),
  tc("ALLOW", "get",    `users/${UID}/billing/license`),
  tc("ALLOW", "create", `users/${UID}/settings/profile`, { theme: "dark" }),
  tc("ALLOW", "create", `users/${UID}/testSessions/s1`, { dataJson: "{}" }),
  tc("ALLOW", "create", `users/${UID}/documents/d1`, { title: "x" }),
];
const namen = ["Angriff: billing create (DENY)", "Angriff: billing update (DENY)", "Angriff: billing delete (DENY)",
  "Regression: billing lesen (ALLOW)", "Regression: settings (ALLOW)", "Regression: testSessions (ALLOW)", "Regression: documents (ALLOW)"];

const res = await fetch(`https://firebaserules.googleapis.com/v1/projects/${PROJECT}:test`, {
  method: "POST", headers: H,
  body: JSON.stringify({ source: { files: [{ name: "firestore.rules", content: live }] }, testSuite: { testCases: cases } }),
});
const body = await res.json();
let fehler = 0;
body.testResults.forEach((r, i) => {
  const ok = r.state === "SUCCESS"; if (!ok) fehler++;
  console.log(`${ok ? "  OK  " : " FEHL "} ${namen[i]}`);
});
console.log(`\nGeprueft gegen das LIVE freigegebene Ruleset ${rsId}`);
console.log(fehler === 0 ? "=> SEC-001 produktiv geschlossen" : `=> ${fehler} Abweichung(en)`);
process.exit(fehler === 0 ? 0 : 1);
