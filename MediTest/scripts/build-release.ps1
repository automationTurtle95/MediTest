param(
    [string]$Version = "",
    [string]$Configuration = "Release",
    [string]$GitHubRepository = "",
    [string]$ReleaseBaseUrl = "",
    [switch]$WindowsOnly
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$ProjectFile = Join-Path $ProjectRoot "MediTest.csproj"
$DistRoot = Join-Path $ProjectRoot "dist"
$DocsSource = Join-Path $ProjectRoot "docs"
$IconSource = Join-Path $ProjectRoot "assets\MediTest.ico"
$LicenseSource = Join-Path $ProjectRoot "assets\LicenseAgreement.rtf"
if ([string]::IsNullOrWhiteSpace($Version)) {
    [xml]$projectXml = Get-Content -LiteralPath $ProjectFile
    $Version = [string]($projectXml.Project.PropertyGroup | Select-Object -First 1).Version
}
if ([string]::IsNullOrWhiteSpace($Version)) {
    throw "Keine Version angegeben und keine <Version> in $ProjectFile gefunden."
}

$ReleaseRoot = Join-Path $DistRoot "MediTest-$Version"

function Invoke-Step([string]$Message) {
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Remove-IfExists([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    }
}

function Invoke-Native([string]$FilePath, [string[]]$Arguments) {
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath ist mit Exit-Code $LASTEXITCODE fehlgeschlagen"
    }
}

function Ensure-WixUiExtension {
    $extensions = & wix extension list --global 2>$null
    if ($LASTEXITCODE -ne 0 -or ($extensions -notmatch "WixToolset.UI.wixext")) {
        Invoke-Native "wix" @("extension", "add", "--global", "WixToolset.UI.wixext/5.0.2")
    }
}

function Clean-PublishOutput([string]$AppPath) {
    Get-ChildItem -LiteralPath $AppPath -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in ".pdb", ".xml", ".dbg" } |
        Remove-Item -Force

    foreach ($name in @("start-name.json", "meditest.db", "OPENAI_API_KEY.txt", "GEMINI_API_KEY.txt", "web.config")) {
        $path = Join-Path $AppPath $name
        if (Test-Path -LiteralPath $path) {
            Remove-Item -LiteralPath $path -Force
        }
    }
}

function Set-ReleaseUpdateConfig([string]$AppPath) {
    if ([string]::IsNullOrWhiteSpace($GitHubRepository) -and [string]::IsNullOrWhiteSpace($ReleaseBaseUrl)) {
        return
    }

    $configPath = Join-Path $AppPath "appsettings.json"
    if (!(Test-Path -LiteralPath $configPath)) {
        return
    }

    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    if ($null -eq $config.PSObject.Properties["Updates"]) {
        $config | Add-Member -NotePropertyName "Updates" -NotePropertyValue ([pscustomobject]@{})
    }

    $updates = $config.Updates
    foreach ($name in @("Enabled", "GitHubRepository", "ManifestUrl")) {
        if ($null -eq $updates.PSObject.Properties[$name]) {
            $updates | Add-Member -NotePropertyName $name -NotePropertyValue ""
        }
    }

    $updates.Enabled = $true
    if (![string]::IsNullOrWhiteSpace($GitHubRepository)) {
        $updates.GitHubRepository = $GitHubRepository.Trim().Trim('/')
        $updates.ManifestUrl = ""
    }
    elseif (![string]::IsNullOrWhiteSpace($ReleaseBaseUrl)) {
        $updates.GitHubRepository = ""
        $updates.ManifestUrl = "$($ReleaseBaseUrl.TrimEnd('/'))/latest.json"
    }

    $json = $config | ConvertTo-Json -Depth 20
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($configPath, $json, $utf8NoBom)
}

function Publish-App([string]$Runtime, [string]$OutputPath) {
    Remove-IfExists $OutputPath
    Invoke-Native "dotnet" @(
        "publish", $ProjectFile,
        "--configuration", $Configuration,
        "--runtime", $Runtime,
        "--self-contained", "true",
        "--output", $OutputPath,
        "-p:Version=$Version",
        "-p:AssemblyVersion=${Version}.0",
        "-p:FileVersion=${Version}.0",
        "-p:InformationalVersion=$Version",
        "-p:DebugType=none",
        "-p:DebugSymbols=false",
        "-p:PublishReadyToRun=false"
    )

    Clean-PublishOutput $OutputPath
    Set-ReleaseUpdateConfig $OutputPath
}

