# Meduvalo Branding

## Sichtbare Marke

- Produktname: Meduvalo
- Domain: `meduvalo.at`
- Website: `https://meduvalo.at`
- Claim: Prüfungsnah lernen. Sicherer bestehen.
- Alternativer Claim: Medizinfragen smart trainieren.
- Keine Dachmarke und keine zusätzlichen Markenhinweise

Die zentralen Laufzeitwerte liegen in `MediTest/Branding.cs`, in
`MediTest/wwwroot/js/api.js` unter `APP_BRAND`, in `landing-page/script.js`
unter `SITE_CONFIG` und in `firebase/functions/src/index.ts` unter `BRAND`.

## Technische Kompatibilität

Folgende bestehende technische Identitäten bleiben absichtlich erhalten:

- Firebase-Projekt-ID `meditest-12354`
- Firebase-Functions und Hosting-Rewrites mit Präfix `meditest`
- Firestore-Collections und bestehende Dokumentpfade
- C#-Namespaces, Projektordner, `MediTest.csproj` und Testprojekt
- EXE-, Bundle-, Release- und GitHub-Artefaktnamen
- Bundle-ID, MSI-Upgrade-Code, Installations- und Registry-Pfade
- lokale Daten-, Geräte-, Cache-, Session- und Data-Protection-Schlüssel
- bestehende Secret- und Umgebungsvariablennamen

Diese Namen sind nicht Teil der sichtbaren Produktmarke. Eine Änderung könnte
Updates, bestehende Installationen, Gerätekennungen, Sitzungen, Lizenzen oder
produktive Firebase-Daten entkoppeln.

## Hosting

Die Landingpage bleibt in `landing-page/`. Die vorhandene Datei
`firebase.hosting.json` veröffentlicht ausschließlich diesen Ordner über die
bestehende Firebase-Default-Site. Die Anwendung unter `MediTest/` wird nicht
in den Hosting-Upload kopiert.

Deployment aus dem Repository-Stamm:

```powershell
npx firebase-tools deploy --config firebase.hosting.json --only hosting --project meditest-12354
```

Für `meduvalo.at` sind die DNS-Einträge außerhalb des Repositories nach den
Vorgaben der Firebase Console zu setzen.
