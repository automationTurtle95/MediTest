# Meduvalo Firebase Backend

Diese Firebase-Konfiguration enthält den KI-Proxy und die Firestore-Regeln für den Meduvalo-Katalog sowie die privaten Nutzerdaten. Meduvalo sendet das Firebase-ID-Token des angemeldeten Nutzers mit. Die Function prüft dieses Token und generiert die Fragen serverseitig mit dem offiziellen Google Gen AI SDK und Gemini. Der geheime Gemini-Key liegt als `GEMINI_API_KEY` in Firebase Secret Manager.

Das bestehende Firebase-Projekt bleibt `meditest-12354`. Projekt-ID,
Function-Namen, Codebase, Collections, Secret-Namen und Datenpfade werden für
die Umbenennung nicht geändert. Die öffentliche Produktdomain ist
`https://meduvalo.at`; `BILLING_WEBSITE_BASE_URL` muss diesen Wert verwenden.

## Einmalige Einrichtung

Wenn ein Gemini-Key versehentlich in Chat, Logs oder Screenshots gelandet ist, lösche ihn zuerst in der Google/Firebase Console und erstelle einen neuen Key.

Aktiviere in Firebase Authentication unter `Sign-in method` die Anbieter `Email/Password`, `Google` und `Apple`. Unter `Settings -> Authorized domains` müssen für die lokale Meduvalo-App mindestens `127.0.0.1` und `localhost` freigegeben sein. Der Apple-Anbieter benötigt zusätzlich die vollständige Apple-Developer-Konfiguration mit Service ID, Team ID, Key ID und privatem Schlüssel. In Meduvalo werden die sichtbaren Provider über `Auth:Firebase:GoogleEnabled` und `Auth:Firebase:AppleEnabled` gesteuert.

Nach erfolgreicher Domain-Verbindung sollte auch `meduvalo.at` unter
`Authentication -> Settings -> Authorized domains` geprüft beziehungsweise
ergänzt werden.

Absenderdomain und Aktions-URL sind in Firebase zwei getrennte Einstellungen.
Damit Bestätigungs- und Passwort-E-Mails keinen sichtbaren Link mit
`meditest-12354.firebaseapp.com` enthalten:

1. `meduvalo.at` muss im selben Firebase-Projekt unter `Hosting` als verbundene
   Custom Domain erscheinen.
2. Unter `Authentication -> Templates` eine E-Mail-Vorlage bearbeiten.
3. Zusätzlich zu `Domain anpassen` auf `Aktions-URL anpassen` klicken.
4. Als Aktions-URL exakt `https://meduvalo.at/__/auth/action` speichern.

Diese Aktions-URL gilt anschließend für alle Firebase-Authentifizierungs-
vorlagen. Die Clients senden
`https://meduvalo.at/purchase.html?emailVerified=1` als Rückkehradresse.

Firebase kann Änderungen der Aktions-URL vorübergehend mit
`EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED` ablehnen. Das ist eine serverseitige
Einschränkung und kein DNS- oder Hostingfehler. Der REST-Parameter
`linkDomain` ändert bei normalen Web-Bestätigungs-E-Mails nicht die
Aktions-URL. Für eine dauerhafte Änderung von
`notification.sendEmail.callbackUri` muss Firebase Support die
Templateänderung für das Projekt freischalten. Alternativ ist ein eigener
serverseitiger Mailversand mit Firebase Admin SDK und SMTP erforderlich.

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

