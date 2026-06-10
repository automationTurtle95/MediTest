# Webseiten-Vertrieb

## Dateien für die Webseite

Nach dem Release-Build liegen die verkaufbaren Pakete hier:

```text
MediTest-Setup-5.0.3-win-x64.msi
MediTest-5.0.3-win-x64-portable.zip
MediTest-5.0.3-macos-x64-setup.zip
MediTest-5.0.3-macos-arm64-setup.zip
SHA256SUMS.txt
```

Für normale Kunden sollten auf der Webseite primär diese Downloads sichtbar sein:

- Windows: `MediTest-Setup-5.0.3-win-x64.msi`
- Mac Intel: `MediTest-5.0.3-macos-x64-setup.zip`
- Mac Apple Silicon: `MediTest-5.0.3-macos-arm64-setup.zip`

Das portable Windows-ZIP ist praktisch für Support oder Tests, sollte aber nicht der Hauptdownload sein.

## GitHub-Downloadlinks

Wenn der GitHub Release `v5.0.3` veröffentlicht ist, können die Buttons auf der Webseite direkt auf die Release-Assets zeigen:

```html
<a href="https://github.com/automationTurtle95/MediTest/releases/latest/download/MediTest-Setup-5.0.3-win-x64.msi">Windows herunterladen</a>
<a href="https://github.com/automationTurtle95/MediTest/releases/latest/download/MediTest-5.0.3-macos-arm64-setup.zip">Mac Apple Silicon herunterladen</a>
<a href="https://github.com/automationTurtle95/MediTest/releases/latest/download/MediTest-5.0.3-macos-x64-setup.zip">Mac Intel herunterladen</a>
```

Alternativ kannst du die Dateien des GitHub Release `v5.0.3` auf deinen eigenen Webserver hochladen. Dann müssen die Links auf deiner Webseite auf die dortigen Dateien zeigen.

## Verkauf und Freischaltung

MediTest ist technisch für Verkauf vorbereitet:

- Basiskauf zum serverseitig konfigurierten Preis `BILLING_PRODUCT_PRICE_CENTS`
- 7 Tage Testphase ab bestätigtem Basiskauf
- optionales Monatsabo zum serverseitig konfigurierten Preis `BILLING_MONTHLY_PRICE_CENTS`
- eingeschränkte Nutzung vorhandener Tests nach Ablauf ohne Abo
- Katalogpreise über `STRIPE_CATALOG_UNIT_PRICE_ID` und `STRIPE_CATALOG_ENDING_PRICE_ID`
- Premium- und Gratis-Code-Hashes über Firebase-Functions-Parameter

Stripe Checkout und der signaturgeprüfte Webhook setzen nach erfolgreicher Zahlung den Basiskauf, den Abo-Status oder die gekauften Katalogtest-IDs im Firebase-/Firestore-Nutzerkonto. Der Basiskauf verlängert sich nicht automatisch; das Abo wird separat abgeschlossen.

## Gratis-Katalog-Code

Der Klartext eines Gratis-Codes sollte nicht auf einer öffentlichen Webseite oder in der App als Beispiel angezeigt werden. In `appsettings.json` liegt nur der SHA-256-Hash. Die geschützte Cloud Function speichert die Einlösung atomar im persönlichen Lizenzstatus. Jedes Benutzerkonto kann den Code genau einmal verwenden und damit einen gesperrten Katalogtest dauerhaft freischalten.

## Produktive Hinweise

- GitHub Releases müssen öffentlich erreichbar sein, wenn die App Updates direkt über GitHub prüfen soll.
- Die vorläufigen Mac-ZIPs sind nicht mit einer Apple Developer ID signiert oder notarisiert und müssen entsprechend gekennzeichnet werden. Sobald die Apple-Secrets vorhanden sind, sollen die Downloadlinks auf die signierten PKGs umgestellt werden.
- Für Windows-Vertrauen ist später ein Code-Signing-Zertifikat sinnvoll.
- Vor Verkauf auf der Webseite sollten Impressum, Datenschutz, Widerruf, AGB und Lizenzbedingungen geprüft werden.
