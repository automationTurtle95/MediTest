# Installation

Der sichtbare Produktname lautet Meduvalo. Bestehende technische Paket-,
Installations- und Programmdateinamen mit `MediTest` bleiben erhalten, damit
Updates vorhandener Installationen weiterhin funktionieren.

## Windows

Empfohlen ist das MSI-Paket aus dem Release-Ordner:

```text
dist/MediTest-5.0.4/windows/MediTest-Setup-5.0.4-win-x64.msi
```

Das MSI installiert Meduvalo benutzerbezogen nach:

```text
%LOCALAPPDATA%\Programs\MediTest
```

Es legt Verknüpfungen auf dem Desktop und im Startmenü an. Die Anwendung läuft im Hintergrund ohne sichtbares Konsolenfenster und öffnet beim Start automatisch den Browser unter `http://127.0.0.1:55000`.

Updates funktionieren über dasselbe MSI: Eine neuere `MediTest-Setup-<Version>-win-x64.msi` einfach ausführen. Das Setup erkennt die bestehende benutzerbezogene Installation, ersetzt die Programmdateien und behält die Firestore-Nutzerdaten im Firebase-Konto bei. Meduvalo sollte vor dem Update geschlossen sein, damit Windows die laufende `.exe` ersetzen kann.

## macOS

Für den produktiven Release werden zwei signierte und von Apple notarisierte PKGs veröffentlicht:

```text
MediTest-Setup-5.0.4-macos-x64.pkg
MediTest-Setup-5.0.4-macos-arm64.pkg
```

`macos-x64` ist für Intel-Macs, `macos-arm64` für Apple-Silicon-Macs.

Installation:

1. Passendes ZIP herunterladen und entpacken.
2. Das heruntergeladene `.pkg` öffnen.
3. Den normalen macOS-Installer abschließen.
4. Meduvalo anschließend aus `~/Applications` oder über die Desktop-Verknüpfung starten.

Die App öffnet automatisch den Browser unter `http://127.0.0.1:55000`.

Der Release-Workflow veröffentlicht ab Version 5.0.4 nur noch, wenn beide PKGs erfolgreich signiert, von Apple notarisiert und mit einem Notarisierungsticket versehen wurden.

Version 5.0.4 legt keine lokale Nutzerdatenbank mehr an. Bestehende alte `meditest.db`-Dateien werden ignoriert.

Die Einrichtung der benötigten Apple-Zertifikate und GitHub-Secrets steht in [MACOS_SIGNING.md](MACOS_SIGNING.md).

## Updates

Wenn Updates in `appsettings.json` aktiviert sind, prüft Meduvalo auf der Seite `Einstellungen` GitHub auf neue Releases. Bei einer neueren Version zeigt die App den passenden Download für Windows oder macOS an.

```json
{
  "Updates": {
    "Enabled": true,
    "GitHubRepository": "automationTurtle95/MediTest",
    "ManifestUrl": ""
  }
}
```

Windows-Updates laufen über das neue MSI. macOS-Updates laufen über das signierte und notarisierte PKG.

## Erster Start und Anmeldung

Version 5.0.4 startet mit einer Anmeldeseite. Die Anmeldung ist über E-Mail/Passwort, Google oder Apple möglich. Nach einer Kontoerstellung mit E-Mail/Passwort sendet Firebase eine Bestätigungs-E-Mail; erst nach Bestätigung der Adresse ist diese Anmeldemethode nutzbar. Passwort-Reset und Passwortänderung gelten nur für E-Mail/Passwort-Konten. Die Sitzung bleibt nur in der aktuellen Browser-Sitzung gespeichert.

Unter Windows öffnet Meduvalo ein eigenes App-Fenster mit separatem Browserprofil. Pro Installation läuft nur eine Instanz. Der Befehl `Programm schließen` beendet App-Fenster, lokalen Server und weitere Prozesse derselben Installation.

Vor dem ersten produktiven Test müssen in Firebase unter `Authentication -> Sign-in method` die gewünschten Anbieter aktiviert sein. Die App erwartet folgende Auth-Konfiguration:

```json
{
  "Auth": {
    "Mode": "firebase",
    "RegistrationEnabled": true,
    "SessionPersistence": "session",
    "Firebase": {
      "ApiKey": "...",
      "AuthDomain": "meditest-12354.firebaseapp.com",
      "ProjectId": "meditest-12354",
      "GoogleEnabled": true,
      "AppleEnabled": true
    }
  }
}
```

Trage in Firebase unter `Authentication -> Settings -> Authorized domains` mindestens `127.0.0.1` und `localhost` ein. Ohne `127.0.0.1` verweigert Firebase das Provider-Popup der lokal unter `http://127.0.0.1:55000` laufenden App. Für Apple müssen außerdem Apple Developer Program, Service ID, Team ID, Key ID und privater Schlüssel entsprechend der Firebase-Anleitung konfiguriert sein.

Die lokale App speichert keine Passwörter, Passwort-Hashes, Anmeldesitzungen, Profilangaben, Dokumente, Fragen oder Tests in `meditest.db`. Passwort-Reset-Mails werden über Firebase Authentication versendet; die Passwortänderung für angemeldete Nutzer läuft ebenfalls über Firebase.

## Firestore-Katalog und Admin

Für herunterladbare themenspezifische Tests muss Firestore aktiviert und `firebase/firestore.rules` bereitgestellt sein:

```powershell
cd firebase
npx firebase-tools deploy --only firestore:rules
```

Ein Admin-Konto wird in Firebase Authentication angelegt und danach mit dem Custom Claim `admin=true` markiert. Das Skript nutzt das Firebase Admin SDK; lokal braucht es Application Default Credentials, z. B. über `gcloud auth application-default login` oder `GOOGLE_APPLICATION_CREDENTIALS` mit einem Service-Account. Beispiel aus dem Ordner `firebase/functions`:

```powershell
npm run admin:set -- admin@example.com
```

Danach in Meduvalo abmelden und wieder anmelden, damit das neue Token den Admin-Claim enthält.

## Einstellungen und KI-Generierung

Die KI-Generierung läuft über die Firebase Function. Dabei bleibt der echte KI-API-Key in Firebase Secret Manager und wird nicht in Meduvalo gespeichert. Die Firebase-Function-Vorlage liegt im Repository unter `firebase`.

Der Gemini-Key wird einmalig als Firebase Secret `GEMINI_API_KEY` gesetzt. In Meduvalo selbst gibt es keine API-Key-Eingabe mehr; die App nutzt fest Firebase mit Gemini.

Die Firebase Function erzwingt standardmäßig folgende Kontingente pro Nutzer:

- maximal 25 Fragen pro Generierung
- maximal 50 angeforderte Fragen pro UTC-Tag
- maximal 500 angeforderte Fragen pro UTC-Monat
- maximal 10 Generierungsanfragen pro UTC-Tag
- 30 Sekunden Mindestabstand zwischen akzeptierten Anfragen
- maximal 50.000 Prompt-Zeichen pro Anfrage

Die Werte werden als parametrisierte Firebase-Konfiguration mit den Namen `AI_MAX_QUESTIONS_PER_REQUEST`, `AI_DAILY_QUESTION_LIMIT`, `AI_MONTHLY_QUESTION_LIMIT`, `AI_DAILY_REQUEST_LIMIT`, `AI_COOLDOWN_SECONDS` und `AI_MAX_PROMPT_CHARS` verwaltet. Details zur Anpassung und zum Nutzungsprotokoll stehen in `firebase/README.md`. Admins mit Custom Claim `admin=true` sehen die Auswertung im Katalog unter `KI-Nutzung`.

Vor dem eigentlichen Start zeigt Meduvalo beim Klick auf `Generieren` ein KI-Startfenster mit Fragenpool, geplanter Fragenanzahl, persönlichem Restkontingent, Ablaufhinweisen und Fortschritt. Erst der Button `KI-Generierung starten` ruft die Cloud Function auf.

