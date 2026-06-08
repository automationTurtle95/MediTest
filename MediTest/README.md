# MediTest

MediTest ist eine lokale Web-App zum Erstellen und Trainieren von Multiple-Choice-Fragen aus medizinischen Unterlagen. Version 4.1.1 nutzt Firebase Authentication und speichert alle Nutzerdaten getrennt vom Katalog in Firestore.

## Funktionen

- Hochladen von PDF, PPTX und TXT
- Text-Extraktion aus den hochgeladenen Unterlagen
- KI-gestützte Generierung prüfungsnaher MC-Fragen
- Serverseitige KI-Kontingente mit Tages-/Monatslimit und Admin-Nutzungsübersicht
- KI-Startfenster mit Auftragsübersicht, persönlichem Restkontingent, Fortschritt und Ergebnislink
- Manuelles Anlegen, Bearbeiten, Importieren und Exportieren von Fragen, inklusive optionalem Bild pro Frage
- Tests mit zufällig gemischten Fragen und Antwortoptionen
- Fortsetzen noch nicht abgegebener Tests
- PDF-Testprotokoll mit Profilkopf
- Auswertung mit Punktzahl, Bestehensgrenze, Erklärungen und Fehlerschwerpunkten
- Erweiterte Statistik mit Themenanalyse, Schwierigkeitsauswertung, Verlauf, Kreisdiagrammen und Lernempfehlungen
- Themensprung: Fragen eines Themas direkt öffnen und gezielt wiederholen
- Anmeldeseite mit Firebase-Kontoerstellung, Passwort-Reset und browserbasierter Sitzung
- Firestore-Katalog für themenspezifische Tests mit Admin-Veröffentlichung
- Lizenzmodell vorbereitet: 7 Tage Testphase, 5,99 EUR/Monat, Katalogzugang, Gratis-Katalog-Code und Premium-Freischaltung per Code

## Technik

- .NET 8 / ASP.NET Core Minimal API
- Statisches HTML/CSS/JavaScript-Frontend in `wwwroot`
- Firebase Authentication mit Bearer-Token-Prüfung im ASP.NET-Core-Backend
- Firestore REST API für private Nutzerdaten und herunterladbare Katalogtests
- Browser-Sitzung via `sessionStorage`
- UglyToad.PdfPig für PDF-Extraktion
- Open XML SDK für PowerPoint-Extraktion
- WiX Toolset für das Windows-MSI
- Apple Developer ID, Hardened Runtime und Notarisierung für macOS-PKGs

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

V4.1.1 speichert keine Nutzerdaten mehr in einer lokalen `meditest.db`. Registrierung, Anmeldung, Passwort-Reset und Passwortänderung laufen über Firebase Authentication. Im Browser werden ID-Token und Refresh-Token nur in `sessionStorage` gehalten und verschwinden beim Schließen der Browser-Sitzung.

