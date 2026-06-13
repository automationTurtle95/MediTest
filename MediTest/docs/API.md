# API

Meduvalo stellt eine lokale HTTP-API bereit. Standardadresse:

```text
http://127.0.0.1:55000
```

Alle Endpunkte liefern JSON, außer der TXT-Export und der PDF-Download. Die App-Endpunkte sind mit Firebase Authentication geschützt und verlangen eine bestätigte E-Mail-Adresse. Private Nutzerdaten werden in Firestore unter `users/{uid}/...` gespeichert. Der Browser sendet `Authorization: Bearer <firebase-id-token>` an die lokale API.

## Anmeldung

`GET /api/auth/config`

Liefert die Firebase-Konfiguration für das Frontend.

```json
{
  "mode": "firebase",
  "cloudConfigured": true,
  "registrationEnabled": true,
  "sessionPersistence": "session",
  "firebase": {
    "apiKey": "...",
    "authDomain": "meditest-12354.firebaseapp.com",
    "projectId": "meditest-12354",
    "googleEnabled": true,
    "appleEnabled": true
  }
}
```

`POST /api/auth/register`

Nicht mehr für produktive Anmeldung vorgesehen. Registrierung läuft im Frontend über Firebase `accounts:signUp`.

`POST /api/auth/login`

Nicht mehr für produktive Anmeldung vorgesehen. Die E-Mail-/Passwort-Anmeldung läuft im Frontend über Firebase `accounts:signInWithPassword`. Google und Apple werden über das modulare Firebase Web SDK und `signInWithPopup` angemeldet.

`GET /api/auth/me`

Validiert den Firebase-ID-Token und liefert den aktuellen Benutzer.

`POST /api/auth/logout`

Bestätigt die Abmeldung für das Frontend. Das lokale Token wird clientseitig aus `sessionStorage` entfernt.

E-Mail-Bestätigung, Passwort-Reset und Passwortänderung laufen für E-Mail-/Passwort-Konten direkt im Browser über Firebase Authentication. Google- und Apple-Konten verwalten ihre Anmeldesicherheit beim jeweiligen Anbieter. Die lokale Meduvalo-API speichert keine Passwörter und kennt keine Passwort-Hashes.

`DELETE /api/account`

Ruft die geschützte Function `meditestDeleteAccount` auf. Sie entfernt das Firebase-Authentication-Konto, alle Dokumente unter `users/{uid}`, persönliche KI-Nutzungsstände und KI-Ereignisse. Bei Apple-Konten widerruft das Frontend zuvor nach erneuter Apple-Anmeldung das Apple-Zugriffstoken.

## Support

`POST /api/support`

Übermittelt eine authentifizierte Supportanfrage an die Firebase Function
`meditestSupportRequest`. Das Ticket wird dauerhaft gespeichert und bei
konfiguriertem IONOS-SMTP-Versand an `support@meduvalo.at` gesendet. Der Endpunkt
bleibt auch nach Ablauf der Testphase erreichbar.

```json
{
  "category": "technical",
  "subject": "Fehler beim Öffnen eines Tests",
  "message": "Beim Öffnen erscheint wiederholt eine Fehlermeldung.",
  "includeDiagnostics": true,
  "currentPage": "http://127.0.0.1:55000/pages/tests.html",
  "userAgent": "..."
}
```

## Dokumente

`POST /api/documents/upload`

Lädt eine Datei hoch und extrahiert Text. Erlaubt sind `.pdf`, `.pptx` und `.txt`.

`GET /api/documents`

Gibt alle gespeicherten Dokumente bzw. Fragenpools zurück.

`GET /api/documents/{id}/preview`

Liefert Dateiname, Dateityp und den gespeicherten Dokumentinhalt für die Vorschau. Bei PDF- und PPTX-Dateien wird der extrahierte Text angezeigt; das ursprüngliche Seitenlayout kann vereinfacht sein.

`GET /api/documents/{id}/questions`

