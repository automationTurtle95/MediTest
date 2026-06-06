# Installation

## Windows

Empfohlen ist das MSI-Paket aus dem Release-Ordner:

```text
dist/MediTest-4.0.6/windows/MediTest-Setup-4.0.6-win-x64.msi
```

Das MSI installiert MediTest benutzerbezogen nach:

```text
%LOCALAPPDATA%\Programs\MediTest
```

Es legt Verknüpfungen auf dem Desktop und im Startmenü an. Die Anwendung öffnet beim Start automatisch den Browser unter `http://127.0.0.1:55000`.

Updates funktionieren über dasselbe MSI: Eine neuere `MediTest-Setup-<Version>-win-x64.msi` einfach ausführen. Das Setup erkennt die bestehende benutzerbezogene Installation, ersetzt die Programmdateien und behält die Firestore-Nutzerdaten im Firebase-Konto bei. MediTest sollte vor dem Update geschlossen sein, damit Windows die laufende `.exe` ersetzen kann.

## macOS

Auf diesem Windows-Buildhost wird für macOS je Architektur ein Setup-ZIP erzeugt:

```text
dist/MediTest-4.0.6/macos/MediTest-4.0.6-macos-x64-setup.zip
dist/MediTest-4.0.6/macos/MediTest-4.0.6-macos-arm64-setup.zip
```

`macos-x64` ist für Intel-Macs, `macos-arm64` für Apple-Silicon-Macs. Beide ZIPs enthalten eine `MediTest.app` und ein Installer-Skript.

Installation:

1. Passendes ZIP entpacken.
2. `Install_MediTest_macOS.command` ausführen.
3. Falls macOS die Ausführung blockiert, im Terminal ausführen:

```bash
chmod +x Install_MediTest_macOS.command
./Install_MediTest_macOS.command
```

Das Skript installiert nach:

```text
~/Applications/MediTest.app
```

Zusätzlich wird auf dem Desktop ein `MediTest.app`-Link angelegt. Nach der Installation kann MediTest per Doppelklick gestartet werden; die App öffnet automatisch den Browser unter `http://127.0.0.1:55000`.

Version 4.0.6 legt keine lokale Nutzerdatenbank mehr an. Bestehende alte `meditest.db`-Dateien werden von V4 ignoriert.

Ein natives macOS-`.pkg` kann nur auf macOS mit Apples `pkgbuild` erzeugt werden. Das Release-Skript erkennt `pkgbuild` automatisch und erstellt `.pkg`-Dateien, wenn es auf macOS läuft. Diese installieren `MediTest.app` nach `/Applications`.

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

Windows-Updates laufen über das neue MSI. macOS-Updates laufen über das neue Setup-ZIP bzw. später über ein natives `.pkg`, wenn der Release-Build auf macOS mit `pkgbuild` erstellt wird.

## Erster Start und Anmeldung

Version 4.0.6 startet mit einer Anmeldeseite. Kontoerstellung, Anmeldung und Passwort-Reset laufen über Firebase Authentication. Angemeldete Nutzer können ihr Passwort in den Einstellungen ändern. Die Sitzung bleibt nur in der aktuellen Browser-Sitzung gespeichert. Nach erfolgreicher Anmeldung wird kurz eine Erfolgsanimation angezeigt. Wenn eine neuere Version verfügbar ist, erscheint nach dem Login ein Update-Popup mit dem passenden Download.

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