In Firebase muss unter `Authentication -> Sign-in method` der Anbieter `Email/Password` aktiviert sein. Die Firebase-Web-Konfiguration steht in `appsettings.json`:

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
      "ProjectId": "meditest-12354"
    }
  }
}
```

Die Firebase-Web-API-Konfiguration ist im Frontend sichtbar und darf dort stehen. Sicherheitsregeln, echte Lizenzpläne und spätere Abo-Entscheidungen gehören in Firebase/Cloud-Funktionen bzw. einen späteren Server.

## Einstellungen und KI-Generierung

Die KI-Generierung läuft standardmäßig über die Firebase Function. Dabei wird kein KI-API-Key in MediTest gespeichert: Der Browser meldet sich per Firebase an, MediTest reicht das Firebase-ID-Token an die Cloud Function weiter, und die Function liest den echten `GEMINI_API_KEY` aus Firebase Secret Manager.

Die Firebase-Function-Vorlage liegt unter `../firebase`. Die App ist fest auf `firebase` mit `gemini-2.5-flash` und die hinterlegte Function-URL eingestellt.

Die Function begrenzt die KI-Nutzung standardmäßig auf 25 Fragen pro Generierung, 50 Fragen pro Nutzer und Tag, 500 Fragen pro Nutzer und Monat sowie 10 Anfragen pro Tag. Zwischen akzeptierten Anfragen liegen mindestens 30 Sekunden. Administratoren mit Firebase Custom Claim `admin=true` sehen Kontingente und die letzten Generierungsversuche unter `Katalog -> KI-Nutzung`. Skripttexte und Prompts werden dabei nicht protokolliert.

Die Seite `Einstellungen` speichert Profil und Programmeinstellungen unter `users/{uid}/settings/profile` in Firestore. Profilfelder bleiben beim ersten Start leer und werden nicht automatisch aus Firebase übernommen.

## Firestore-Katalog und Admin-Konto

Die Seite `Katalog` liest themenspezifische Tests aus der Firestore-Collection `catalogTests` und zeigt vorhandene Legacy-Einträge aus `thematicTests` weiterhin an. Angemeldete Nutzer sehen verfügbare Tests, dürfen sie aber erst nach Freischaltung herunterladen; Premium- und Admin-Konten haben Zugriff auf alle Katalogtests. Heruntergeladene Tests werden als private Nutzerdaten unter `users/{uid}/documents` gespeichert. Optional kann `Auth:AdminEmails` als lokaler UI-Fallback gesetzt werden, die eigentliche Schreibberechtigung sollte über Firestore-Regeln abgesichert bleiben.

## Lizenzmodell

Die Seite `Lizenz` zeigt Testphase, Abo-Status, Katalogzugang und Premium-Code-Eingabe. Standardwerte:

- 7 Tage Testphase pro Firebase-Nutzer ab erster erfolgreicher Anmeldung
- 5,99 EUR pro Monat für das MediTest-Abo
- Premium-Codes werden serverseitig über `Billing:PremiumCodeHashes` konfiguriert und schalten alle Katalogtests frei
- Gratis-Katalog-Codes werden über `Billing:FreeCatalogCodeHashes` konfiguriert und schalten genau einen Katalogtest pro Konto frei

Die App enthält Checkout-Endpunkte und Konfiguration (`Billing:*`), aber keine echten Zahlungsdaten. Für produktiven Verkauf sollte ein Zahlungsanbieter wie Stripe Checkout genutzt werden; Webhooks müssen danach den Abo-Status bzw. gekaufte Katalogtest-IDs serverseitig in Firestore oder als Firebase Custom Claims setzen. Eingelöste Premium- und Gratis-Katalog-Codes werden im Firebase-Nutzerkonto unter `billing/license` gespeichert.

Der Gemini-Key gehört nicht in das Repository und nicht in die MediTest-Installation. Er wird als Firebase Secret `GEMINI_API_KEY` gespeichert. Ohne gültiges Secret funktioniert die App weiter, aber die KI-Fragengenerierung meldet einen Konfigurationsfehler.

## Release bauen

Voraussetzungen für Windows-MSI: .NET 8 SDK und WiX Toolset 5.

```powershell
cd MediTest
powershell -ExecutionPolicy Bypass -File .\scripts\build-release.ps1
```

Die fertigen Artefakte liegen danach unter `dist/MediTest-4.1.1/`. Bestehende Releases wie `dist/MediTest-2.0.0/`, `dist/MediTest-3.0.0/`, `dist/MediTest-3.1.1/`, `dist/MediTest-3.1.2/`, `dist/MediTest-3.1.3/`, `dist/MediTest-4.0.0/`, `dist/MediTest-4.0.3/`, `dist/MediTest-4.0.4/`, `dist/MediTest-4.0.5/`, `dist/MediTest-4.0.6/`, `dist/MediTest-4.0.7/`, `dist/MediTest-4.0.8/`, `dist/MediTest-4.0.9/` und `dist/MediTest-4.1.0/` bleiben erhalten.

Ohne `-WindowsOnly` entstehen zusätzlich vorläufige, unsignierte macOS-Setup-ZIPs für Intel und Apple Silicon. Sind die Apple-Secrets in GitHub eingerichtet, ersetzt der Release-Workflow diese automatisch durch signierte und notarisierte PKG-Installer.

Die veröffentlichte Windows-EXE ist als GUI-Anwendung gebaut. Beim Start über MSI-Verknüpfung oder Portable-ZIP bleibt deshalb kein Konsolenfenster sichtbar.

Der GitHub-Workflow erzeugt aus den erfolgreich gebauten Windows- und macOS-Artefakten automatisch `latest.json` und `SHA256SUMS.txt`. Die App kann auf der Seite `Einstellungen` nach neuen Versionen suchen.

Solange die Apple-Secrets fehlen, kennzeichnet der Release die macOS-ZIPs ausdrücklich als nicht signiert und nicht notarisiert.

Weitere Details stehen in [docs/INSTALLATION.md](docs/INSTALLATION.md), [docs/MACOS_SIGNING.md](docs/MACOS_SIGNING.md), [docs/API.md](docs/API.md), [docs/RELEASE.md](docs/RELEASE.md) und [docs/WEBSITE_DISTRIBUTION.md](docs/WEBSITE_DISTRIBUTION.md).