Gibt alle Fragen eines Dokuments inklusive Antwortoptionen und richtiger Antwort zurück.

`DELETE /api/documents/{id}`

Löscht ein Dokument inklusive Fragen und zugehöriger Tests.

`POST /api/documents/{id}/generate-questions`

Generiert neue Fragen aus dem extrahierten Dokumenttext. Die lokale API begrenzt eine Generierung standardmäßig auf 25 Fragen; die Firebase Function erzwingt zusätzlich Tages-, Monats- und Anfragekontingente pro Nutzer. In der Oberfläche wird vorher ein KI-Startfenster mit Auftrag, persönlichem Kontingent und Startbutton angezeigt.

Beispiel:

```json
{
  "count": 25
}
```

`GET /api/documents/{id}/export-txt`

Exportiert den Fragenpool als TXT-Datei.

`POST /api/documents/import-txt`

Importiert einen Fragenpool aus einer TXT-Datei.

## KI-Nutzungsübersicht

`GET /api/ai/status`

Liefert das persönliche KI-Restkontingent des angemeldeten Nutzers für das Startfenster der KI-Generierung. Der Endpunkt leitet die Anfrage an die geschützte Firebase Function `meditestAiStatus` weiter.

`GET /api/admin/ai-usage`

Liefert die konfigurierten KI-Kontingente, kumulierte Nutzerstände und die letzten Generierungsversuche. Der Endpunkt leitet die Anfrage an die geschützte Firebase Function `meditestAiUsage` weiter und erfordert den Firebase Custom Claim `admin=true`. Skripttexte und Prompts sind nicht Teil der Antwort.

## Firestore-Katalog

`GET /api/catalog/tests`

Listet themenspezifische Tests aus der Firestore-Collection `catalogTests`. Für vorhandene V3-Katalogdaten wird zusätzlich der Legacy-Pfad `thematicTests` gelesen. Jeder Eintrag enthält `folderPath` für ein hierarchisches Verzeichnis, zum Beispiel `Allgemein/Innere Medizin/Kardiologie`. Fehlt das Feld bei älteren Einträgen, wird der Pfad aus Kategorie und Thema gebildet. Die Antwort enthält außerdem `canPublish` und `freeCatalogCreditAvailable`.

`POST /api/catalog/tests/{catalogId}/download`

Lädt einen Firestore-Test herunter und legt ihn als privaten Fragenpool unter `users/{uid}/documents` an. Normale Nutzer brauchen dafür einen gekauften Katalogtest oder einen aktiven Gratis-Katalog-Code; Admin-Konten dürfen ohne Kauf herunterladen.

Beispiel:

```json
{
  "documentName": "Kardiologie Grundlagen"
}
```

`POST /api/catalog/tests/{catalogId}/checkout`

Erstellt über `meditestCreateCheckout` eine Stripe-Checkout-Sitzung mit serverseitig festgelegten Preis-IDs. Die Oberfläche zeigt vorher Preis, Fragenanzahl, Thema und Schwierigkeit.

`POST /api/catalog/tests/publish`

Veröffentlicht einen privaten Fragenpool im Firestore-Katalog. `folderPath` kann Unterordner mit `/` trennen; der Bereich `Allgemein` oder `MedAT` wird serverseitig als Wurzel ergänzt. Erlaubt ist das nur für Admin-Konten mit Firebase Custom Claim `admin=true`; Firestore-Regeln müssen Schreibzugriffe entsprechend begrenzen.

Beispiel:

```json
{
  "documentId": 1,
  "title": "Kardiologie Grundlagen",
  "description": "Basisfragen für den Einstieg",
  "topic": "Kardiologie",
  "difficulty": "mittel"
}
```

## Fragen

`POST /api/questions/manual`

Legt eine neue Frage manuell an. Bei fehlender `documentId` wird ein neuer Fragenpool erstellt. Optional kann `imageDataUrl` mit einem PNG/JPEG/WebP/GIF bis 600 KB gesetzt werden.

`PUT /api/questions/{id}`