Hochgeladene PDF-, PPTX- und TXT-Dateien erhalten in der Dokumentübersicht die Aktion `Dokument ansehen`. Die Vorschau zeigt den für die Verarbeitung gespeicherten Inhalt. Bei PDF und PowerPoint wird der extrahierte Text nach Seiten beziehungsweise Folien gegliedert; das ursprüngliche Layout wird nicht dauerhaft gespeichert.

Die Einstellungsseite speichert Profilangaben und Darstellung. Die bestätigte Konto-E-Mail ist nicht als Profilwert änderbar. Bei Google- und Apple-Konten wird keine lokale Passwortänderung angeboten. Der Bereich `Konto löschen` entfernt nach doppelter Bestätigung das Authentication-Konto und alle zugehörigen privaten Daten. Bei Apple verlangt Meduvalo vorher eine erneute Apple-Anmeldung und widerruft das erhaltene Zugriffstoken.

## Datenhaltung

Meduvalo speichert private Lern- und Testdaten in Firestore unter dem jeweiligen Firebase-Benutzer:

```text
users/{uid}/settings/profile
users/{uid}/documents/{documentId}
users/{uid}/documents/{documentId}/questions/{questionId}
users/{uid}/documents/{documentId}/textChunks/{chunkId}
users/{uid}/testSessions/{testSessionId}
```

Der Katalog ist getrennt davon in `catalogTests` gespeichert. Das Feld `folderPath` strukturiert Tests in Fach- und Themenordnern; ältere Einträge werden automatisch aus Kategorie und Thema einsortiert. Firestore-Regeln erlauben private Nutzerzugriffe nur auf `users/{eigene uid}/...`; Katalog-Schreibzugriffe bleiben Admin-Konten vorbehalten.

## Lizenzmodell

Die Standardkonfiguration ist in `appsettings.json` unter `Billing` hinterlegt:

```json
{
  "Billing": {
    "Currency": "EUR",
    "TrialDays": 7,
    "ProductPriceCents": 1499,
    "MonthlyPriceCents": 599,
    "CatalogQuestionPriceCents": 10,
    "CatalogPriceEndingCents": 9,
    "CatalogPriceExampleQuestionCount": 25,
    "EnforceCatalogPurchases": true,
    "StripeEnabled": true
  }
}
```

Die Testphase beginnt erst mit dem serverseitig bestätigten Basiskauf. Nach sieben Tagen wechselt das Konto ohne aktives Abo in den eingeschränkten Modus: vorhandene Tests, Ergebnisse und gekaufte Katalogtests bleiben nutzbar; neue Inhalte, Bearbeitung und KI-Funktionen sind gesperrt. Premium- und Gratis-Code-Hashes liegen in `firebase/functions/.env.<project-id>` und werden nicht mit Meduvalo ausgeliefert. Jedes Benutzerkonto kann die Gratis-Katalogfreischaltung genau einmal aktivieren.

Die Stripe-Integration verwendet folgende serverseitige Struktur:

1. `meditestCreateCheckout` erstellt die Stripe-Checkout-Sitzung und akzeptiert keine Preise vom Client.
2. `meditestStripeWebhook` prüft die Stripe-Signatur und aktualisiert den geschützten Lizenzstatus.
3. `meditestStripePortal` stellt die Abo- und Zahlungsmittelverwaltung bereit.
4. Firestore-Regeln blockieren direkte Nutzer-Schreibzugriffe auf Lizenz- und Stripe-Daten.
5. Das Stripe-Kundenportal verwaltet Zahlungsmittel und Abos.

Vor dem Checkout müssen in `firebase/functions/.env.<project-id>` der einmalige Kaufpreis `BILLING_PRODUCT_PRICE_CENTS`, der Monatspreis `BILLING_MONTHLY_PRICE_CENTS`, die Katalogparameter `STRIPE_CATALOG_UNIT_PRICE_ID` und `STRIPE_CATALOG_ENDING_PRICE_ID` sowie `STRIPE_PORTAL_CONFIGURATION_ID` gesetzt und die Functions erneut bereitgestellt werden. API-Key und Webhook-Signing-Secret liegen ausschließlich als `MEDITEST_STRIPE_API_KEY` und `MEDITEST_STRIPE_WEBHOOK_SECRET` im Secret Manager.
