# Webseiten-Vertrieb

Die öffentliche Meduvalo-Landingpage liegt getrennt unter `landing-page/` und
wird über die bestehende Firebase-Hosting-Site für `https://meduvalo.at`
bereitgestellt. Die Desktop-Anwendung bleibt außerhalb des Hosting-Public-
Ordners.

## Release-Dateien

Version 5.0.5 veröffentlicht:

```text
MediTest-Setup-5.0.5-win-x64.msi
MediTest-5.0.5-win-x64-portable.zip
MediTest-Setup-5.0.5-macos-arm64.dmg
MediTest-Setup-5.0.5-macos-x64.dmg
SHA256SUMS.txt
```

Die beiden macOS-DMGs müssen mit `Developer ID Application` signiert, von Apple notarisiert und mit einem Ticket versehen sein.

## Geschützter Download

Die Kaufseite übergibt eine Plattform an `meditestDownloadAccess`:

```text
windows-x64
macos-arm64
macos-x64
```

Ein Basiskauf oder Gratis-Produktcode gilt für alle Desktop-Plattformen. Die Function liefert nach der Lizenzprüfung nur die zum ausgewählten System passende URL.

Firebase-Functions-Parameter:

```text
CURRENT_APP_VERSION
WINDOWS_DOWNLOAD_URL
MACOS_ARM64_DOWNLOAD_URL
MACOS_X64_DOWNLOAD_URL
```

Nach einem neuen Release müssen Version und URLs gemeinsam aktualisiert und die Functions erneut bereitgestellt werden.

## Kauf und Freischaltung

- einmaliger Basiskauf zum serverseitig konfigurierten Preis
- Download für Windows, Apple Silicon oder Intel-Mac
- 7 Tage vollständiger Zugang ab Kauf
- optionales Monatsabo
- Gratis-Produktcode als alternative Basiskauf-Freischaltung
- separate Katalogtest-Käufe

Stripe Checkout und der signaturgeprüfte Webhook setzen die Lizenz im Firebase-/Firestore-Konto. Die gewählte Plattform wird nur für die Rückleitung und Downloadauswahl gespeichert; die Lizenz selbst bleibt plattformübergreifend.

## Produktive Hinweise

- Hosting-Deployment aus dem Repository-Stamm:
  `npx firebase-tools deploy --config firebase.hosting.json --only hosting --project meditest-12354`
- Die Custom Domain `meduvalo.at` muss in der Firebase Console hinzugefügt und
  über die von Firebase vorgegebenen DNS-Records beim Domainanbieter bestätigt
  werden. SSL wird anschließend von Firebase bereitgestellt.
- GitHub Releases müssen erreichbar sein, solange die Download-URLs auf öffentliche Release-Assets zeigen.
- Ein wirklich nicht öffentlich abrufbarer Binärdownload benötigt später private Cloud-Storage-Objekte mit kurzlebigen signierten URLs.
- Vor jedem Release müssen beide macOS-DMGs auf einem frischen Mac über Gatekeeper getestet werden.
- Impressum, Datenschutz, Widerruf, AGB und Lizenzbedingungen müssen alle angebotenen Desktop-Plattformen abdecken.