Aktualisiert eine vorhandene Frage. Optional können `imageDataUrl`, `imageAltText`, `imageFileName` oder `clearImage` gesetzt werden.

## Lizenz

`GET /api/legal-license/status`

Liefert zentrale Produkt- und Entwicklerdaten sowie den serverseitig geprüften Firebase-Nutzer, Lizenztyp, Lizenzstatus, Gerätebelegung, Zustimmungsstand und Offline-Konfiguration.

`POST /api/legal-license/check`

Prüft Lizenz, Sperrstatus, Laufzeit, Gerätebindung und aktuelle AGB-/Datenschutzversion erneut über `meditestLicenseAccess`.

`POST /api/legal-license/device`

Aktiviert das lokal identifizierte Gerät, sofern das serverseitige Gerätelimit noch nicht erreicht ist.

`POST /api/legal-license/terms`

Speichert die aktive Zustimmung mit `{ "acceptTerms": true, "acceptPrivacy": true }` unter `termsAcceptances/{uid}`.

`GET /api/license/status`

Liefert Basiskauf, 7-tägige Testphase, eingeschränkten Modus, Abo-Status sowie Kauf- und Monatspreis.

`GET /api/tests/sources`

Liefert im eingeschränkten Modus ausschließlich ID, Name und Fragenanzahl vorhandener Fragenpools, damit weiterhin Testdurchläufe gestartet werden können, ohne Dokument- oder Fragenfunktionen freizugeben.

`POST /api/license/checkout/subscription`

Erstellt über `meditestCreateCheckout` eine separate Stripe-Checkout-Sitzung für das Monatsabo über 9,99 EUR. Der Basiskauf muss bereits bestätigt sein.

`POST /api/license/portal`

Öffnet für aktive Stripe-Kunden das Stripe-Kundenportal zur Abo- und Zahlungsmittelverwaltung.

`POST /api/license/redeem-premium-code`

Prüft einen administrativen Premium-Code aus `{ "code": "..." }`. Ein gültiger Code setzt den Nutzerstatus auf Premium; Katalogtests bleiben separate Kaufartikel.

`POST /api/license/redeem-catalog-code`

Prüft einen Gratis-Katalog-Code aus `{ "code": "..." }`. Die geschützte Function `meditestRedeemCatalogCode` aktualisiert den Lizenzstatus atomar. Jedes Benutzerkonto kann einen Gratis-Katalog-Code genau einmal verwenden. Derselbe gültige Code darf von unterschiedlichen Benutzerkonten jeweils einmal eingelöst werden.

`GET /api/questions/by-topic?topic={topic}`

Liefert alle Fragen eines Themas über alle Fragenpools hinweg. Dieser Endpunkt wird für den Themensprung aus der Statistik verwendet.

## Tests

`GET /api/tests`

Listet gestartete und abgeschlossene Tests.

`POST /api/tests/start`

Startet einen Test aus einem Fragenpool.

Beispiel:

```json
{
  "documentId": 1,
  "questionCount": 25,
  "testName": "Kardiologie Probe 1"
}
```

`POST /api/tests/{id}/submit`

Gibt einen Test ab und berechnet das Ergebnis.

`GET /api/tests/{id}/resume`

Lädt einen noch nicht abgegebenen Test inklusive gespeicherter Antwortauswahl, damit er später fortgesetzt werden kann.

`PUT /api/tests/{id}/draft`

Speichert den Zwischenstand eines noch nicht abgegebenen Tests.

Beispiel:

```json
{
  "answers": [
    { "questionId": 18, "selectedAnswerOptionId": 69 },
    { "questionId": 21, "selectedAnswerOptionId": null }
  ]
}
```

`GET /api/tests/{id}/review`

Liefert Auswertung, richtige Antworten, Erklärungen und Fehlerschwerpunkte.

`GET /api/tests/{id}/pdf`

Lädt ein PDF-Testprotokoll herunter. Der Kopf enthält die gespeicherten Profilangaben: Name, Matrikelnummer, Semester, Studiengang, Hochschule/Universität und E-Mail.

