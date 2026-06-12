# Meduvalo Landingpage

Die Landingpage ist eine eigenständige, statische Website. Sie enthält keinen
Code aus der Meduvalo-Anwendung und benötigt keine Zugriffe auf persönliche
Lern-, Konto- oder Lizenzdaten.

## Struktur

```text
landing-page/
  index.html
  purchase.html
  legal.html
  404.html
  styles.css
  script.js
  purchase.js
  README.md
```

Die eigentliche Anwendung liegt weiterhin unter `../MediTest`. Backend,
Zugriffsregeln und Hosting-Konfiguration bleiben getrennt unter `../firebase`.

## Marke, Preis und Kaufablauf ändern

Zentrale Werte stehen am Anfang von `script.js` in `SITE_CONFIG`:

- `brandName`: sichtbarer Produktname
- `domain`: öffentliche Domain `meduvalo.at`
- `websiteUrl`: kanonische Website-URL `https://meduvalo.at`
- `claim`: Hauptclaim
- `shortClaim`: alternativer Kurzclaim
- `description`: zentrale Produktbeschreibung
- `purchasePrice`: einmaliger Kaufpreis für Installer und 7-tägige Testphase
- `monthlyPrice`: optionaler Monatspreis für den Vollzugang nach der Testphase
- `purchaseUrl`: getrennte Kaufseite

`purchase.html` meldet Nutzer über den bestehenden Kontodienst an und startet
den serverseitigen Einmalkauf-Checkout. Der Windows-Download wird erst von
`meditestDownloadAccess` ausgegeben, wenn der Basiskauf serverseitig bestätigt
ist. Das spätere Monatsabo wird ausschließlich innerhalb der Anwendung separat
abgeschlossen. Katalogtests bleiben eigenständige Kaufartikel.
Die Landingpage entscheidet niemals selbst über einen Lizenzstatus.

## Lokal testen

Einfacher statischer Test aus dem Repository-Stamm:

```powershell
python -m http.server 8080 --directory landing-page
```

Danach `http://127.0.0.1:8080` öffnen.

Test mit der exakten Hosting-Konfiguration aus dem Repository-Stamm:

```powershell
npx firebase-tools emulators:start --config firebase.hosting.json --only hosting --project meditest-12354
```

Danach die vom Emulator ausgegebene lokale Hosting-URL öffnen.

## Deployment

Die bestehende Default-Site ist ausschließlich für die Landingpage
konfiguriert. `firebase.hosting.json` verwendet `landing-page` als
Hosting-Public-Ordner. Es sind keine Hosting-Targets oder weiteren Sites im
Repository konfiguriert. Aus dem Repository-Stamm:

```powershell
npx firebase-tools deploy --config firebase.hosting.json --only hosting --project meditest-12354
```

Der Kaufablauf benötigt zusätzlich die gezielt deployten Functions
`meditestCreateCheckout`, `meditestLicenseStatus` und
`meditestDownloadAccess`. Die Meduvalo-Anwendung unter `../MediTest` ist kein
Bestandteil des Hosting-Uploads.

## Custom Domain `meduvalo.at`

Canonical- und OpenGraph-URL der Landingpage verweisen auf
`https://meduvalo.at/`. Die Domain-Verbindung selbst wird nicht durch Dateien
im Repository hergestellt.

Manuelle Schritte:

1. Firebase Console für das bestehende Projekt `meditest-12354` öffnen.
2. `Hosting` öffnen.
3. `Custom Domain hinzufügen` wählen.
4. `meduvalo.at` eintragen.
5. Die von Firebase geforderten DNS-Records beim Domainanbieter setzen.
6. DNS-Prüfung und Bereitstellung des SSL-Zertifikats abwarten.

Optional kann anschließend `www.meduvalo.at` als weitere Custom Domain
hinzugefügt und auf die Hauptdomain weitergeleitet werden. Eine separate
Hosting-Site oder ein Multi-Site-Target ist für den aktuellen Aufbau nicht
erforderlich.

## Vor dem Produktivbetrieb

- Rechtstexte vor dem kommerziellen Start juristisch prüfen lassen.
- Gewünschte Custom Domain mit der bestehenden Hosting-Site verbinden.
