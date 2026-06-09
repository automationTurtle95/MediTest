# Webseiten-Vertrieb

## Dateien für die Webseite

Nach dem Release-Build liegen die verkaufbaren Pakete hier:

```text
MediTest-Setup-4.1.3-win-x64.msi
MediTest-4.1.3-win-x64-portable.zip
MediTest-4.1.3-macos-x64-setup.zip
MediTest-4.1.3-macos-arm64-setup.zip
SHA256SUMS.txt
```

Für normale Kunden sollten auf der Webseite primär diese Downloads sichtbar sein:

- Windows: `MediTest-Setup-4.1.3-win-x64.msi`
- Mac Intel: `MediTest-4.1.3-macos-x64-setup.zip`
- Mac Apple Silicon: `MediTest-4.1.3-macos-arm64-setup.zip`

Das portable Windows-ZIP ist praktisch für Support oder Tests, sollte aber nicht der Hauptdownload sein.

## GitHub-Downloadlinks

Wenn der GitHub Release `v4.1.3` veröffentlicht ist, können die Buttons auf der Webseite direkt auf die Release-Assets zeigen:

```html
<a href="https://github.com/automationTurtle95/MediTest/releases/latest/download/MediTest-Setup-4.1.3-win-x64.msi">Windows herunterladen</a>
<a href="https://github.com/automationTurtle95/MediTest/releases/latest/download/MediTest-4.1.3-macos-arm64-setup.zip">Mac Apple Silicon herunterladen</a>
<a href="https://github.com/automationTurtle95/MediTest/releases/latest/download/MediTest-4.1.3-macos-x64-setup.zip">Mac Intel herunterladen</a>
```

Alternativ kannst du die Dateien des GitHub Release `v4.1.3` auf deinen eigenen Webserver hochladen. Dann müssen die Links auf deiner Webseite auf die dortigen Dateien zeigen.

## Verkauf und Freischaltung

MediTest ist technisch für Verkauf vorbereitet:

- 7 Tage Testphase pro Firebase-Konto
- Monatsabo über `Billing:SubscriptionCheckoutUrl`
- Einzelkäufe über `Billing:CatalogCheckoutUrl`
- Premium-Codes über `Billing:PremiumCodeHashes`
- Gratis-Katalog-Codes über `Billing:FreeCatalogCodeHashes`

Für echte Zahlungen muss ein Zahlungsanbieter angebunden werden. Empfohlen ist Stripe Checkout mit Webhooks. Der Webhook sollte nach erfolgreicher Zahlung den Abo-Status oder die gekauften Katalogtest-IDs im Firebase-/Firestore-Nutzerkonto setzen.

## Gratis-Katalog-Code

Der Klartext eines Gratis-Codes sollte nicht auf einer öffentlichen Webseite oder in der App als Beispiel angezeigt werden. In `appsettings.json` liegt nur der SHA-256-Hash. Die geschützte Cloud Function markiert den Code beim Einlösen atomar als verbraucht, sodass er systemweit nur einmal verwendet werden kann. Danach kann das einlösende Konto genau einen gesperrten Katalogtest dauerhaft freischalten.

## Produktive Hinweise

- GitHub Releases müssen öffentlich erreichbar sein, wenn die App Updates direkt über GitHub prüfen soll.
- Die vorläufigen Mac-ZIPs sind nicht mit einer Apple Developer ID signiert oder notarisiert und müssen entsprechend gekennzeichnet werden. Sobald die Apple-Secrets vorhanden sind, sollen die Downloadlinks auf die signierten PKGs umgestellt werden.
- Für Windows-Vertrauen ist später ein Code-Signing-Zertifikat sinnvoll.
- Vor Verkauf auf der Webseite sollten Impressum, Datenschutz, Widerruf, AGB und Lizenzbedingungen geprüft werden.