`DELETE /api/tests`

Löscht gespeicherte Tests und Statistiken. Dokumente und Fragen bleiben erhalten.

`DELETE /api/tests/{id}`

Löscht einen noch nicht abgegebenen Test. Abgeschlossene Tests bleiben erhalten, damit Auswertung und Statistik nicht versehentlich verloren gehen.

## Statistik

`GET /api/stats/overview`

Liefert Gesamtstatistik über alle abgeschlossenen Tests inklusive Themenanalyse, Schwierigkeitsauswertung, Verlauf, schwachen Fragen und Lernempfehlungen.

`GET /api/stats/overview?testSessionId={id}`

Liefert Statistik für einen einzelnen Test.

## Einstellungen

`GET /api/settings`

Liefert Profil- und Programmeinstellungen. Die KI-Generierung ist fest auf Firebase/Gemini eingestellt; ein KI-API-Key wird in Meduvalo nicht gespeichert.

`PUT /api/settings`

Speichert Profil- und Programmeinstellungen in Firestore unter `users/{uid}/settings/profile`.

Beispiel:

```json
{
  "displayName": "Max Mustermann",
  "matriculationNumber": "1234567",
  "studyProgram": "Humanmedizin",
  "university": "Medizinische Universität",
  "semester": "6. Semester",
  "email": "max@example.test",
  "theme": "dark",
  "defaultGenerateQuestionCount": 25,
  "defaultTestQuestionCount": 25,
  "clearOpenAiApiKey": true,
  "aiProvider": "firebase",
  "aiModel": "gemini-2.5-flash",
  "aiApiBaseUrl": "https://europe-west3-meditest-12354.cloudfunctions.net/meditestAi",
  "openAiModel": "gemini-2.5-flash",
  "allowLocalFallback": false
}
```

`theme` erlaubt `system`, `light` oder `dark`. KI-Felder werden serverseitig auf Firebase/Gemini normalisiert, vorhandene lokale KI-Keys werden entfernt und lokaler Fallback bleibt deaktiviert.

## System

`GET /api/system/update`

Prüft die konfigurierte GitHub-Release-Quelle oder `latest.json` und liefert die aktuell installierte Version, die neueste verfügbare Version und den passenden Download für die aktuelle Plattform.

```json
{
  "configured": true,
  "currentVersion": "5.0.8",
  "currentPlatform": "windows-x64",
  "latestVersion": "5.0.8",
  "updateAvailable": false,
  "releaseUrl": "https://github.com/automationTurtle95/MediTest/releases/tag/v5.0.8",
  "recommendedDownload": {
    "platform": "windows-x64",
    "url": "https://github.com/automationTurtle95/MediTest/releases/download/v5.0.8/MediTest-Setup-5.0.8-win-x64.msi",
    "fileName": "MediTest-Setup-5.0.8-win-x64.msi",
    "sha256": "...",
    "sizeBytes": 42400000
  }
}
```

`POST /api/system/shutdown`

Beendet die lokale App, das zugehörige App-Fenster und weitere Meduvalo-Prozesse derselben Installation. Der Endpunkt ist auf Loopback-Zugriffe beschränkt.

### Stripe-Produktvalidierung

`POST /api/admin/stripe-products/validate` ist ausschließlich für
Admin-Konten verfügbar. Mit `{ "createMissing": false }` werden lokale
Kaufprodukte read-only gegen Stripe geprüft. Der Bericht enthält fehlende oder
inaktive Produkte und Preise, Betrags- und Währungsabweichungen, doppelte
Treffer sowie fehlende lokale Stripe-IDs.

Mit `{ "createMissing": true }` werden eindeutige vorhandene Stripe-Produkte
und Preise wiederverwendet und dauerhaft zugeordnet. Nur vollständig fehlende
Objekte werden idempotent angelegt. Checkouts verwenden danach ausschließlich
die gespeicherte `stripePriceId`.
