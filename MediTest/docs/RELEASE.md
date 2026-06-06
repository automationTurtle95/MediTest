# Release-Prozess

## Ziel

Ein Release besteht aus frisch erzeugten, reproduzierbaren Artefakten unter:

```text
dist/MediTest-4.0.6/
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
2. nur den Zielordner `dist/MediTest-4.0.6/` entfernen
3. `dotnet restore`
4. `dotnet build --configuration Release`
5. self-contained Publish für `win-x64`, `osx-x64` und `osx-arm64`
6. Debug-Symbole, XML-Dokumentation, lokale Daten und temporäre Dateien aus den Publish-Ordnern entfernen
7. Windows-Portable-ZIP erzeugen
8. Windows-MSI mit WiX erzeugen, inklusive MediTest-Design und `assets/LicenseAgreement.rtf`
9. macOS-Setup-ZIPs je Architektur erzeugen, jeweils mit `MediTest.app` und Installer-Skript
10. Dokumentation in das Release kopieren
11. `SHA256SUMS.txt` erzeugen

## Erwartete Artefakte

```text
dist/MediTest-4.0.6/windows/MediTest-Setup-4.0.6-win-x64.msi
dist/MediTest-4.0.6/windows/MediTest-4.0.6-win-x64-portable.zip
dist/MediTest-4.0.6/macos/MediTest-4.0.6-macos-x64-setup.zip
dist/MediTest-4.0.6/macos/MediTest-4.0.6-macos-arm64-setup.zip
dist/MediTest-4.0.6/latest.json
dist/MediTest-4.0.6/SHA256SUMS.txt
```

Wenn das Skript auf macOS mit verfügbarem `pkgbuild` läuft, werden zusätzlich native `.pkg`-Dateien erzeugt.

Die macOS-Setup-ZIPs enthalten jeweils:

```text
MediTest-4.0.6-macos-<arch>/
  Install_MediTest_macOS.command
  MediTest.app/
```

## GitHub Releases

Für GitHub-Releases kann das Release-Skript direkt passende Download-URLs in `latest.json` schreiben:

```powershell
cd MediTest
powershell -ExecutionPolicy Bypass -File .\scripts\build-release.ps1 -GitHubRepository "automationTurtle95/MediTest"
```

Danach in GitHub einen Release mit dem Tag `v4.0.6` erstellen und folgende Dateien hochladen:

```text
dist/MediTest-4.0.6/windows/MediTest-Setup-4.0.6-win-x64.msi
dist/MediTest-4.0.6/windows/MediTest-4.0.6-win-x64-portable.zip
dist/MediTest-4.0.6/macos/MediTest-4.0.6-macos-arm64-setup.zip
dist/MediTest-4.0.6/macos/MediTest-4.0.6-macos-x64-setup.zip
dist/MediTest-4.0.6/latest.json
dist/MediTest-4.0.6/SHA256SUMS.txt
```

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
git tag v4.0.6
git push origin main
git push origin v4.0.6
```

Der Workflow prüft, dass der Git-Tag zur Projektversion passt, baut die Artefakte und lädt sie in den GitHub Release hoch. Beim Build wird die veröffentlichte App automatisch auf `Updates:GitHubRepository = automationTurtle95/MediTest` konfiguriert.

## Release-Regeln

- Keine `.pdb`-Dateien im Release.
- Keine lokale `meditest.db` im Release.
- Keine lokalen API-Key- oder Secret-Dateien im Release.
- Keine alten `release/v2.0`- oder `1.0.0`-Artefakte im Projekt.
- `dist/MediTest-2.0.0/` bleibt als stabile V2-Linie erhalten.
- Versionsnummern in `.csproj`, MSI und Dateinamen müssen übereinstimmen.
- Für neue Features immer die `<Version>` in `MediTest.csproj` erhöhen; das Release-Skript übernimmt diese Version automatisch.
- Das MSI enthält ein Major-Upgrade mit konstantem `UpgradeCode`, damit eine neuere Version über eine bestehende Installation installiert werden kann.
- Private Nutzerdaten werden unter `users/{uid}/...` in Firestore gespeichert; der Katalog liegt getrennt in `catalogTests`.

## Nach dem Build prüfen

```powershell
Get-ChildItem .\dist\MediTest-4.0.6 -Recurse -File |
  Where-Object { $_.Name -match '\.pdb$|OPENAI_API_KEY|meditest\.db|start-name\.json' }
```

Die Ausgabe muss leer sein.

```powershell
Get-FileHash -Algorithm SHA256 .\dist\MediTest-4.0.6\windows\MediTest-Setup-4.0.6-win-x64.msi
```

Der Hash muss mit dem Eintrag in `SHA256SUMS.txt` übereinstimmen.
