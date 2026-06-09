# MediTest Firebase Backend

Diese Firebase-Konfiguration enthält den KI-Proxy und die Firestore-Regeln für den MediTest-Katalog sowie die privaten Nutzerdaten. MediTest sendet das Firebase-ID-Token des angemeldeten Nutzers mit. Die Function prüft dieses Token und generiert die Fragen serverseitig mit Genkit und Gemini. Der geheime Gemini-Key liegt als `GEMINI_API_KEY` in Firebase Secret Manager.

## Einmalige Einrichtung

Wenn ein Gemini-Key versehentlich in Chat, Logs oder Screenshots gelandet ist, lösche ihn zuerst in der Google/Firebase Console und erstelle einen neuen Key.

Aktiviere in Firebase Authentication unter `Sign-in method` die Anbieter `Email/Password`, `Google` und `Apple`. Unter `Settings -> Authorized domains` müssen für die lokale MediTest-App mindestens `127.0.0.1` und `localhost` freigegeben sein. Der Apple-Anbieter benötigt zusätzlich die vollständige Apple-Developer-Konfiguration mit Service ID, Team ID, Key ID und privatem Schlüssel. In MediTest werden die sichtbaren Provider über `Auth:Firebase:GoogleEnabled` und `Auth:Firebase:AppleEnabled` gesteuert.

1. Firebase CLI installieren und anmelden:

   ```powershell
   npm install -g firebase-tools
   firebase login
   ```

2. Firebase-Projekt verbinden:

   ```powershell
   cd firebase
   Copy-Item .firebaserc.example .firebaserc
   ```

   In `.firebaserc` `DEIN_FIREBASE_PROJECT_ID` durch deine Firebase-Projekt-ID ersetzen.

3. Abhängigkeiten installieren:

   ```powershell
   npm --prefix functions install
   ```

4. Gemini-Key als Firebase Secret speichern:

   ```powershell
   npx firebase-tools functions:secrets:set GEMINI_API_KEY
   ```

5. Function und Firestore-Regeln bereitstellen:

   ```powershell
   npx firebase-tools deploy --only functions,firestore:rules
   ```

Zusätzlich zur KI stellt das Projekt `meditestRedeemCatalogCode` für die atomare Einmalverwendung eines Gratis-Codes pro Benutzerkonto und `meditestDeleteAccount` für die vollständige Kontolöschung bereit. Alle geschützten Funktionen prüfen das Firebase-ID-Token; KI und Code-Einlösung verlangen außerdem eine bestätigte E-Mail-Adresse.

## KI-Nutzung begrenzen

Die Function erzwingt die Kontingente serverseitig und schreibt die Reservierung atomar in Firestore. Dadurch können parallele Anfragen ein Kontingent nicht mehrfach verbrauchen. Standardwerte:

| Parameter | Standard | Bedeutung |
| --- | ---: | --- |
| `AI_MAX_QUESTIONS_PER_REQUEST` | 25 | Maximale Fragen pro Generierung |
| `AI_DAILY_QUESTION_LIMIT` | 50 | Maximale angeforderte Fragen pro Nutzer und UTC-Tag |
| `AI_MONTHLY_QUESTION_LIMIT` | 500 | Maximale angeforderte Fragen pro Nutzer und UTC-Monat |
| `AI_DAILY_REQUEST_LIMIT` | 10 | Maximale Generierungsanfragen pro Nutzer und UTC-Tag |
| `AI_COOLDOWN_SECONDS` | 30 | Mindestabstand zwischen zwei akzeptierten Anfragen |
| `AI_USAGE_RETENTION_DAYS` | 90 | Aufbewahrungsziel für einzelne Nutzungsereignisse |
| `AI_MAX_PROMPT_CHARS` | 50000 | Maximale Prompt-Länge pro Anfrage |

Abweichende Werte können vor dem Deploy in `functions/.env.meditest-12354` hinterlegt werden:

```dotenv
AI_MAX_QUESTIONS_PER_REQUEST=25
AI_DAILY_QUESTION_LIMIT=50
AI_MONTHLY_QUESTION_LIMIT=500
AI_DAILY_REQUEST_LIMIT=10
AI_COOLDOWN_SECONDS=30
AI_USAGE_RETENTION_DAYS=90
AI_MAX_PROMPT_CHARS=50000
FREE_CATALOG_CODE_HASHES=33D660B54A9FFBD438D6D99EBDB7650EADCC2F871EE04C058205E5DCB0BE0876
```

Anschließend die Functions erneut bereitstellen:

```powershell
npx firebase-tools deploy --only functions --project meditest-12354
```

## KI-Nutzung überwachen

Die Function speichert keine Skripttexte und keine Prompts. Gespeichert werden Nutzer-ID, E-Mail, Zeit, Modell, angeforderte und erzeugte Fragen, Laufzeit und Ergebnisstatus:

- `aiUsage/{uid}`: kumulierter Nutzerstand
- `aiUsage/{uid}/days/{YYYY-MM-DD}`: Tagesstand
- `aiUsage/{uid}/months/{YYYY-MM}`: Monatsstand
- `aiGenerationEvents/{eventId}`: einzelne Generierungsversuche

