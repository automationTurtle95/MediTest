# API

MediTest stellt eine lokale HTTP-API bereit. Standardadresse:

```text
http://127.0.0.1:55000
```

Alle Endpunkte liefern JSON, außer der TXT-Export und der PDF-Download. Ab Version 4.0.1 sind die App-Endpunkte mit Firebase Authentication geschützt und private Nutzerdaten werden in Firestore unter `users/{uid}/...` gespeichert. Der Browser meldet sich direkt bei Firebase an und sendet danach `Authorization: Bearer <firebase-id-token>` an die lokale API.

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
    "projectId": "meditest-12354"
  }
}
```

`POST /api/auth/register`

Nicht mehr für produktive Anmeldung vorgesehen. Registrierung läuft im Frontend über Firebase `accounts:signUp`.

`POST /api/auth/login`

Nicht mehr für produktive Anmeldung vorgesehen. Die Anmeldung läuft im Frontend über Firebase `accounts:signInWithPassword`.

`GET /api/auth/me`

Validiert den Firebase-ID-Token und liefert den aktuellen Benutzer.

`POST /api/auth/logout`

Bestätigt die Abmeldung für das Frontend. Das lokale Token wird clientseitig aus `sessionStorage` entfernt.

Passwort-Reset und Passwortänderung laufen direkt im Browser über Firebase Authentication. Die lokale MediTest-API speichert keine Passwörter und kennt keine Passwort-Hashes.

## Dokumente

`POST /api/documents/upload`

Lädt eine Datei hoch und extrahiert Text. Erlaubt sind `.pdf`, `.pptx` und `.txt`.

`GET /api/documents`

Gibt alle gespeicherten Dokumente bzw. Fragenpools zurück.

`GET /api/documents/{id}/questions`

Gibt alle Fragen eines Dokuments inklusive Antwortoptionen und richtiger Antwort zurück.

`DELETE /api/documents/{id}`

Löscht ein Dokument inklusive Fragen und zugehöriger Tests.

`POST /api/documents/{id}/generate-questions`

Generiert neue Fragen aus dem extrahierten Dokumenttext.

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

## Firestore-Katalog

`GET /api/catalog/tests`

Listet themenspezifische Tests aus der Firestore-Collection `catalogTests`. Für vorhandene V3-Katalogdaten wird zusätzlich der Legacy-Pfad `thematicTests` gelesen. Die Antwort enthält `canPublish` und `freeCatalogCreditAvailable`, damit die Oberfläche Admin-Bereich und Gratis-Test-Aktion nur für berechtigte Konten zeigt. Premium- und Admin-Konten erhalten Zugriff auf alle Katalogtests.

`POST /api/catalog/tests/{catalogId}/download`

Lädt einen Firestore-Test herunter und legt ihn als privaten Fragenpool unter `users/{uid}/documents` an. Normale Nutzer brauchen dafür einen gekauften Katalogtest oder einen aktiven Gratis-Katalog-Code; Admin-Konten dürfen ohne Kauf herunterladen.

Beispiel:

```json
{
  "documentName": "Kardiologie Grundlagen"
}
```

`POST /api/catalog/tests/{catalogId}/checkout`

Bereitet den Checkout für einen Katalogtest vor. Ohne konfigurierte `Billing:CatalogCheckoutUrl` liefert der Endpunkt `501`, damit die Oberfläche klar meldet, dass der Zahlungsanbieter noch nicht verbunden ist.

`POST /api/catalog/tests/publish`

Veröffentlicht einen privaten Fragenpool im Firestore-Katalog. Erlaubt ist das nur für Admin-Konten mit Firebase Custom Claim `admin=true`; Firestore-Regeln müssen Schreibzugriffe entsprechend begrenzen.

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

`GET /api/license/status`

Liefert Testphase, Abo-Status und Preisangaben.

`POST /api/license/checkout/subscription`

Bereitet den Checkout für das Monatsabo vor. Ohne konfigurierte `Billing:SubscriptionCheckoutUrl` liefert der Endpunkt `501`.

`POST /api/license/redeem-premium-code`

Prüft einen Premium-Code aus `{ "code": "..." }`. Ein gültiger Code setzt den Nutzerstatus auf Premium und schaltet alle Katalogtests frei.

`POST /api/license/redeem-catalog-code`

Prüft einen Gratis-Katalog-Code aus `{ "code": "..." }`. Ein gültiger Code setzt einen offenen Gratis-Credit im Nutzerkonto. Der nächste gesperrte Katalogtest, den der Nutzer herunterlädt, wird damit dauerhaft freigeschaltet.

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

Liefert Profil- und Programmeinstellungen. Die KI-Generierung ist fest auf Firebase/Gemini eingestellt; ein KI-API-Key wird in MediTest nicht gespeichert.

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
  "currentVersion": "4.0.8",
  "currentPlatform": "windows-x64",
  "latestVersion": "4.0.8",
  "updateAvailable": false,
  "releaseUrl": "https://github.com/automationTurtle95/MediTest/releases/tag/v4.0.8",
  "recommendedDownload": {
    "platform": "windows-x64",
    "url": "https://github.com/automationTurtle95/MediTest/releases/download/v4.0.8/MediTest-Setup-4.0.8-win-x64.msi",
    "fileName": "MediTest-Setup-4.0.8-win-x64.msi",
    "sha256": "...",
    "sizeBytes": 42400000
  }
}
```

`POST /api/system/shutdown`

Beendet die lokale App. Der Endpunkt ist auf Loopback-Zugriffe beschränkt.
