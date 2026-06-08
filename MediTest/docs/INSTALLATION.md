# Installation

## Windows

Empfohlen ist das MSI-Paket aus dem Release-Ordner:

```text
dist/MediTest-4.1.1/windows/MediTest-Setup-4.1.1-win-x64.msi
```

Das MSI installiert MediTest benutzerbezogen nach:

```text
%LOCALAPPDATA%\Programs\MediTest
```

Es legt Verknüpfungen auf dem Desktop und im Startmenü an. Die Anwendung läuft im Hintergrund ohne sichtbares Konsolenfenster und öffnet beim Start automatisch den Browser unter `http://127.0.0.1:55000`.

Updates funktionieren über dasselbe MSI: Eine neuere `MediTest-Setup-<Version>-win-x64.msi` einfach ausführen. Das Setup erkennt die bestehende benutzerbezogene Installation, ersetzt die Programmdateien und behält die Firestore-Nutzerdaten im Firebase-Konto bei. MediTest sollte vor dem Update geschlossen sein, damit Windows die laufende `.exe` ersetzen kann.

## macOS

Solange die Apple-Signing-Secrets noch nicht eingerichtet sind, werden zwei unsignierte Setup-ZIPs veröffentlicht:

```text
MediTest-4.1.1-macos-x64-setup.zip
MediTest-4.1.1-macos-arm64-setup.zip
```

`macos-x64` ist für Intel-Macs, `macos-arm64` für Apple-Silicon-Macs.

Installation:

1. Passendes ZIP herunterladen und entpacken.
2. `Install_MediTest_macOS.command` ausführen.
3. Die Sicherheitsabfrage von macOS für die nicht signierte App bestätigen.
4. MediTest anschließend aus `~/Applications` oder über die Desktop-Verknüpfung starten.

Die App öffnet automatisch den Browser unter `http://127.0.0.1:55000`.

Sobald die Apple-Secrets eingerichtet sind, veröffentlicht derselbe Workflow stattdessen native, signierte und notarisierte PKGs. Diese lassen sich ohne den vorläufigen ZIP-Installationsweg über den normalen macOS-Installer installieren.

Version 4.1.1 legt keine lokale Nutzerdatenbank mehr an. Bestehende alte `meditest.db`-Dateien werden von V4 ignoriert.

Die Einrichtung der benötigten Apple-Zertifikate und GitHub-Secrets steht in [MACOS_SIGNING.md](MACOS_SIGNING.md).

## Updates

Wenn Updates in `appsettings.json` aktiviert sind, prüft MediTest auf der Seite `Einstellungen` GitHub auf neue Releases. Bei einer neueren Version zeigt die App den passenden Download für Windows oder macOS an.

```json
{
  "Updates": {
    "Enabled": true,
    "GitHubRepository": "automationTurtle95/MediTest",
    "ManifestUrl": ""
  }
}
```

Windows-Updates laufen über das neue MSI. macOS-Updates laufen vorerst über das neue Setup-ZIP und später automatisch über das signierte und notarisierte PKG.

## Erster Start und Anmeldung

Version 4.1.1 startet mit einer Anmeldeseite. Kontoerstellung, Anmeldung und Passwort-Reset laufen über Firebase Authentication. Angemeldete Nutzer können ihr Passwort in den Einstellungen ändern. Die Sitzung bleibt nur in der aktuellen Browser-Sitzung gespeichert. Nach erfolgreicher Anmeldung wird kurz eine Erfolgsanimation angezeigt. Wenn eine neuere Version verfügbar ist, erscheint nach dem Login ein Update-Popup mit dem passenden Download.

Vor dem ersten produktiven Test muss in Firebase unter `Authentication -> Sign-in method` der Anbieter `Email/Password` aktiviert sein. Die App erwartet folgende Auth-Konfiguration:

```json
{
  "Auth": {
    "Mode": "firebase",
    "RegistrationEnabled": true,
    "SessionPersistence": "session",
    "Firebase": {
      "ApiKey": "...",
      "AuthDomain": "meditest-12354.firebaseapp.com",
      "ProjectId": "meditest-12354"
    }
  }
}
```

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

Danach in MediTest abmelden und wieder anmelden, damit das neue Token den Admin-Claim enthält.

## Einstellungen und KI-Generierung

