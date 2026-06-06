# Webseiten-Vertrieb

## Dateien für die Webseite

Nach dem Release-Build liegen die verkaufbaren Pakete hier:

```text
dist/MediTest-4.0.6/windows/MediTest-Setup-4.0.6-win-x64.msi
dist/MediTest-4.0.6/windows/MediTest-4.0.6-win-x64-portable.zip
dist/MediTest-4.0.6/macos/MediTest-4.0.6-macos-x64-setup.zip
dist/MediTest-4.0.6/macos/MediTest-4.0.6-macos-arm64-setup.zip
dist/MediTest-4.0.6/SHA256SUMS.txt
```

Für normale Kunden sollten auf der Webseite primär diese Downloads sichtbar sein:

- Windows: `MediTest-Setup-4.0.6-win-x64.msi`
- Mac Intel: `MediTest-4.0.6-macos-x64-setup.zip`
- Mac Apple Silicon: `MediTest-4.0.6-macos-arm64-setup.zip`

Das portable Windows-ZIP ist praktisch für Support oder Tests, sollte aber nicht der Hauptdownload sein.

## GitHub-Downloadlinks

Wenn der GitHub Release `v4.0.6` veröffentlicht ist, können die Buttons auf der Webseite direkt auf die Release-Assets zeigen:

```html
<a href="https://github.com/automationTurtle95/MediTest/releases/latest/download/MediTest-Setup-4.0.6-win-x64.msi">Windows herunterladen</a>
<a href="https://github.com/automationTurtle95/MediTest/releases/latest/download/MediTest-4.0.6-macos-arm64-setup.zip">Mac Apple Silicon herunterladen</a>
<a href="https://github.com/automationTurtle95/MediTest/releases/latest/download/MediTest-4.0.6-macos-x64-setup.zip">Mac Intel herunterladen</a>
```

Alternativ kannst du die Dateien von `dist/MediTest-4.0.6/` auf deinen eigenen Webserver hochladen. Dann müssen die Links auf deiner Webseite auf die dortigen Dateien zeigen.

## Verkauf und Freischaltung

MediTest ist technisch für Verkauf vorbereitet:

- 7 Tage Testphase pro Firebase-Konto
- Monatsabo über `Billing:SubscriptionCheckoutUrl`
- Einzelkäufe über `Billing:CatalogCheckoutUrl`
- Premium-Codes über `Billing:PremiumCodeHashes`
- Gratis-Katalog-Codes über `Billing:FreeCatalogCodeHashes`

Für echte Zahlungen muss ein Zahlungsanbieter angebunden werden. Empfohlen ist Stripe Checkout mit Webhooks. Der Webhook sollte nach erfolgreicher Zahlung den Abo-Status oder die gekauften Katalogtest-IDs im Firebase-/Firestore-Nutzerkonto setzen.

## Aktueller Gratis-Code

Der in Version 4.0.6 konfigurierte Gratis-Code lautet:

```text
MT-GRATIS-KATALOG-2026
```

Er wird in `appsettings.json` nur als SHA-256-Hash gespeichert. Nach dem Einlösen kann der Nutzer genau einen gesperrten Katalogtest herunterladen; dieser Test bleibt danach für dieses Konto freigeschaltet.

## Produktive Hinweise

- GitHub Releases müssen öffentlich erreichbar sein, wenn die App Updates direkt über GitHub prüfen soll.
- Für weniger macOS-Warnungen sind Apple Developer ID, Code Signing und Notarization nötig.
- Für Windows-Vertrauen ist später ein Code-Signing-Zertifikat sinnvoll.
- Vor Verkauf auf der Webseite sollten Impressum, Datenschutz, Widerruf, AGB und Lizenzbedingungen geprüft werden.