Angemeldete Nutzer erhalten ihr persönliches Restkontingent über `meditestAiStatus`; MediTest zeigt diese Werte im KI-Startfenster vor der Generierung. Admins mit Firebase Custom Claim `admin=true` sehen die gesammelten Daten in MediTest unter `Katalog -> KI-Nutzung`. Die Admin-Function `meditestAiUsage` liefert dafür eine geschützte Übersicht. Strukturierte Laufzeitprotokolle sind außerdem in Cloud Logging und über folgenden Befehl verfügbar:

```powershell
npx firebase-tools functions:log --only meditestAi
```

Für das automatische Löschen alter Ereignisse kann in Firestore eine TTL-Richtlinie für das Feld `expiresAt` der Collection Group `aiGenerationEvents` aktiviert werden.

## Genkit Monitoring

Die Function aktiviert Firebase-Telemetrie für Genkit zur Laufzeit und nutzt den benannten Flow `meditestGenerateQuestions`. Nach einem erfolgreichen Request erscheinen Produktions-Traces und Messwerte in Firebase/Google Cloud Observability. Für die vollständige Anzeige müssen im Projekt die Observability-APIs aktiv sein und der Function-Service-Account Schreibrechte haben:

```powershell
gcloud auth login
gcloud config set project meditest-12354
gcloud services enable logging.googleapis.com cloudtrace.googleapis.com monitoring.googleapis.com
gcloud projects add-iam-policy-binding meditest-12354 --member "serviceAccount:495645961863-compute@developer.gserviceaccount.com" --role "roles/logging.logWriter"
gcloud projects add-iam-policy-binding meditest-12354 --member "serviceAccount:495645961863-compute@developer.gserviceaccount.com" --role "roles/cloudtrace.agent"
gcloud projects add-iam-policy-binding meditest-12354 --member "serviceAccount:495645961863-compute@developer.gserviceaccount.com" --role "roles/monitoring.metricWriter"
```

Wenn `gcloud` nicht angemeldet ist, kann der Functions-Deploy trotzdem über `npx firebase-tools deploy --only functions,firestore:rules --project meditest-12354` laufen; die IAM/API-Schritte müssen dann in der Cloud Console oder nach `gcloud auth login` nachgezogen werden.

## Admin-Konto für den Firestore-Katalog

Firestore trennt Katalog und Nutzerdaten:

- `catalogTests`: Angemeldete Nutzer dürfen lesen; schreiben darf nur ein Konto mit Firebase Custom Claim `admin=true`.
- `users/{uid}/...`: Private Profil-, Dokument-, Fragen- und Testdaten; lesen und schreiben darf nur der jeweilige Firebase-Nutzer.
- `thematicTests`: Legacy-Katalogpfad mit denselben Admin-Regeln, falls ältere Katalogdaten noch vorhanden sind.

1. Admin-Benutzer in Firebase Authentication anlegen oder über MediTest registrieren.
2. Custom Claim setzen. Das Skript nutzt das Firebase Admin SDK; lokal braucht es Application Default Credentials, z. B. über `gcloud auth application-default login` oder `GOOGLE_APPLICATION_CREDENTIALS` mit einem Service-Account.

   ```powershell
   cd firebase/functions
   npm run admin:set -- admin@example.com
   ```

3. In MediTest abmelden und wieder anmelden, damit das neue Firebase-ID-Token den Claim enthält.

## MediTest konfigurieren

MediTest nutzt standardmäßig die Firebase Function:

- KI-Anbieter: `Firebase Function`
- KI-Modell: `gemini-2.5-flash`
- API-Basis-URL: die bereitgestellte Function-URL, z. B. `https://europe-west3-DEIN_PROJEKT.cloudfunctions.net/meditestAi`
- API-Key: keiner in MediTest

Danach läuft die Fragegenerierung über Firebase. Der echte Gemini-Key liegt nicht mehr in MediTest.

## Lizenz und Zahlungen

MediTest V4.0.2 bereitet das Lizenzmodell vor:

- 7 Tage Testphase pro Firebase-Nutzer
- 5,99 EUR pro Monat für das Abo
- Katalogzugang und Premium-Freischaltung per Code

Produktive Zahlungen müssen serverseitig über einen Zahlungsanbieter laufen. Eine geschützte Function erstellt die Checkout-Sitzung und bindet sie über serverseitige Metadaten an Firebase-UID, Kaufart und gegebenenfalls Katalog-ID. Ein signierter, idempotent verarbeiteter Webhook aktualisiert anschließend den Abo-Status bzw. gekaufte Katalogtest-IDs unter `users/{uid}/billing/license`. Die Firestore-Regeln müssen direkte Nutzer-Schreibzugriffe auf diesen Lizenzpfad sperren; vorher müssen sämtliche Lizenzänderungen, einschließlich Testphase und Codes, in vertrauenswürdige Functions verlagert werden. Die vorhandenen `Billing:SubscriptionCheckoutUrl` und `Billing:CatalogCheckoutUrl` sind nur vorbereitete Weiterleitungen und ersetzen diesen Ablauf nicht. Premium- und Admin-Konten haben Zugriff auf alle Katalogtests. Bei einer Kontolöschung werden private Firestore-Daten, KI-Nutzungsdaten und das Authentication-Konto entfernt.
