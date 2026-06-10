# macOS-Signierung und Notarisierung

## Warum Apple-Zugangsdaten notwendig sind

Ein normales ZIP oder ein unsigniertes PKG wird von macOS als Software eines nicht verifizierten Entwicklers behandelt. Ein vertrauenswürdiger Installer außerhalb des Mac App Store benötigt:

- eine aktive Mitgliedschaft im Apple Developer Program
- ein Zertifikat `Developer ID Application`
- ein Zertifikat `Developer ID Installer`
- eine Notarisierung durch Apples Notary Service

Ohne diese Apple-Zertifikate kann kein Buildskript die Gatekeeper-Warnung seriös entfernen.

## Apple-Zertifikate erstellen

Im Apple Developer Portal unter `Certificates, Identifiers & Profiles`:

1. Ein Zertifikat vom Typ `Developer ID Application` erstellen.
2. Ein Zertifikat vom Typ `Developer ID Installer` erstellen.
3. Beide Zertifikate samt privatem Schlüssel auf einem Mac in der Schlüsselbundverwaltung installieren.
4. Jedes Zertifikat mit privatem Schlüssel als `.p12` exportieren.
5. Für beide Exporte dasselbe starke Exportpasswort verwenden.

Die Zertifikate müssen zum gleichen Apple-Developer-Team gehören.

## Notarisierungs-API-Key

In App Store Connect unter `Users and Access` einen Team-API-Key für die Notarisierung erstellen. Benötigt werden:

- die heruntergeladene Datei `AuthKey_<KEY_ID>.p8`
- die Key ID
- die Issuer ID

Die `.p8`-Datei kann bei Apple nur einmal heruntergeladen werden und darf nicht ins Repository gelangen.

## Dateien in Base64 umwandeln

Auf dem Mac:

```bash
base64 < DeveloperIDApplication.p12 | tr -d '\n' | pbcopy
base64 < DeveloperIDInstaller.p12 | tr -d '\n' | pbcopy
base64 < AuthKey_DEINE_KEY_ID.p8 | tr -d '\n' | pbcopy
```

Jeden Befehl einzeln ausführen und den jeweiligen Inhalt als GitHub Secret speichern.

## GitHub-Secrets

Im Repository unter `Settings -> Secrets and variables -> Actions` folgende Secrets anlegen:

```text
APPLE_DEVELOPER_ID_APPLICATION_P12_BASE64
APPLE_DEVELOPER_ID_INSTALLER_P12_BASE64
APPLE_CERTIFICATE_PASSWORD
APPLE_API_KEY_P8_BASE64
APPLE_API_KEY_ID
APPLE_API_ISSUER_ID
```

Optional:

```text
APPLE_KEYCHAIN_PASSWORD
```

Wenn `APPLE_KEYCHAIN_PASSWORD` fehlt, erzeugt der Workflow ein temporäres Passwort.

## Release-Ablauf

Beim Push eines Versionstags:

```bash
git tag v5.0.3
git push origin main
git push origin v5.0.3
```

führt GitHub Actions folgende Schritte aus:

1. Windows-MSI und Portable-ZIP auf Windows bauen.
2. Intel- und Apple-Silicon-App auf macOS bauen.
3. Alle nativen Mach-O-Dateien mit `Developer ID Application` signieren.
4. Den .NET-Apphost mit Hardened Runtime und `allow-jit` signieren.
5. Native PKG-Installer mit `Developer ID Installer` erstellen.
6. Beide PKGs mit `notarytool` bei Apple einreichen.
7. Das Notarisierungsticket mit `stapler` anheften.
8. Signatur und Gatekeeper-Freigabe prüfen.
9. Erst danach den GitHub Release veröffentlichen.

Fehlen die Apple-Secrets, veröffentlicht der Workflow vorerst die unsignierten macOS-ZIPs aus dem plattformübergreifenden Fallback-Build. Sobald alle Secrets vorhanden sind, werden sie automatisch durch signierte und notarisierte PKGs ersetzt. Lehnt Apple bei konfigurierten Secrets die Signierung oder Notarisierung ab, schlägt der Release weiterhin fehl.

## Manuelle Kontrolle auf einem Mac

```bash
pkgutil --check-signature MediTest-Setup-5.0.3-macos-arm64.pkg
xcrun stapler validate MediTest-Setup-5.0.3-macos-arm64.pkg
spctl --assess --type install --verbose=4 MediTest-Setup-5.0.3-macos-arm64.pkg
```

Die abschließende Praxiskontrolle sollte auf einem Mac erfolgen, auf dem MediTest zuvor noch nie installiert oder manuell freigegeben wurde.