5. Für den Versand des Supportformulars das Passwort des IONOS-Postfachs
   `support@meduvalo.at` als Firebase-Secret speichern:

   ```powershell
   npx firebase-tools functions:secrets:set MEDITEST_SMTP_PASSWORD
   ```

   Das Passwort wird nicht in einer Konfigurationsdatei gespeichert. Für ein
   normales IONOS Mail-Basic- oder Mail-Business-Postfach gelten folgende
   Laufzeitwerte:

   ```dotenv
   SUPPORT_RECIPIENT_EMAIL=support@meduvalo.at
   SUPPORT_FROM_EMAIL=Meduvalo Support <support@meduvalo.at>
   SUPPORT_SMTP_HOST=smtp.ionos.de
   SUPPORT_SMTP_PORT=465
   SUPPORT_SMTP_USERNAME=support@meduvalo.at
   SUPPORT_MAX_DAILY_REQUESTS=5
   ```

   Port `465` verwendet SSL/TLS. Falls er in der Laufzeitumgebung nicht
   erreichbar ist, kann `SUPPORT_SMTP_PORT=587` für STARTTLS verwendet werden.

6. Für automatisierte, serverseitige Stripe-Produktprüfungen einen langen
   zufälligen Wartungstoken als Secret speichern. Der Adminbereich selbst
   verwendet weiterhin das Firebase-Admin-Konto:

   ```powershell
   npx firebase-tools functions:secrets:set MEDITEST_STRIPE_VALIDATION_TOKEN
   ```

7. Function und Firestore-Regeln bereitstellen:

   ```powershell
   npx firebase-tools deploy --only functions,firestore:rules
   ```

Zusätzlich zur KI stellt das Projekt `meditestRedeemCatalogCode` für die atomare Einmalverwendung eines Gratis-Codes pro Benutzerkonto und `meditestDeleteAccount` für die vollständige Kontolöschung bereit. Alle geschützten Funktionen prüfen das Firebase-ID-Token; KI und Code-Einlösung verlangen außerdem eine bestätigte E-Mail-Adresse.

`meditestSupportRequest` nimmt authentifizierte Supportanfragen entgegen,
begrenzt sie pro Konto und UTC-Tag, speichert sie dauerhaft unter
`supportRequests/{ticketId}` und sendet eine Benachrichtigung direkt über das
IONOS-Postfach `support@meduvalo.at`. Ohne konfiguriertes SMTP-Passwort bleibt
das Ticket gespeichert und wird mit dem Status `stored` geführt.

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
STRIPE_PORTAL_CONFIGURATION_ID=bpc_...
INSTALLATION_AUTHORIZATION_TTL_HOURS=24
LICENSING_DEFAULT_MAX_DEVICES=2
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

Angemeldete Nutzer erhalten ihr persönliches Restkontingent über `meditestAiStatus`; Meduvalo zeigt diese Werte im KI-Startfenster vor der Generierung. Admins mit Firebase Custom Claim `admin=true` sehen die gesammelten Daten in Meduvalo unter `Katalog -> KI-Nutzung`. Die Admin-Function `meditestAiUsage` liefert dafür eine geschützte Übersicht. Strukturierte Laufzeitprotokolle sind außerdem in Cloud Logging und über folgenden Befehl verfügbar:

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

1. Admin-Benutzer in Firebase Authentication anlegen oder über Meduvalo registrieren.
2. Custom Claim setzen. Das Skript nutzt das Firebase Admin SDK; lokal braucht es Application Default Credentials, z. B. über `gcloud auth application-default login` oder `GOOGLE_APPLICATION_CREDENTIALS` mit einem Service-Account.

   ```powershell
   cd firebase/functions
   npm run admin:set -- admin@example.com
   ```

3. In Meduvalo abmelden und wieder anmelden, damit das neue Firebase-ID-Token den Claim enthält.

## Meduvalo konfigurieren

Meduvalo nutzt standardmäßig die Firebase Function:

- KI-Anbieter: `Firebase Function`
- KI-Modell: `gemini-2.5-flash`
- API-Basis-URL: die bereitgestellte Function-URL, z. B. `https://europe-west3-DEIN_PROJEKT.cloudfunctions.net/meditestAi`
- API-Key: keiner in Meduvalo

Danach läuft die Fragegenerierung über Firebase. Der echte Gemini-Key liegt nicht mehr in Meduvalo.

## Lizenz und Zahlungen

Meduvalo integriert folgendes Lizenzmodell:

- einmaliger Basiskauf für 24,99 EUR
- 7 Tage vollständige Testphase ab bestätigtem Basiskauf
- danach optionales Monatsabo für 9,99 EUR
- ohne Abo sind ausschließlich Testdurchläufe aus vorhandenen Fragenpools verfügbar
- Katalogtests als separate Kaufartikel
- Premium-Freischaltung per administrativem Code ohne Kataloginhalte
- MedAT-Katalogtests für 49,99 EUR pro Test
- serverseitige Geräteaktivierung, Gerätebegrenzung und Sperrstatusprüfung
- versionierte AGB-/Datenschutz-Zustimmung und globale `appConfig`

Die geschützte Function `meditestLicenseAccess` legt Nutzer-, Lizenz-, Geräte- und Zustimmungsdaten ausschließlich mit dem verifizierten Firebase-Token an. Der Client kann diese sicherheitsrelevanten Dokumente nicht direkt schreiben.

Die geschützte Function `meditestCreateCheckout` verwendet für Basiskauf,
Monatsabo und jeden Katalogtest ausschließlich die dauerhaft gespeicherte
Stripe Price ID aus `commerceProducts`. Inline-Preise aus lokalen Namen oder
Beträgen werden nicht mehr erzeugt. Einmalkäufe aktivieren
`invoice_creation`, Abonnements verwenden die reguläre Stripe-Rechnung.
`meditestPricing` liefert die gespeicherten Produktpreise an Website und App.

`meditestValidateStripeProducts` gleicht alle lokalen Kaufprodukte mit Stripe
ab. Die Standardprüfung ist read-only. Ein ausdrücklich angeforderter
Reparaturlauf verwendet zuerst gespeicherte IDs, Metadata, Produktnamen und
passende vorhandene Preise. Nur wenn kein eindeutiges passendes Objekt
existiert, wird idempotent ein neues Stripe-Produkt beziehungsweise ein neuer
Stripe-Preis erstellt. Doppelte Treffer werden als Fehler gemeldet und nicht
automatisch aufgelöst.

`meditestStripeWebhook` prüft jedes Ereignis mit
`MEDITEST_STRIPE_WEBHOOK_SECRET`, beansprucht Webhook-Ereignisse atomar und
ordnet Käufe anhand der tatsächlichen Stripe Price ID zu. Kauf- und
Rechnungsdaten werden in `stripePurchases` und
`customers/{uid}/payments` gespeichert, einschließlich Checkout Session,
Payment Intent, Customer, Invoice-ID, Rechnungsnummer, PDF-/Hosted-URL und
Zahlungsstatus. `meditestDownloadAccess` liefert nach dem Basiskauf oder einer
administrativen Freischaltung den Installer. Die URLs werden über
`WINDOWS_DOWNLOAD_URL`, `MACOS_ARM64_DOWNLOAD_URL`, `MACOS_X64_DOWNLOAD_URL`
und `CURRENT_APP_VERSION` konfiguriert. `meditestStripePortal` verwendet
`STRIPE_PORTAL_CONFIGURATION_ID`.

Die Payments-Extension kann für diese Datenbank nicht verwendet werden, weil ihre Gen-1-Firestore-Trigger mit dem Firestore-Multiregionsstandort `eur3` nicht bereitgestellt werden können. Die direkten Functions liefern denselben Checkout-, Webhook- und Portalablauf ohne diese Standortbeschränkung.

Stripe-Extensions werden deshalb nicht mehr in `firebase.json` verwaltet. Bereits
installierte Legacy-Instanzen dürfen erst nach Prüfung ihrer Firestore-Daten und
Webhook-Konfiguration in der Firebase Console deinstalliert werden.

Die Firestore-Regeln erlauben Nutzern nur Lesezugriff auf Lizenz- und Stripe-Ausgabedaten. Premium-Code, Gratis-Code und Gratis-Katalogverbrauch laufen ebenfalls über geschützte Functions. Bei einer Kontolöschung werden private Firestore-Daten, Stripe-Kundendaten, KI-Nutzungsdaten und das Authentication-Konto entfernt.
