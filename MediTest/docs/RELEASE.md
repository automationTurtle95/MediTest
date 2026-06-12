# Release-Prozess

Release-Titel und sichtbare Installer-Metadaten verwenden Meduvalo. Die
bestehenden technischen Artefaktnamen mit `MediTest` bleiben für Update-URLs,
GitHub Releases und bereits veröffentlichte Installationen kompatibel.

## Ziel

Version 5.0.4 wird als Windows-MSI, Windows-Portable-ZIP und zwei signierte, von Apple notarisierte macOS-PKGs veröffentlicht.

```text
dist/MediTest-5.0.4/
```

Lokale Datenbanken, API-Keys, Secrets, Debug-Symbole und temporäre Build-Dateien dürfen nicht in Release-Artefakte gelangen.

## Lokaler Windows-Build

```powershell
cd MediTest
powershell -ExecutionPolicy Bypass -File .\scripts\build-release.ps1 -WindowsOnly
```

Das Skript:

1. liest die Version aus `MediTest.csproj`,
2. führt Restore und Release-Build aus,
3. veröffentlicht `win-x64` self-contained,
4. entfernt Debug- und lokale Dateien,
5. erzeugt Portable-ZIP und MSI,
6. erstellt Prüfsummen und Update-Metadaten.

## Produktiver GitHub-Release

Der Workflow `.github/workflows/release.yml` baut:

```text
MediTest-Setup-5.0.4-win-x64.msi
MediTest-5.0.4-win-x64-portable.zip
MediTest-Setup-5.0.4-macos-arm64.pkg
MediTest-Setup-5.0.4-macos-x64.pkg
latest.json
SHA256SUMS.txt
```

Der macOS-Job:

1. prüft, dass alle Apple-Secrets vorhanden sind,
2. importiert `Developer ID Application` und `Developer ID Installer`,
3. validiert die Notarisierungs-Zugangsdaten,
4. baut beide Architekturen,
5. signiert alle Mach-O-Dateien mit Hardened Runtime,
6. erstellt und signiert PKGs direkt mit `pkgbuild`,
7. fragt Apples Notarisierungsstatus anhand der Submission-ID ab,
8. heftet die Tickets an und führt Gatekeeper-Prüfungen aus.

Fehlt ein Secret oder schlägt eine Apple-Prüfung fehl, wird der gesamte Release abgebrochen. Es gibt keinen unsignierten macOS-Fallback.

## Veröffentlichung

Vor dem Tag:

1. Versionsnummern und Release-Datum prüfen.
2. Tests und Builds erfolgreich ausführen.
3. Apple-Secrets nach [MACOS_SIGNING.md](MACOS_SIGNING.md) einrichten.
4. Änderungen committen und `main` pushen.

Danach:

```powershell
git tag v5.0.4
git push origin v5.0.4
```

Der Workflow prüft, dass Tag und Projektversion übereinstimmen, und erstellt erst nach erfolgreichen Windows- und macOS-Jobs den GitHub Release.

## Update-Prüfung

Die App liest standardmäßig den neuesten GitHub Release:

```json
{
  "Updates": {
    "Enabled": true,
    "GitHubRepository": "automationTurtle95/MediTest",
    "ManifestUrl": ""
  }
}
```

`latest.json` enthält die plattformspezifischen Download-URLs, Dateinamen, Dateigrößen und SHA-256-Hashes.

## Release-Regeln

- Keine `.pdb`, lokale Datenbank oder Secret-Datei im Release.
- Versionsnummern in `.csproj`, App-Konfiguration, Installer und Dateinamen müssen übereinstimmen.
- macOS-Kundenpakete sind ausschließlich signierte und notarisierte `.pkg`.
- Das Windows-MSI behält seinen konstanten `UpgradeCode`.
- Bestehende stabile Release-Archive werden nicht verändert.

## Kontrolle

```powershell
Get-ChildItem .\dist\MediTest-5.0.4 -Recurse -File |
  Where-Object { $_.Name -match '\.pdb$|OPENAI_API_KEY|meditest\.db|start-name\.json' }
```

Die Ausgabe muss leer sein. Anschließend die Hashes mit `SHA256SUMS.txt` vergleichen.
