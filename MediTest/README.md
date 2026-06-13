# Meduvalo

Meduvalo ist eine Lernsoftware für Medizinstudenten zur prüfungsnahen Vorbereitung mit strukturierten Fragen, Tests, Lernmodulen, Fortschrittsübersicht und KI-gestützter Fragengenerierung. Version 5.0.7 nutzt Firebase Authentication, Firestore und Stripe Checkout.

## Branding und Kompatibilität

Die sichtbare Produktmarke, Domain und Claims sind zentral in `Branding.cs`
definiert. Das statische Frontend spiegelt diese Werte in `wwwroot/js/api.js`
unter `APP_BRAND`.

Technische Bestandsnamen wie `MediTest.csproj`, C#-Namespaces,
`meditest-12354`, Function-Namen, Firestore-Pfade, lokale Cache-Schlüssel und
Release-Dateinamen bleiben aus Kompatibilitätsgründen erhalten. Sie sind keine
sichtbare Dachmarke und dürfen nicht ohne eigene Daten- und Update-Migration
umbenannt werden. Details stehen in [../BRANDING.md](../BRANDING.md).

## Funktionen

- Hochladen von PDF, PPTX und TXT
- Text-Extraktion aus den hochgeladenen Unterlagen
- Dokumentansicht für den gespeicherten Inhalt hochgeladener PDF-, PPTX- und TXT-Dateien
- KI-gestützte Generierung prüfungsnaher MC-Fragen
- Serverseitige KI-Kontingente mit Tages-/Monatslimit und Admin-Nutzungsübersicht
- KI-Startfenster mit Auftragsübersicht, persönlichem Restkontingent, Fortschritt und Ergebnislink
- Anbieterneutrale KI-Hinweise und dauerhaft sichtbare Fehlermeldung mit erneutem Start
- Manuelles Anlegen, Bearbeiten, Importieren und Exportieren von Fragen, inklusive optionalem Bild pro Frage
- Tests mit zufällig gemischten Fragen und Antwortoptionen
- Fortsetzen noch nicht abgegebener Tests
- PDF-Testprotokoll mit Profilkopf
- Auswertung mit Punktzahl, Bestehensgrenze, Erklärungen und Fehlerschwerpunkten
- Erweiterte Statistik mit Themenanalyse, Schwierigkeitsauswertung, Verlauf, Kreisdiagrammen und Lernempfehlungen
- Themensprung: Fragen eines Themas direkt öffnen und gezielt wiederholen
- Anmeldeseite mit E-Mail/Passwort, Google, Apple, E-Mail-Bestätigung, Passwort-Reset und browserbasierter Sitzung
- Vollständige Kontolöschung inklusive privater Firestore- und KI-Nutzungsdaten
- Firestore-Katalog als aufklappbares Fach- und Themenverzeichnis mit sichtbaren Preisen, Kaufübersicht und Admin-Veröffentlichung
- Katalogordner `MedAT` mit festem Einzelpreis von 49,99 EUR pro Test
- Stripe Checkout für Basiskauf, Monatsabo und Katalogtests, Stripe-Kundenportal sowie serverseitige Lizenz-Synchronisierung
- Lizenzmodell mit 24,99 EUR Einmalkauf, 7 Tagen Vollzugang und optional 9,99 EUR/Monat
- eingeschränkter Modus nach der Testphase: vorhandene Tests bleiben ausführbar
- Bereich `Rechtliches & Lizenz` mit zentralen Produktdaten, rechtlichen Links, Gerätebindung und Lizenzprüfung
- Versionierte AGB-/Datenschutz-Zustimmung in Firestore und begrenzter Offline-Modus mit verschlüsseltem Cache

## Technik

- .NET 8 / ASP.NET Core Minimal API
- Statisches HTML/CSS/JavaScript-Frontend in `wwwroot`
- Firebase Authentication mit Bearer-Token-Prüfung im ASP.NET-Core-Backend
- Firestore REST API für private Nutzerdaten und herunterladbare Katalogtests
- Browser-Sitzung via `sessionStorage`
- UglyToad.PdfPig für PDF-Extraktion
- Open XML SDK für PowerPoint-Extraktion
- WiX Toolset für das Windows-MSI
- Apple Developer ID, Hardened Runtime und Notarisierung für macOS-DMGs

## Lokal starten

Voraussetzung: .NET 8 SDK.

```powershell
cd MediTest
dotnet restore
dotnet run --configuration Release
```

macOS kann lokal analog per Doppelklick-Skript gestartet werden:

```bash
chmod +x Start_MediTest.command
./Start_MediTest.command
```

