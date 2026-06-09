# Release-Prozess

## Ziel

Ein Release besteht aus frisch erzeugten, reproduzierbaren Artefakten unter:

```text
dist/MediTest-4.1.4/
```

Bestehende stabile Releases bleiben erhalten. Insbesondere darf `dist/MediTest-2.0.0/` nicht gelöscht werden, solange V2 als lauffähiges Produkt archiviert bleiben soll.

Alte Build-Zwischenstände gehören nicht ins Quellprojekt. `bin/`, `obj/`, `.wix/`, lokale Datenbanken und lokale API-Key- oder Secret-Dateien werden nicht in Release-Pakete übernommen.

## Build ausführen

```powershell
cd MediTest
powershell -ExecutionPolicy Bypass -File .\scripts\build-release.ps1
```

Das Skript führt aus:

1. die Version aus `MediTest.csproj` lesen, sofern `-Version` nicht explizit gesetzt wurde
2. nur den Zielordner `dist/MediTest-4.1.4/` entfernen
3. `dotnet restore`
4. `dotnet build --configuration Release`
5. self-contained Publish für `win-x64`, `osx-x64` und `osx-arm64`
6. Debug-Symbole, XML-Dokumentation, lokale Daten und temporäre Dateien aus den Publish-Ordnern entfernen
7. Windows-Portable-ZIP erzeugen
8. Windows-MSI mit WiX erzeugen, inklusive MediTest-Design und `assets/LicenseAgreement.rtf`
9. unsignierte macOS-ZIPs als vorläufigen Fallback erzeugen
10. Dokumentation in das Release kopieren
11. `latest.json` und `SHA256SUMS.txt` erzeugen

Sind die Apple-Secrets konfiguriert, baut der GitHub-Workflow zusätzlich signierte macOS-Pakete auf einem macOS-Runner:

1. self-contained Publish für `osx-x64` und `osx-arm64`
2. native App-Bundles mit unsichtbarem Launcher erstellen
3. alle Mach-O-Komponenten mit `Developer ID Application` signieren
4. native PKG-Installer mit `Developer ID Installer` erstellen
5. beide Pakete bei Apple notarisieren
6. Notarisierungsticket anheften und Gatekeeper-Prüfung ausführen

## Erwartete Artefakte

```text
dist/MediTest-4.1.4/windows/MediTest-Setup-4.1.4-win-x64.msi
dist/MediTest-4.1.4/windows/MediTest-4.1.4-win-x64-portable.zip
dist/MediTest-4.1.4/macos/MediTest-4.1.4-macos-x64-setup.zip
dist/MediTest-4.1.4/macos/MediTest-4.1.4-macos-arm64-setup.zip
latest.json
SHA256SUMS.txt
```

Wenn alle Apple-Secrets vorhanden sind, ersetzt der Workflow die beiden macOS-ZIPs im GitHub-Release durch signierte und notarisierte PKGs. Ohne Secrets werden die ZIPs mit einem deutlichen Hinweis veröffentlicht.

## GitHub Releases

`latest.json` und die abschließende `SHA256SUMS.txt` werden im GitHub-Release-Job aus den erfolgreich gebauten Windows- und macOS-Artefakten erzeugt.

Danach in GitHub einen Release mit dem Tag `v4.1.4` erstellen. Der Workflow veröffentlicht:

```text
MediTest-Setup-4.1.4-win-x64.msi
MediTest-4.1.4-win-x64-portable.zip
MediTest-4.1.4-macos-arm64-setup.zip
MediTest-4.1.4-macos-x64-setup.zip
latest.json
SHA256SUMS.txt
```

Mit eingerichteten Apple-Secrets heißen die beiden Mac-Dateien stattdessen `MediTest-Setup-4.1.4-macos-<arch>.pkg`.

Die installierte App kann Updates direkt über die GitHub-Release-API prüfen, wenn in `appsettings.json` konfiguriert ist:

```json
{
  "Updates": {
    "Enabled": true,
    "GitHubRepository": "automationTurtle95/MediTest",
    "ManifestUrl": ""
  }
}
```

Alternativ kann `ManifestUrl` auf eine veröffentlichte `latest.json` zeigen. Wenn `ManifestUrl` gesetzt ist, hat sie Vorrang vor `GitHubRepository`.

Wenn das Repository auf GitHub liegt, kann `.github/workflows/release.yml` den Release automatisch bauen. Dafür die Version in `MediTest.csproj` erhöhen, committen und einen passenden Tag pushen:

```powershell
git tag v4.1.4
git push origin main
git push origin v4.1.4
```

Der Workflow prüft, dass der Git-Tag zur Projektversion passt. Fehlen die Apple-Secrets, bleibt der macOS-Signierungsjob erfolgreich übersprungen und die Fallback-ZIPs werden veröffentlicht. Die benötigten Secrets für spätere signierte PKGs sind in [MACOS_SIGNING.md](MACOS_SIGNING.md) beschrieben.

## Release-Regeln

- Keine `.pdb`-Dateien im Release.
- Keine lokale `meditest.db` im Release.
- Keine lokalen API-Key- oder Secret-Dateien im Release.
- Keine alten `release/v2.0`- oder `1.0.0`-Artefakte im Projekt.
- `dist/MediTest-2.0.0/` bleibt als stabile V2-Linie erhalten.
- Versionsnummern in `.csproj`, MSI und Dateinamen müssen übereinstimmen.
- Unsignierte macOS-ZIPs müssen im Release als nicht signiert und nicht notarisiert gekennzeichnet sein.
- Sobald die Apple-Secrets vorhanden sind, sollen Kunden-Mac-Pakete als signierte und notarisierte `.pkg` veröffentlicht werden.
- Für neue Features immer die `<Version>` in `MediTest.csproj` erhöhen; das Release-Skript übernimmt diese Version automatisch.
- Das MSI enthält ein Major-Upgrade mit konstantem `UpgradeCode`, damit eine neuere Version über eine bestehende Installation installiert werden kann.
- Private Nutzerdaten werden unter `users/{uid}/...` in Firestore gespeichert; der Katalog liegt getrennt in `catalogTests`.

## Nach dem Build prüfen

```powershell
Get-ChildItem .\dist\MediTest-4.1.4 -Recurse -File |
  Where-Object { $_.Name -match '\.pdb$|OPENAI_API_KEY|meditest\.db|start-name\.json' }
```

Die Ausgabe muss leer sein.

```powershell
Get-FileHash -Algorithm SHA256 .\dist\MediTest-4.1.4\windows\MediTest-Setup-4.1.4-win-x64.msi
```

Der Hash muss mit dem Eintrag in `SHA256SUMS.txt` übereinstimmen.