function Get-HashId([string]$Prefix, [string]$Value) {
    $sha1 = [System.Security.Cryptography.SHA1]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
        $hash = $sha1.ComputeHash($bytes)
        $hex = -join ($hash | ForEach-Object { $_.ToString("x2") })
        return "$Prefix$($hex.Substring(0, 12))"
    }
    finally {
        $sha1.Dispose()
    }
}

function Escape-Xml([string]$Value) {
    return [System.Security.SecurityElement]::Escape($Value)
}

function New-WixBitmap([string]$OutputFile, [int]$Width, [int]$Height, [bool]$IsBanner) {
    Add-Type -AssemblyName System.Drawing

    $bitmap = New-Object System.Drawing.Bitmap($Width, $Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

    $bg = [System.Drawing.ColorTranslator]::FromHtml("#f1f7f8")
    $field = [System.Drawing.ColorTranslator]::FromHtml("#f7faf9")
    $text = [System.Drawing.ColorTranslator]::FromHtml("#132f30")
    $muted = [System.Drawing.ColorTranslator]::FromHtml("#617a7a")
    $primary = [System.Drawing.ColorTranslator]::FromHtml("#0b3b3c")
    $primaryDark = [System.Drawing.ColorTranslator]::FromHtml("#176467")
    $border = [System.Drawing.ColorTranslator]::FromHtml("#dce9e6")

    try {
        $graphics.Clear($bg)
        $rect = New-Object System.Drawing.Rectangle(0, 0, $Width, $Height)
        $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $field, $bg, 35)
        $graphics.FillRectangle($brush, $rect)
        $brush.Dispose()

        $primaryBrush = New-Object System.Drawing.SolidBrush($primary)
        $primaryDarkBrush = New-Object System.Drawing.SolidBrush($primaryDark)
        $textBrush = New-Object System.Drawing.SolidBrush($text)
        $mutedBrush = New-Object System.Drawing.SolidBrush($muted)
        $borderPen = New-Object System.Drawing.Pen($border, 1)

        if ($IsBanner) {
            $graphics.Clear([System.Drawing.Color]::White)
            $graphics.FillRectangle($primaryBrush, $Width - 84, 0, 84, $Height)
            $graphics.FillEllipse($primaryDarkBrush, $Width - 118, -34, 92, 92)
            $graphics.DrawLine($borderPen, 0, $Height - 1, $Width, $Height - 1)
        }
        else {
            $leftWidth = 164
            $graphics.FillRectangle($primaryBrush, 0, 0, $leftWidth, $Height)
            $graphics.SetClip((New-Object System.Drawing.Rectangle(0, 0, $leftWidth, $Height)))
            $graphics.FillEllipse($primaryDarkBrush, 94, 42, 96, 96)
            $graphics.FillEllipse($primaryBrush, 24, 222, 72, 72)
            $graphics.ResetClip()
            $graphics.DrawLine($borderPen, $leftWidth, 0, $leftWidth, $Height)

            $brandFont = New-Object System.Drawing.Font("Segoe UI", 20, [System.Drawing.FontStyle]::Bold)
            $bodyFont = New-Object System.Drawing.Font("Segoe UI", 8.5, [System.Drawing.FontStyle]::Regular)
            $smallFont = New-Object System.Drawing.Font("Segoe UI", 7.5, [System.Drawing.FontStyle]::Regular)
            $whiteBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
            $graphics.DrawString("MediTest", $brandFont, $whiteBrush, 22, 44)
            $graphics.DrawString("MC-Training", $bodyFont, $whiteBrush, 24, 84)
            $graphics.DrawString("lokal und prüfungsnah", $smallFont, $whiteBrush, 24, 105)
            $brandFont.Dispose(); $bodyFont.Dispose(); $smallFont.Dispose(); $whiteBrush.Dispose()
        }

        $primaryBrush.Dispose(); $primaryDarkBrush.Dispose(); $textBrush.Dispose(); $mutedBrush.Dispose(); $borderPen.Dispose()
        $bitmap.Save($OutputFile, [System.Drawing.Imaging.ImageFormat]::Bmp)
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function New-WixThemeAssets([string]$OutputDir) {
    if (!(Test-Path -LiteralPath $LicenseSource)) {
        throw "LicenseAgreement-Datei fehlt: $LicenseSource"
    }

    $assetsDir = Join-Path $OutputDir "installer-assets"
    Remove-IfExists $assetsDir
    New-Item -ItemType Directory -Force -Path $assetsDir | Out-Null

    $license = Join-Path $assetsDir "LicenseAgreement.rtf"
    $dialog = Join-Path $assetsDir "MediTest-dialog.bmp"
    $banner = Join-Path $assetsDir "MediTest-banner.bmp"

    Copy-Item -LiteralPath $LicenseSource -Destination $license -Force
    New-WixBitmap $dialog 493 312 $false
    New-WixBitmap $banner 493 58 $true

    return @{
        License = $license
        Dialog = $dialog
        Banner = $banner
    }
}

function Get-RelativePath([string]$BasePath, [string]$TargetPath) {
    $baseFull = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $targetFull = [System.IO.Path]::GetFullPath($TargetPath)
    $baseUri = New-Object System.Uri($baseFull)
    $targetUri = New-Object System.Uri($targetFull)
    return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace('/', '\')
}

function New-WixSource([string]$AppSource, [string]$OutputFile, [string]$LicenseFile, [string]$DialogBitmap, [string]$BannerBitmap) {
    $components = New-Object System.Collections.Generic.List[string]
    $componentIds = New-Object System.Collections.Generic.List[string]

    function Write-DirectoryTree([string]$AbsolutePath, [string]$DirectoryId) {
        $content = New-Object System.Text.StringBuilder
        $entries = Get-ChildItem -LiteralPath $AbsolutePath -Force |
            Sort-Object @{ Expression = { -not $_.PSIsContainer } }, Name

        foreach ($entry in $entries) {
            if ($entry.PSIsContainer) {
                $relDir = Get-RelativePath $AppSource $entry.FullName
                $dirId = Get-HashId "D" $relDir
                [void]$content.AppendLine("<Directory Id=""$dirId"" Name=""$(Escape-Xml $entry.Name)"">")
                [void]$content.Append((Write-DirectoryTree $entry.FullName $dirId))
                [void]$content.AppendLine("</Directory>")
                continue
            }

            $rel = Get-RelativePath $AppSource $entry.FullName
            $componentId = Get-HashId "C" $rel
            $fileId = Get-HashId "F" $rel
            $source = '$(var.AppSource)\' + $rel
            $components.Add("<Component Id=""$componentId"" Directory=""$DirectoryId"" Guid=""*""><File Id=""$fileId"" Source=""$(Escape-Xml $source)"" KeyPath=""yes"" /></Component>")
            $componentIds.Add($componentId)
        }

        return $content.ToString()
    }

    $directoryTree = Write-DirectoryTree $AppSource "INSTALLFOLDER"
    $componentXml = [string]::Join("`n    ", $components)
    $componentRefs = [string]::Join("`n      ", ($componentIds | ForEach-Object { "<ComponentRef Id=""$_"" />" }))
    $upgradeCode = "{8D6FA9D4-2D0D-4F7A-A650-69836D13A8C2}"

    $wxs = @"
<Wix xmlns="http://wixtoolset.org/schemas/v4/wxs" xmlns:ui="http://wixtoolset.org/schemas/v4/wxs/ui">
  <Package Name="MediTest" Manufacturer="MediTest" Version="$Version" UpgradeCode="$upgradeCode" Scope="perUser">
    <MajorUpgrade AllowSameVersionUpgrades="yes" DowngradeErrorMessage="Eine neuere Version von MediTest ist bereits installiert." />
    <MediaTemplate EmbedCab="yes" />
    <Icon Id="MediTestIcon" SourceFile="`$(var.AppSource)\MediTest.ico" />
    <Property Id="ARPPRODUCTICON" Value="MediTestIcon" />
    <ui:WixUI Id="WixUI_InstallDir" InstallDirectory="INSTALLFOLDER" />
    <WixVariable Id="WixUILicenseRtf" Value="$(Escape-Xml $LicenseFile)" />
    <WixVariable Id="WixUIDialogBmp" Value="$(Escape-Xml $DialogBitmap)" />
    <WixVariable Id="WixUIBannerBmp" Value="$(Escape-Xml $BannerBitmap)" />

    <StandardDirectory Id="LocalAppDataFolder">
      <Directory Id="ProgramsDir" Name="Programs">
        <Directory Id="INSTALLFOLDER" Name="MediTest">
$directoryTree
        </Directory>
      </Directory>
    </StandardDirectory>

    <StandardDirectory Id="DesktopFolder">
      <Component Id="DesktopShortcutComponent" Guid="{E379973D-12BB-4F70-B453-01AA4AB7903E}">
        <Shortcut Id="DesktopShortcut" Name="MediTest" Target="[INSTALLFOLDER]MediTest.exe" WorkingDirectory="INSTALLFOLDER" Icon="MediTestIcon" />
        <RegistryValue Root="HKCU" Key="Software\MediTest" Name="DesktopShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </StandardDirectory>

    <StandardDirectory Id="ProgramMenuFolder">
      <Component Id="StartMenuShortcutComponent" Guid="{B0AF72D2-EC03-47DE-9C62-F8E77692E5EE}">
        <Shortcut Id="StartMenuShortcut" Name="MediTest" Target="[INSTALLFOLDER]MediTest.exe" WorkingDirectory="INSTALLFOLDER" Icon="MediTestIcon" />
        <RemoveFolder Id="RemoveStartMenuShortcutComponent" On="uninstall" />
        <RegistryValue Root="HKCU" Key="Software\MediTest" Name="StartMenuShortcut" Type="integer" Value="1" KeyPath="yes" />
      </Component>
    </StandardDirectory>

    $componentXml

    <Feature Id="MainFeature" Title="MediTest" Level="1">
      $componentRefs
      <ComponentRef Id="DesktopShortcutComponent" />
      <ComponentRef Id="StartMenuShortcutComponent" />
    </Feature>
  </Package>
</Wix>
"@

    Set-Content -LiteralPath $OutputFile -Value $wxs -Encoding UTF8
}

function New-MacInstaller([string]$OutputFile, [string]$Runtime) {
    $script = @"
#!/bin/bash
set -euo pipefail

APPNAME="MediTest"
SCRIPT_DIR="`$(cd "`$(dirname "`$0")" && pwd)"
SRC_APP="`$SCRIPT_DIR/MediTest.app"
TARGET_DIR="`$HOME/Applications"
TARGET_APP="`$TARGET_DIR/MediTest.app"
DESKTOP_APP="`$HOME/Desktop/MediTest.app"

echo "Installiere `$APPNAME ($Runtime) ..."

if [ ! -d "`$SRC_APP/Contents/Resources/app" ]; then
  echo "FEHLER: App-Bundle nicht gefunden: `$SRC_APP"
  exit 1
fi

mkdir -p "`$TARGET_DIR"

rm -rf "`$TARGET_APP"
cp -R "`$SRC_APP" "`$TARGET_APP"

chmod +x "`$TARGET_APP/Contents/MacOS/MediTest"
chmod +x "`$TARGET_APP/Contents/Resources/app/MediTest"

if [ -d "`$HOME/Desktop" ]; then
  if [ -L "`$DESKTOP_APP" ]; then
    rm "`$DESKTOP_APP"
  fi
  if [ ! -e "`$DESKTOP_APP" ]; then
    ln -s "`$TARGET_APP" "`$DESKTOP_APP"
  fi
fi

echo "Fertig. Starte MediTest ..."
open "`$TARGET_APP"
"@

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($OutputFile, $script, $utf8NoBom)
}

function New-MacAppLauncher([string]$OutputFile) {
    $script = @'
#!/bin/bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
APP_EXE="$APP_DIR/MediTest"

chmod +x "$APP_EXE" 2>/dev/null || true

cd "$APP_DIR"
export ASPNETCORE_URLS="${ASPNETCORE_URLS:-http://127.0.0.1:55000}"
export DOTNET_URLS="${DOTNET_URLS:-http://127.0.0.1:55000}"
exec "$APP_EXE"
'@

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($OutputFile, $script, $utf8NoBom)
}

function New-MacInfoPlist([string]$OutputFile, [string]$Runtime) {
    $plist = @"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>de</string>
  <key>CFBundleDisplayName</key>
  <string>MediTest</string>
  <key>CFBundleExecutable</key>
  <string>MediTest</string>
  <key>CFBundleIdentifier</key>
  <string>de.meditest.app.$($Runtime.Replace("-", "."))</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>MediTest</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>$Version</string>
  <key>CFBundleVersion</key>
  <string>$Version</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
"@

    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($OutputFile, $plist, $utf8NoBom)
}

function New-MacAppBundle([string]$BundlePath, [string]$AppSource, [string]$Runtime) {
    Remove-IfExists $BundlePath

    $contents = Join-Path $BundlePath "Contents"
    $macos = Join-Path $contents "MacOS"
    $resources = Join-Path $contents "Resources"
    $appResources = Join-Path $resources "app"

    New-Item -ItemType Directory -Force -Path $macos, $resources | Out-Null
    Copy-Item -LiteralPath $AppSource -Destination $appResources -Recurse -Force

    New-MacAppLauncher (Join-Path $macos "MediTest")
    New-MacInfoPlist (Join-Path $contents "Info.plist") $Runtime
}

function Compress-FolderContents([string]$SourceFolder, [string]$DestinationZip) {
    Compress-Folder $SourceFolder $DestinationZip $false
}

function Compress-FolderWithRoot([string]$SourceFolder, [string]$DestinationZip) {
    Compress-Folder $SourceFolder $DestinationZip $true
}

function Compress-Folder([string]$SourceFolder, [string]$DestinationZip, [bool]$IncludeRoot) {
    Remove-IfExists $DestinationZip
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $sourceFull = [System.IO.Path]::GetFullPath($SourceFolder).TrimEnd('\', '/')
    $basePath = if ($IncludeRoot) { Split-Path -Parent $sourceFull } else { $sourceFull }
    $archive = [System.IO.Compression.ZipFile]::Open($DestinationZip, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        Get-ChildItem -LiteralPath $SourceFolder -Recurse -File -Force |
            Sort-Object FullName |
            ForEach-Object {
                $entryName = (Get-RelativePath $basePath $_.FullName).Replace('\', '/')
                [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                    $archive,
                    $_.FullName,
                    $entryName,
                    [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
            }
    }
    finally {
        $archive.Dispose()
    }
}

function Get-ReleaseDownloadUrl([string]$FileName) {
    if (![string]::IsNullOrWhiteSpace($ReleaseBaseUrl)) {
        return "$($ReleaseBaseUrl.TrimEnd('/'))/$FileName"
    }

    if (![string]::IsNullOrWhiteSpace($GitHubRepository)) {
        $repo = $GitHubRepository.Trim().Trim('/')
        return "https://github.com/$repo/releases/download/v$Version/$FileName"
    }

    return ""
}

function New-DownloadEntry([string]$Platform, [string]$RelativePath) {
    $path = Join-Path $ReleaseRoot $RelativePath
    if (!(Test-Path -LiteralPath $path)) {
        throw "Release-Artefakt fehlt: $path"
    }

    $item = Get-Item -LiteralPath $path
    return [ordered]@{
        platform = $Platform
        fileName = $item.Name
        url = Get-ReleaseDownloadUrl $item.Name
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash
        sizeBytes = $item.Length
    }
}

function New-UpdateManifest([string]$OutputFile) {
    $releaseUrl = ""
    if (![string]::IsNullOrWhiteSpace($GitHubRepository)) {
        $repo = $GitHubRepository.Trim().Trim('/')
        $releaseUrl = "https://github.com/$repo/releases/tag/v$Version"
    }

    $manifest = [ordered]@{
        version = $Version
        releaseDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
        releaseUrl = $releaseUrl
        notes = "MediTest $Version"
        downloads = [ordered]@{
            "windows-x64" = New-DownloadEntry "windows-x64" "windows/MediTest-Setup-$Version-win-x64.msi"
            "macos-arm64" = New-DownloadEntry "macos-arm64" "macos/MediTest-$Version-macos-arm64-setup.zip"
            "macos-x64" = New-DownloadEntry "macos-x64" "macos/MediTest-$Version-macos-x64-setup.zip"
        }
    }

    $json = $manifest | ConvertTo-Json -Depth 8
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($OutputFile, $json, $utf8NoBom)
}

Invoke-Step "Bereinige Ziel-Release-Ordner"
$distFull = [System.IO.Path]::GetFullPath($DistRoot)
$releaseFull = [System.IO.Path]::GetFullPath($ReleaseRoot)
if (!$releaseFull.StartsWith($distFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsicherer Release-Pfad: $ReleaseRoot"
}
Remove-IfExists $ReleaseRoot
New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null

Invoke-Step "Restore und Release-Build"
Invoke-Native "dotnet" @("restore", $ProjectFile)
Invoke-Native "dotnet" @("build", $ProjectFile, "--configuration", $Configuration, "--no-restore")

Invoke-Step "Publish Windows win-x64"
$WindowsDir = Join-Path $ReleaseRoot "windows"
$WindowsApp = Join-Path $WindowsDir "app"
Publish-App "win-x64" $WindowsApp
Copy-Item -LiteralPath $IconSource -Destination (Join-Path $WindowsApp "MediTest.ico") -Force

Invoke-Step "Erzeuge Windows Portable ZIP"
$WindowsZip = Join-Path $WindowsDir "MediTest-$Version-win-x64-portable.zip"
Compress-FolderContents $WindowsApp $WindowsZip

Invoke-Step "Erzeuge Windows MSI"
$WxsFile = Join-Path $WindowsDir "MediTest.wxs"
$MsiFile = Join-Path $WindowsDir "MediTest-Setup-$Version-win-x64.msi"
Ensure-WixUiExtension
$WixAssets = New-WixThemeAssets $WindowsDir
New-WixSource $WindowsApp $WxsFile $WixAssets.License $WixAssets.Dialog $WixAssets.Banner
Invoke-Native "wix" @("build", $WxsFile, "-ext", "WixToolset.UI.wixext", "-culture", "de-DE", "-d", "AppSource=$WindowsApp", "-o", $MsiFile)
Get-ChildItem -LiteralPath $WindowsDir -Filter *.wixpdb -File -ErrorAction SilentlyContinue |
    Remove-Item -Force

if (!$WindowsOnly) {
    Invoke-Step "Publish macOS x64 und arm64"
    $MacDir = Join-Path $ReleaseRoot "macos"
    foreach ($rid in @("osx-x64", "osx-arm64")) {
        $arch = $rid.Replace("osx-", "")
        $bundle = Join-Path $MacDir "MediTest-$Version-macos-$arch"
        $publish = Join-Path $bundle "publish"
        Publish-App $rid $publish
        New-MacAppBundle (Join-Path $bundle "MediTest.app") $publish $rid
        Remove-IfExists $publish
        $installer = Join-Path $bundle "Install_MediTest_macOS.command"
        New-MacInstaller $installer $rid
        $zip = Join-Path $MacDir "MediTest-$Version-macos-$arch-setup.zip"
        Compress-FolderWithRoot $bundle $zip
    }

    Write-Host ""
    Write-Host "Hinweis: Diese macOS-ZIPs sind nicht mit Apple Developer ID signiert oder notarisiert. Der GitHub-Release muss sie entsprechend kennzeichnen." -ForegroundColor Yellow
}

Invoke-Step "Entferne Packaging-Zwischenverzeichnisse"
Remove-IfExists $WindowsApp
Remove-IfExists $WxsFile
Remove-IfExists (Join-Path $WindowsDir "installer-assets")
if (!$WindowsOnly) {
    foreach ($rid in @("osx-x64", "osx-arm64")) {
        $arch = $rid.Replace("osx-", "")
        Remove-IfExists (Join-Path $MacDir "MediTest-$Version-macos-$arch")
    }
}

Invoke-Step "Kopiere Dokumentation"
$DistDocs = Join-Path $ReleaseRoot "docs"
New-Item -ItemType Directory -Force -Path $DistDocs | Out-Null
Copy-Item -LiteralPath (Join-Path $ProjectRoot "README.md") -Destination (Join-Path $DistDocs "README.md") -Force
if (Test-Path -LiteralPath $DocsSource) {
    Copy-Item -Path (Join-Path $DocsSource "*") -Destination $DistDocs -Recurse -Force
}

if (!$WindowsOnly) {
    Invoke-Step "Erzeuge Update-Manifest"
    New-UpdateManifest (Join-Path $ReleaseRoot "latest.json")
}

Invoke-Step "Erzeuge SHA256-Prüfsummen"
$ChecksumFile = Join-Path $ReleaseRoot "SHA256SUMS.txt"
Get-ChildItem -LiteralPath $ReleaseRoot -Recurse -File |
    Where-Object { $_.FullName -ne $ChecksumFile } |
    Sort-Object FullName |
    ForEach-Object {
        $rel = (Get-RelativePath $ReleaseRoot $_.FullName).Replace("\", "/")
        $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash
        "$hash  $rel"
    } | Set-Content -LiteralPath $ChecksumFile -Encoding ASCII

Invoke-Step "Bereinige Build-Zwischenprodukte"
Remove-IfExists (Join-Path $ProjectRoot "bin")
Remove-IfExists (Join-Path $ProjectRoot "obj")
Remove-IfExists (Join-Path $ProjectRoot ".wix")

Write-Host ""
Write-Host "Release fertig: $ReleaseRoot" -ForegroundColor Green
Get-ChildItem -LiteralPath $ReleaseRoot -Recurse -File |
    Where-Object { $_.Extension -in ".msi", ".zip", ".pkg", ".txt", ".json" } |
    Select-Object FullName, @{ Name = "SizeMB"; Expression = { [math]::Round($_.Length / 1MB, 2) } } |
    Format-Table -AutoSize