Alternativ unter Windows: `Start_MediTest.bat` doppelklicken. Die App läuft standardmäßig unter `http://127.0.0.1:55000` und leitet beim ersten Start auf die Anmeldeseite.

## Anmeldung mit Firebase

Seit V5.0.4 speichert Meduvalo keine Nutzerdaten mehr in einer lokalen `meditest.db`. Registrierung und Anmeldung laufen über Firebase Authentication wahlweise mit E-Mail/Passwort, Google oder Apple. Bei E-Mail/Passwort muss die Adresse nach der Registrierung bestätigt werden; Google- und Apple-Konten übernehmen den bestätigten Anmeldestatus des jeweiligen Anbieters. Passwort-Reset und Passwortänderung gelten nur für E-Mail/Passwort-Konten. Im Browser werden ID-Token und Refresh-Token nur in `sessionStorage` gehalten und verschwinden beim Schließen der Browser-Sitzung.

In Firebase müssen unter `Authentication -> Sign-in method` die verwendeten Anbieter aktiviert sein. Die Firebase-Web-Konfiguration steht in `appsettings.json`:

```json
{
  "Auth": {
    "Mode": "firebase",
    "RegistrationEnabled": true,
    "SessionPersistence": "session",
    "AdminEmails": [],
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

Unter `Authentication -> Settings -> Authorized domains` müssen mindestens `127.0.0.1` und `localhost` eingetragen sein, weil Meduvalo lokal unter `http://127.0.0.1:55000` läuft. Für Apple müssen zusätzlich die Apple-Developer-Konfiguration und die in Firebase verlangten Service-ID-/Schlüsselangaben vollständig hinterlegt sein.

Die Firebase-Web-API-Konfiguration ist im Frontend sichtbar und darf dort stehen. Sicherheitsregeln, echte Lizenzpläne und spätere Abo-Entscheidungen gehören in Firebase/Cloud-Funktionen bzw. einen späteren Server.

## Einstellungen und KI-Generierung

Die KI-Generierung läuft standardmäßig über die Firebase Function. Dabei wird kein KI-API-Key in Meduvalo gespeichert: Der Browser meldet sich per Firebase an, Meduvalo reicht das Firebase-ID-Token an die Cloud Function weiter, und die Function liest den echten `GEMINI_API_KEY` aus Firebase Secret Manager.

Die Firebase-Function-Vorlage liegt unter `../firebase`. Die App ist fest auf `firebase` mit `gemini-2.5-flash` und die hinterlegte Function-URL eingestellt.

Die Function begrenzt die KI-Nutzung standardmäßig auf 25 Fragen pro Generierung, 50 Fragen pro Nutzer und Tag, 500 Fragen pro Nutzer und Monat sowie 10 Anfragen pro Tag. Zwischen akzeptierten Anfragen liegen mindestens 30 Sekunden. Administratoren mit Firebase Custom Claim `admin=true` sehen Kontingente und die letzten Generierungsversuche unter `Katalog -> KI-Nutzung`. Skripttexte und Prompts werden dabei nicht protokolliert.

Die Seite `Einstellungen` speichert Profil und Programmeinstellungen unter `users/{uid}/settings/profile` in Firestore. Die bestätigte Konto-E-Mail wird schreibgeschützt angezeigt. Bei Google- und Apple-Konten wird die Passwortänderung ausgeblendet. Über `Konto löschen` werden Firebase Authentication, private Firestore-Daten und persönliche KI-Nutzungsdaten dauerhaft entfernt; bei Apple wird vorher das Apple-Zugriffstoken nach erneuter Anmeldung widerrufen.

## Firestore-Katalog und Admin-Konto

Die Seite `Katalog` liest themenspezifische Tests aus der Firestore-Collection `catalogTests` und zeigt vorhandene Legacy-Einträge aus `thematicTests` weiterhin an. Tests werden in einem aufklappbaren Verzeichnis nach Bereich und frei wählbarem Ordnerpfad dargestellt. Admins können beim Veröffentlichen Pfade wie `Innere Medizin/Kardiologie` vergeben. Ältere Einträge ohne `folderPath` werden automatisch aus Kategorie und Thema einsortiert. Der Ordner `MedAT` ist dauerhaft sichtbar; dort veröffentlichte Tests kosten jeweils 49,99 EUR. Vor einem Checkout öffnet sich eine Kaufübersicht mit Preis, Umfang, Thema und Schwierigkeit. Katalogtests bleiben unabhängig von Basiskauf, Testphase, Abo und Premium-Status separate Kaufartikel; Admin-Konten behalten ihren Verwaltungszugriff.

Meduvalo läuft installationsbezogen als Einzelinstanz. Unter Windows wird die Oberfläche in einem eigenen App-Fenster mit separatem Browserprofil geöffnet. `Programm schließen` beendet dieses Fenster, den lokalen Server und weitere Prozesse derselben Meduvalo-Installation.

