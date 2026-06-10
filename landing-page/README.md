# MediTest Landingpage

Die Landingpage ist eine eigenständige, statische Website. Sie enthält keinen
Code aus der MediTest-Anwendung und benötigt keine Zugriffe auf persönliche
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
- `monthlyPrice`: sichtbarer Monatspreis
- `purchaseUrl`: getrennte Kaufseite

`purchase.html` meldet Nutzer über den bestehenden Kontodienst an und startet
den serverseitigen Checkout. Der Windows-Download wird erst von
`meditestDownloadAccess` ausgegeben, wenn die serverseitige Lizenz aktiv ist.
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
konfiguriert. Aus dem Repository-Stamm:

```powershell
npx firebase-tools deploy --config firebase.hosting.json --only hosting --project meditest-12354
```

Der Kaufablauf benötigt zusätzlich die gezielt deployten Functions
`meditestCreateCheckout`, `meditestLicenseStatus` und
`meditestDownloadAccess`. Die MediTest-Anwendung unter `../MediTest` ist kein
Bestandteil des Hosting-Uploads.

## Vor dem Produktivbetrieb

- Rechtstexte vor dem kommerziellen Start juristisch prüfen lassen.
- Gewünschte Custom Domain mit der bestehenden Hosting-Site verbinden.
