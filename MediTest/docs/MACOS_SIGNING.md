# macOS-Signierung und Notarisierung

Meduvalo wird außerhalb des Mac App Store verteilt. Der produktive Release benötigt deshalb zwei Developer-ID-Zertifikate und eine erfolgreiche Apple-Notarisierung. Ab Version 5.0.4 veröffentlicht der Workflow keine unsignierten macOS-Fallbacks mehr.

## Voraussetzungen

- aktive Mitgliedschaft im Apple Developer Program
- Zugriff als Account Holder auf Developer-ID-Zertifikate
- ein Mac zum Erstellen der Zertifikatsanfragen und Exportieren der privaten Schlüssel
- Admin-Zugriff auf das GitHub-Repository

Die App verwendet die Bundle-ID:

```text
com.automationturtle95.meditest
```

## Developer-ID-Zertifikate

Im Apple Developer Portal unter `Certificates, Identifiers & Profiles -> Certificates`:

1. Über `+` ein Zertifikat vom Typ `Developer ID Application` erstellen.
2. Über `+` ein Zertifikat vom Typ `Developer ID Installer` erstellen.
3. Beide Zertifikate samt privatem Schlüssel im macOS-Schlüsselbund installieren.
4. Jedes Zertifikat mit privatem Schlüssel als `.p12` exportieren.
5. Für beide Exporte dasselbe starke Exportpasswort verwenden.

Beide Zertifikate müssen zum selben Apple-Developer-Team gehören. Die `.cer`-Datei allein reicht nicht; GitHub Actions benötigt den zugehörigen privaten Schlüssel im `.p12`.

## Notarisierungs-Key

In App Store Connect unter `Users and Access -> Integrations` einen Team-API-Key für die Notarisierung erstellen. Benötigt werden:

- `AuthKey_<KEY_ID>.p8`
- Key ID
- Issuer ID

Die `.p8`-Datei kann nur einmal heruntergeladen werden und darf nicht in Git oder in einen öffentlichen Cloud-Ordner gelangen.

## GitHub-Secrets

Auf dem Mac die drei Binärdateien jeweils einzeilig in Base64 umwandeln:

```bash
base64 < DeveloperIDApplication.p12 | tr -d '\n' | pbcopy
base64 < DeveloperIDInstaller.p12 | tr -d '\n' | pbcopy
base64 < AuthKey_DEINE_KEY_ID.p8 | tr -d '\n' | pbcopy
```

Im GitHub-Repository unter `Settings -> Secrets and variables -> Actions` diese Repository-Secrets anlegen:

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

Wenn `APPLE_KEYCHAIN_PASSWORD` fehlt, erzeugt GitHub Actions ein temporäres Passwort. Zertifikate, API-Key und temporärer Schlüsselbund werden nach dem Job gelöscht.

## Apple-Anmeldung in Firebase

Die Developer-ID-Signierung ist unabhängig von `Mit Apple anmelden`. Für den Apple-Login zusätzlich:

1. Im Apple Developer Portal eine Services ID für Meduvalo registrieren.
2. `Sign in with Apple` aktivieren und `meditest-12354.firebaseapp.com` als Web-Domain konfigurieren.
3. Als Return URL `https://meditest-12354.firebaseapp.com/__/auth/handler` hinterlegen.
4. Einen Sign-in-with-Apple-Key erstellen und Team ID, Services ID, Key ID sowie privaten Schlüssel im Firebase-Provider `Apple` eintragen.
5. In Firebase Authentication den Apple-Provider aktivieren.

## Release

Nach dem Einrichten der Secrets:

```bash
git tag v5.0.4
git push origin main
git push origin v5.0.4
```

Der Workflow:

1. importiert beide Developer-ID-Zertifikate in einen temporären Schlüsselbund,
2. validiert die Notarisierungs-Zugangsdaten,
3. baut Intel- und Apple-Silicon-App,
4. signiert alle Mach-O-Komponenten mit Hardened Runtime,
5. erstellt und signiert die PKG-Installer direkt mit `pkgbuild`,
6. reicht beide Pakete parallel über `notarytool` bei Apple ein und fragt den Status anhand der Submission-ID ab,
7. hängt das Notarisierungsticket mit `stapler` an,
8. prüft Signatur und Gatekeeper-Freigabe,
9. veröffentlicht erst danach den GitHub Release.

Fehlt ein Secret oder lehnt Apple ein Paket ab, schlägt der Release fehl. Der Workflow veröffentlicht dann keine unsignierte Ersatzdatei.

## Manuelle Kontrolle

Auf einem Mac:

```bash
pkgutil --check-signature MediTest-Setup-5.0.4-macos-arm64.pkg
xcrun stapler validate MediTest-Setup-5.0.4-macos-arm64.pkg
spctl --assess --type install --verbose=4 MediTest-Setup-5.0.4-macos-arm64.pkg
```

Zusätzlich sollte das Paket auf einem Mac getestet werden, auf dem Meduvalo zuvor weder installiert noch manuell freigegeben wurde.