Die KI-Generierung läuft über die Firebase Function. Dabei bleibt der echte KI-API-Key in Firebase Secret Manager und wird nicht in MediTest gespeichert. Die Firebase-Function-Vorlage liegt im Repository unter `firebase`.

Der Gemini-Key wird einmalig als Firebase Secret `GEMINI_API_KEY` gesetzt. In MediTest selbst gibt es keine API-Key-Eingabe mehr; die App nutzt fest Firebase mit Gemini.

Die Firebase Function erzwingt standardmäßig folgende Kontingente pro Nutzer:

- maximal 25 Fragen pro Generierung
- maximal 50 angeforderte Fragen pro UTC-Tag
- maximal 500 angeforderte Fragen pro UTC-Monat
- maximal 10 Generierungsanfragen pro UTC-Tag
- 30 Sekunden Mindestabstand zwischen akzeptierten Anfragen
- maximal 50.000 Prompt-Zeichen pro Anfrage

Die Werte werden als parametrisierte Firebase-Konfiguration mit den Namen `AI_MAX_QUESTIONS_PER_REQUEST`, `AI_DAILY_QUESTION_LIMIT`, `AI_MONTHLY_QUESTION_LIMIT`, `AI_DAILY_REQUEST_LIMIT`, `AI_COOLDOWN_SECONDS` und `AI_MAX_PROMPT_CHARS` verwaltet. Details zur Anpassung und zum Nutzungsprotokoll stehen in `firebase/README.md`. Admins mit Custom Claim `admin=true` sehen die Auswertung im Katalog unter `KI-Nutzung`.

Vor dem eigentlichen Start zeigt MediTest beim Klick auf `Generieren` ein KI-Startfenster mit Fragenpool, geplanter Fragenanzahl, persönlichem Restkontingent, Ablaufhinweisen und Fortschritt. Erst der Button `KI-Generierung starten` ruft die Cloud Function auf.

Die Einstellungsseite speichert Profilangaben und Darstellung.

## Datenhaltung

MediTest speichert private Lern- und Testdaten in Firestore unter dem jeweiligen Firebase-Benutzer:

```text
users/{uid}/settings/profile
users/{uid}/documents/{documentId}
users/{uid}/documents/{documentId}/questions/{questionId}
users/{uid}/documents/{documentId}/textChunks/{chunkId}
users/{uid}/testSessions/{testSessionId}
```

Der Katalog ist getrennt davon in `catalogTests` gespeichert. Firestore-Regeln erlauben private Nutzerzugriffe nur auf `users/{eigene uid}/...`; Katalog-Schreibzugriffe bleiben Admin-Konten vorbehalten. Beim ersten Aufruf der Dokumentübersicht wird pro Benutzer ein leerer Standardstand mit `Beispiel-Test Medizin` angelegt.

## Lizenzmodell

Die Standardkonfiguration ist in `appsettings.json` unter `Billing` hinterlegt:

```json
{
  "Billing": {
    "Currency": "EUR",
    "TrialDays": 7,
    "MonthlyPriceCents": 599,
    "CatalogQuestionPriceCents": 10,
    "CatalogPriceEndingCents": 9,
    "CatalogPriceExampleQuestionCount": 25,
    "PremiumCodeHashes": [],
    "FreeCatalogCodeHashes": [],
    "EnforceCatalogPurchases": true,
    "SubscriptionCheckoutUrl": "",
    "CatalogCheckoutUrl": ""
  }
}
```

Die Testphase startet bei der ersten erfolgreichen Anmeldung des Firebase-Nutzers. Premium-Codes werden als SHA-256-Hashes unter `Billing:PremiumCodeHashes` hinterlegt; ein eingelöster Code speichert `premiumActive=true` im Firebase-Nutzerkonto und schaltet alle Katalogtests frei. Gratis-Katalog-Codes werden als SHA-256-Hashes unter `Billing:FreeCatalogCodeHashes` hinterlegt und schalten den ersten gesperrten Katalogtest frei, den der Nutzer danach herunterlädt. Solange keine Checkout-URLs hinterlegt sind, zeigt MediTest das Lizenzmodell und bereitet Käufe vor, führt aber keine echten Zahlungen aus. Für produktiven Verkauf muss ein Zahlungsanbieter mit Webhook angebunden werden, der Abo-Status und Katalogkäufe in Firestore/Firebase aktualisiert.