## Lizenzmodell

Die Seite `Rechtliches & Lizenz` zeigt Produkt- und Entwicklerdaten, den Firebase-Nutzer, Lizenztyp, Lizenzstatus, Gerätebelegung, rechtliche Links, Basiskauf, Testphase, Abo-Status und Premium-Code-Eingabe. Standardwerte:

- 24,99 EUR einmalig für Installer und Basiskauf
- 7 Tage vollständige Testphase ab bestätigter Zahlung
- 9,99 EUR pro Monat für den optionalen Vollzugang danach
- ohne Abo können Tests aus vorhandenen Fragenpools gestartet, fortgesetzt und ausgewertet werden; alle anderen Funktionen sind gesperrt
- Premium- und Gratis-Code-Hashes liegen ausschließlich in den Firebase-Functions-Parametern
- Gratis-Katalog-Codes können von jedem Benutzerkonto genau einmal verwendet werden
- 2 Geräte pro neuem Basiskauf und 7 Tage Offline-Nutzung nach einer erfolgreichen Online-Prüfung
- jeder Download für ein noch freies Gerät erhält eine einmalige, 24 Stunden gültige Installationsberechtigung
- AGB- und Datenschutz-Version `5.0`; geänderte Versionen erfordern eine neue aktive Zustimmung

Die geschützte Function `meditestLicenseAccess` verwaltet `users`, `licenses`, `deviceActivations`, `termsAcceptances` und `appConfig`. Der Client verwendet ausschließlich die UID aus Firebase Authentication. Direkte Schreibzugriffe auf Lizenz-, Geräte- und Zustimmungsdaten sind in den Firestore-Regeln gesperrt. Lokale Lizenzdaten liegen nur als mit ASP.NET Data Protection verschlüsselter Cache vor.

Die geschützte Function `meditestCreateCheckout` erstellt getrennte Checkout-Sitzungen für Basiskauf, Abo und Katalog. Für MedAT wird der feste Preis aus dem Katalogeintrag verwendet; bestehende Katalogtests behalten das bisherige Fragenpreismodell. `meditestStripeWebhook` prüft die Stripe-Signatur, startet die Testphase nach dem Basiskauf und überträgt aktive Abos sowie erfolgreiche Katalogkäufe nach `users/{uid}/billing/license`. Nutzer dürfen diesen Lizenzpfad lesen, aber nicht direkt schreiben. `meditestStripePortal` ermöglicht die Verwaltung von Zahlungsmittel und Abo.

Der Gemini-Key gehört nicht in das Repository und nicht in die Meduvalo-Installation. Er wird als Firebase Secret `GEMINI_API_KEY` gespeichert. Ohne gültiges Secret funktioniert die App weiter, aber die KI-Fragengenerierung meldet einen Konfigurationsfehler.

## Release bauen

Voraussetzungen für Windows-MSI: .NET 8 SDK und WiX Toolset 5.

```powershell
cd MediTest
powershell -ExecutionPolicy Bypass -File .\scripts\build-release.ps1
```

Die fertigen Artefakte liegen danach unter `dist/MediTest-5.0.7/`. Frühere Release-Ordner bleiben erhalten.

Ohne `-WindowsOnly` können lokal weiterhin Test-ZIPs für Intel und Apple Silicon erzeugt werden. Der produktive Release-Workflow akzeptiert ab Version 5.0.4 ausschließlich signierte und von Apple notarisierte DMG-Disk-Images.

Die veröffentlichte Windows-EXE ist als GUI-Anwendung gebaut. Beim Start über MSI-Verknüpfung oder Portable-ZIP bleibt deshalb kein Konsolenfenster sichtbar.

Der GitHub-Workflow erzeugt aus den erfolgreich gebauten Windows- und macOS-Artefakten automatisch `latest.json` und `SHA256SUMS.txt`. Die App kann auf der Seite `Einstellungen` nach neuen Versionen suchen.

Fehlen Apple-Secrets oder lehnt Apple eine Notarisierung ab, wird kein produktiver Release veröffentlicht.

Weitere Details stehen in [docs/INSTALLATION.md](docs/INSTALLATION.md), [docs/MACOS_SIGNING.md](docs/MACOS_SIGNING.md), [docs/API.md](docs/API.md), [docs/RELEASE.md](docs/RELEASE.md), [docs/FIREBASE_COST_OPTIMIZATION.md](docs/FIREBASE_COST_OPTIMIZATION.md) und [docs/WEBSITE_DISTRIBUTION.md](docs/WEBSITE_DISTRIBUTION.md).
