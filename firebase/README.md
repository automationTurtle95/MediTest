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
FREE_CATALOG_CODE_HASHES=<SHA-256-HASH>
PREMIUM_CODE_HASHES=<SHA-256-HASH>
STRIPE_CATALOG_UNIT_PRICE_ID=price_...
STRIPE_CATALOG_ENDING_PRICE_ID=price_...
STRIPE_PORTAL_CONFIGURATION_ID=bpc_...
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
- `users/{uid}/...`: Private Profil-, Dokument-, Fragen- und Testdaten; das Nutzer-Stammdokument wird nur serverseitig gepflegt.
- `licenses/{uid}`: Lizenztyp, Status, Laufzeit und Gerätebegrenzung; Nutzer dürfen nur die eigene Lizenz lesen.
- `deviceActivations/{uid}/devices/{deviceId}`: Serververwaltete Geräteaktivierungen.
- `termsAcceptances/{uid}`: Nachvollziehbare Zustimmung zu den aktuellen AGB- und Datenschutzversionen.
- `appConfig/global`: Globale Versionsstände, Offline-Tage, Links und Standardwerte.
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

MediTest integriert folgendes Lizenzmodell:

- einmaliger Basiskauf für 9,99 EUR
- 7 Tage vollständige Testphase ab bestätigtem Basiskauf
- danach optionales Monatsabo für 5,99 EUR
- ohne Abo eingeschränkter Modus für vorhandene Tests und Auswertungen
- Katalogtests als separate Kaufartikel
- Premium-Freischaltung per administrativem Code ohne Kataloginhalte
- MedAT-Katalogtests für 49,99 EUR pro Test
- serverseitige Geräteaktivierung, Gerätebegrenzung und Sperrstatusprüfung
- versionierte AGB-/Datenschutz-Zustimmung und globale `appConfig`

Die geschützte Function `meditestLicenseAccess` legt Nutzer-, Lizenz-, Geräte- und Zustimmungsdaten ausschließlich mit dem verifizierten Firebase-Token an. Der Client kann diese sicherheitsrelevanten Dokumente nicht direkt schreiben.

Die geschützte Function `meditestCreateCheckout` erstellt getrennte Stripe-Checkouts für den Basiskauf (`BILLING_PRODUCT_PRICE_CENTS`), das Monatsabo (`BILLING_MONTHLY_PRICE_CENTS`) und Katalogtests. Bestehende Katalogpreise verwenden `STRIPE_CATALOG_UNIT_PRICE_ID` und `STRIPE_CATALOG_ENDING_PRICE_ID`; MedAT verwendet einen serverseitigen Festpreis von 49,99 EUR. `meditestStripeWebhook` prüft jedes Ereignis mit `MEDITEST_STRIPE_WEBHOOK_SECRET` und startet die Testphase erst nach bestätigtem Basiskauf. `meditestDownloadAccess` gibt den Windows-Download nur nach diesem Kauf oder einer administrativen Freischaltung aus. `meditestStripePortal` verwendet `STRIPE_PORTAL_CONFIGURATION_ID`.

Die Payments-Extension kann für diese Datenbank nicht verwendet werden, weil ihre Gen-1-Firestore-Trigger mit dem Firestore-Multiregionsstandort `eur3` nicht bereitgestellt werden können. Die direkten Functions liefern denselben Checkout-, Webhook- und Portalablauf ohne diese Standortbeschränkung.

Die Firestore-Regeln erlauben Nutzern nur Lesezugriff auf Lizenz- und Stripe-Ausgabedaten. Premium-Code, Gratis-Code und Gratis-Katalogverbrauch laufen ebenfalls über geschützte Functions. Bei einer Kontolöschung werden private Firestore-Daten, Stripe-Kundendaten, KI-Nutzungsdaten und das Authentication-Konto entfernt.
