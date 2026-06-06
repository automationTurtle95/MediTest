# Webseiten-Vertrieb

## Dateien für die Webseite

Nach dem Release-Build liegen die verkaufbaren Pakete hier:

```text
MediTest-Setup-4.0.7-win-x64.msi
MediTest-4.0.7-win-x64-portable.zip
MediTest-Setup-4.0.7-macos-x64.pkg
MediTest-Setup-4.0.7-macos-arm64.pkg
SHA256SUMS.txt
```

Für normale Kunden sollten auf der Webseite primär diese Downloads sichtbar sein:

- Windows: `MediTest-Setup-4.0.7-win-x64.msi`
- Mac Intel: `MediTest-Setup-4.0.7-macos-x64.pkg`
- Mac Apple Silicon: `MediTest-Setup-4.0.7-macos-arm64.pkg`

Das portable Windows-ZIP ist praktisch für Support oder Tests, sollte aber nicht der Hauptdownload sein.

## GitHub-Downloadlinks

Wenn der GitHub Release `v4.0.7` veröffentlicht ist, können die Buttons auf der Webseite direkt auf die Release-Assets zeigen:

```html
<a href="https://github.com/automationTurtle95/MediTest/releases/latest/download/MediTest-Setup-4.0.7-win-x64.msi">Windows herunterladen</a>
<a href="https://github.com/automationTurtle95/MediTest/releases/latest/download/MediTest-Setup-4.0.7-macos-arm64.pkg">Mac Apple Silicon herunterladen</a>
<a href="https://github.com/automationTurtle95/MediTest/releases/latest/download/MediTest-Setup-4.0.7-macos-x64.pkg">Mac Intel herunterladen</a>
```

Alternativ kannst du die Dateien des GitHub Release `v4.0.7` auf deinen eigenen Webserver hochladen. Dann müssen die Links auf deiner Webseite auf die dortigen Dateien zeigen.

## Verkauf und Freischaltung

MediTest ist technisch für Verkauf vorbereitet:

- 7 Tage Testphase pro Firebase-Konto
- Monatsabo über `Billing:SubscriptionCheckoutUrl`
- Einzelkäufe über `Billing:CatalogCheckoutUrl`
- Premium-Codes über `Billing:PremiumCodeHashes`
- Gratis-Katalog-Codes über `Billing:FreeCatalogCodeHashes`

Für echte Zahlungen muss ein Zahlungsanbieter angebunden werden. Empfohlen ist Stripe Checkout mit Webhooks. Der Webhook sollte nach erfolgreicher Zahlung den Abo-Status oder die gekauften Katalogtest-IDs im Firebase-/Firestore-Nutzerkonto setzen.

## Aktueller Gratis-Code

Der in Version 4.0.7 konfigurierte Gratis-Code lautet:

```text
MT-GRATIS-KATALOG-2026
```

Er wird in `appsettings.json` nur als SHA-256-Hash gespeichert. Nach dem Einlösen kann der Nutzer genau einen gesperrten Katalogtest herunterladen; dieser Test bleibt danach für dieses Konto freigeschaltet.

## Produktive Hinweise

- GitHub Releases müssen öffentlich erreichbar sein, wenn die App Updates direkt über GitHub prüfen soll.
- Die Mac-PKGs müssen aus dem signierten und notarisierten GitHub-Workflow stammen. Unsignierte ZIPs sind nur für interne Tests.
- Für Windows-Vertrauen ist später ein Code-Signing-Zertifikat sinnvoll.
- Vor Verkauf auf der Webseite sollten Impressum, Datenschutz, Widerruf, AGB und Lizenzbedingungen geprüft werden.
