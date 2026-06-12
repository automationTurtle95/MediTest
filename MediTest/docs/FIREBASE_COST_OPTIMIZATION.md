# Firebase-Kostensparkonzept

## Ziel

Firebase-Kosten sollen sinken, ohne Anmeldung, Lizenzprüfung, Katalog, KI-Funktionen oder die wahrgenommene Geschwindigkeit von Meduvalo zu verschlechtern. Optimiert wird deshalb zuerst bei mehrfachen Reads, unnötigen Writes und ungebremsten Funktionsaufrufen. Nutzerdaten und sicherheitsrelevante Prüfungen bleiben serverseitig autoritativ.

## Priorität 1: Reads im Desktop-Client bündeln

Der Client lädt auf mehreren Seiten Profil, Lizenzstatus und Legal-/Lizenzstatus. Diese Daten ändern sich innerhalb einer Sitzung selten.

- Profil und statische App-Konfiguration für die laufende Sitzung im vorhandenen `sessionStorage` halten.
- Lizenzstatus mit einer kurzen Laufzeit von 2 bis 5 Minuten cachen.
- Den Cache sofort verwerfen nach Kauf, Code-Einlösung, Abo-Änderung, Profiländerung oder manueller Lizenzprüfung.
- Parallel gestartete identische Requests über ein gemeinsames Promise zusammenführen.
- Legal- und Lizenzstatus mittelfristig in einen Bootstrap-Endpunkt bündeln, damit der Programmstart nur einen geschützten Request benötigt.

Erwarteter Effekt: deutlich weniger Firestore-Reads und Functions-Aufrufe bei Seitenwechseln, ohne spürbare Verzögerung.

## Priorität 2: Writes nur bei echten Änderungen

- Einstellungen nur schreiben, wenn sich der normalisierte Inhalt tatsächlich geändert hat.
- Feedback, Zustimmung und Profilabschluss jeweils als einzelnes idempotentes Dokument beziehungsweise als ein Update speichern.
- Keine `lastSeen`- oder Aktivitäts-Writes bei jedem Seitenwechsel.
- Nutzungszähler für KI nicht pro UI-Aktion, sondern ausschließlich für tatsächlich ausgeführte KI-Requests aktualisieren.

Erwarteter Effekt: weniger Firestore-Writes und geringere Konfliktwahrscheinlichkeit.

## Priorität 3: Cloud Functions begrenzen

- Für jede öffentliche Funktion `maxInstances` festlegen; KI- und Stripe-Funktionen getrennt dimensionieren.
- `minInstances` bei selten genutzten Funktionen auf `0` lassen.
- Harte nutzerbezogene Tages- und Monatslimits für KI beibehalten.
- Request-Größe, Frageanzahl und Laufzeit serverseitig begrenzen.
- Wiederholte identische KI-Anfragen über einen Hash aus Nutzer, Modell und normalisiertem Inhalt kurzzeitig deduplizieren.
- Stripe-Webhooks idempotent über Event-ID verarbeiten, damit Wiederholungen keine zusätzlichen Schreibketten auslösen.

Empfohlene Startwerte:

| Funktionsgruppe | minInstances | maxInstances | Bemerkung |
| --- | ---: | ---: | --- |
| Auth, Profil, Lizenzstatus | 0 | 5 | kurze Requests, Client-Cache davor |
| Stripe Checkout und Portal | 0 | 3 | seltene interaktive Aufrufe |
| Stripe Webhook | 0 | 5 | idempotent, kurze Verarbeitung |
| KI-Fragengenerierung | 0 | 3 | Nutzerlimits und 300-Sekunden-Timeout |
| Katalog-Lesezugriffe | 0 | 5 | Ergebnisse clientseitig cachen |

## Priorität 4: Firestore-Datenmodell

- Große Dokumenttexte weiterhin in Chunks speichern und nur laden, wenn sie wirklich benötigt werden.
- Listenansichten ausschließlich aus kleinen Metadokumenten bedienen.
- Fragen und Testergebnisse paginiert beziehungsweise gezielt laden.
- Keine ungebremsten Collection-Scans; Abfragen benötigen feste Filter und Limits.
- Für Katalogdaten, die für alle Nutzer gleich sind, Hosting/CDN oder versionierte JSON-Dateien prüfen. Käufe und Berechtigungen bleiben in Firestore.

## Priorität 5: Hosting und statische Inhalte

- CSS, JavaScript, Icons und unveränderliche Katalog-Metadaten mit langen Cache-Headern und Dateiversionen ausliefern.
- HTML kurz cachen, damit Releases schnell sichtbar bleiben.
- Downloads ausschließlich über GitHub Releases ausliefern; Firebase Hosting soll keine großen Installer übertragen.

## Monitoring und Kostenbremse

- Budgetwarnungen bei 50, 80 und 100 Prozent des Monatsbudgets einrichten.
- Cloud-Monitoring-Alarme für Functions-Aufrufe, Fehlerquote, Laufzeit und Firestore-Reads aktivieren.
- Wöchentlich die fünf teuersten Funktionen und Firestore-Abfragen prüfen.
- App Check für öffentliche Web-Endpunkte einführen, sobald Desktop- und Website-Flows verlässlich attestiert werden können.
- Quotas niemals als einzige Sicherheitsgrenze verwenden; nutzerbezogene Limits bleiben im Anwendungscode.

## Empfohlene Umsetzung

1. Gemeinsamen 2- bis 5-Minuten-Cache für Lizenz- und Bootstrapdaten ergänzen.
2. Identische parallele Requests deduplizieren.
3. `maxInstances` pro Functions-Gruppe setzen und mit realen Lastdaten feinjustieren.
4. Firestore-Metriken zwei Wochen beobachten.
5. Erst danach Katalogdaten in statische versionierte Dateien verschieben, falls deren Reads weiterhin relevant sind.

Diese Reihenfolge spart früh Kosten, verändert aber weder Authentifizierung noch Lizenzsicherheit und hält häufig benötigte Daten im Arbeitsspeicher beziehungsweise Sitzungscache nahe am Nutzer.
