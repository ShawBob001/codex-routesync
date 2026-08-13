[English](./README.md) | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md)

# Codex RouteSync

**Wechsle nahtlos zwischen gespeicherten Codex-Konten und Responses-kompatiblen API-Anbietern, behalte den lokalen Gesprächsverlauf in beiden Modi und sieh die lokale Token-Nutzung für jede Auswahl.**

Codex RouteSync aktualisiert Anmeldedaten und Anbieter-Routing in einem abgesicherten Wechselvorgang. Der Kontomodus und der kompatible API-Anbietermodus verwenden denselben lokalen Verlaufsspeicher. Wenn sich die Codex-Authentifizierung ändert, werden neue Gespräche daher nicht auf verschiedene Zeitleisten verteilt.

Die VS Code-Erweiterung öffnet im Editorbereich ein grafisches Dashboard für den aktiven Modus, den Status des gemeinsamen Verlaufs, die Rücksetzzeiten der Kontokontingente und die gesamte lokale Token-Nutzung. Gespeicherte Konten und API-Anbieter stehen gemeinsam in einer flachen Routenliste. Die Token-Details enthalten ein Quellen-Ringdiagramm, während das orange Verlaufsdiagramm lokale Beobachtungen nach Tag, Woche oder Monat gruppiert. Das Dashboard kann der Anzeigesprache von VS Code folgen oder sofort zwischen Englisch und vereinfachtem Chinesisch wechseln.

## Nutzungsvorschau

Beim Öffnen der Aktivitätsleistenansicht **Codex RouteSync** stehen gespeicherte Konten und API-Anbieter auf derselben Ebene in einer flachen Liste **Accounts & API Routes**. Gleichzeitig wird das Dashboard automatisch geöffnet oder in den Vordergrund gebracht. In der Routenliste verwaltest du Konten und APIs. Das breite Dashboard zeigt Kontingente, Rücksetzzeiten, den automatischen Wechsel und den lokalen Token-Verlauf.

![Codex RouteSync-Dashboard auf Englisch im dunklen Design](./assets/screenshots/dashboard-en-dark.png)

Dasselbe Dashboard kann sofort auf vereinfachtes Chinesisch umgestellt werden:

![Codex RouteSync-Dashboard auf vereinfachtem Chinesisch im hellen Design](./assets/screenshots/dashboard-zh-light.png)

Codex RouteSync läuft unter Windows, macOS und Linux. Du kannst es in VS Code oder über die Befehlszeile verwenden.

[![GitHub-Release](https://img.shields.io/github/v/release/ShawBob001/codex-routesync)](https://github.com/ShawBob001/codex-routesync/releases)
[![Visual Studio Marketplace](https://img.shields.io/badge/VS%20Code%20Marketplace-install-007ACC)](https://marketplace.visualstudio.com/items?itemName=ShawBob001.codex-routesync)
[![Lizenz: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

## Zwei Modi, ein lokaler Gesprächsverlauf

```text
Codex-Kontomodus  <->  Codex RouteSync  <->  Responses-API-Anbietermodus
                               |
                    gemeinsamer Verlauf unter CODEX_HOME
```

| Funktion | Verhalten von RouteSync |
| --- | --- |
| Konto- und API-Wechsel | Wendet die Anmeldedaten des ausgewählten Kontos oder das API-Anbieterprofil zusammen mit der passenden Codex-Konfiguration an |
| Gemeinsamer Gesprächsverlauf | Hält neue lokale Threads durch einen gemeinsamen Codex-Verlaufsspeicher in beiden Modi sichtbar |
| Lokale Token-Nutzung | Indiziert Codex-Rollout-Zähler lokal, zeichnet tägliche, wöchentliche oder monatliche Aktivität auf und schlüsselt die erfasste Nutzung nach gespeichertem Konto oder API-Anbieter auf |
| Zustandssicherung | Speichert die Anmeldedaten des bisherigen Kontos oder Anbieters, bevor der nächste Modus angewendet wird |
| Sichere Übergänge | Führt gleichzeitige Wechsel nacheinander aus, schreibt Authentifizierungsdaten atomar und bewahrt Sicherungen für eine Wiederherstellung auf |
| Neuladen | Zeigt standardmäßig eine nicht blockierende Aktion zum Neuladen, wenn die Codex-Erweiterung den neuen Authentifizierungsstatus einlesen muss |

> Der gemeinsame Gesprächsverlauf gilt lokal für ein einzelnes `CODEX_HOME`. Er kopiert oder vereint weder den ChatGPT-Webverlauf noch Codex Cloud-Aufgaben, Konnektoren, Kontingente oder Gesprächsverläufe zwischen Geräten.

## Schnellstart

### VS Code-Erweiterung

Installiere die Erweiterung über ihre [Visual Studio Marketplace-Seite](https://marketplace.visualstudio.com/items?itemName=ShawBob001.codex-routesync), oder öffne die Erweiterungsansicht in VS Code und suche nach `Codex RouteSync`.

Für eine Offline-Installation lädst du die neueste `.vsix`-Datei von den [GitHub-Releases](https://github.com/ShawBob001/codex-routesync/releases) herunter und führst anschließend **Extensions: Install from VSIX...** aus. Alternativ kannst du den folgenden Befehl im Terminal verwenden. Ersetze VERSION durch die Version im Namen der heruntergeladenen Datei.

```bash
code --install-extension codex-routesync-VERSION.vsix
```

#### Von der vorherigen Marketplace-Version migrieren

Wenn du Codex SwitchBridge über eine frühere Marketplace-Version installiert hast, öffne zuerst die vorherige Installation und verschiebe alle synchronisierten oder in der Cloud gespeicherten Konten und API-Anbieter nach **Local**. Deaktiviere oder deinstalliere danach diese Installation, führe **Developer: Reload Window** aus, installiere Codex RouteSync über den obigen Link und gib das Speicherpasswort erneut ein.

Konten, API-Anbieter, Konfigurationsdateien, Sicherungen und der gemeinsame Verlauf im konfigurierten `CODEX_HOME` bleiben verfügbar. Vorhandene `codex-switchbridge.*`-Einstellungen gelten ebenfalls weiterhin. Die beiden Marketplace-Versionen verwenden unterschiedliche Erweiterungs-IDs. Deshalb werden `globalState`, `SecretStorage` und die gespeicherte Nutzungszuordnung pro Route aus der vorherigen Installation nicht automatisch migriert.

Öffne die Aktivitätsleistenansicht **Codex RouteSync**. Die flache Liste **Accounts & API Routes** zeigt gespeicherte Konten und API-Anbieter im selben Verzeichnis der Seitenleiste. Das Dashboard wird automatisch im zentralen Editorbereich geöffnet oder wieder in den Vordergrund gebracht. Die Aktion **Open Dashboard** in der Titelleiste bleibt als Ausweichmöglichkeit verfügbar.

### CLI

Installiere das CLI-Archiv aus einem GitHub-Release:

```bash
npm install --global ./codex-switchbridge-cli-0.3.0.tgz
codex-switchbridge --version
```

Nach der Veröffentlichung auf npm kannst du dasselbe Paket aus der Registry installieren:

```bash
npm install --global codex-switchbridge-cli
```

## Zwischen Konten und API-Anbietern wechseln

Verwende in VS Code **Switch Account** oder **Switch API Provider**. RouteSync speichert die aktuelle Auswahl, aktualisiert `auth.json` und `config.toml` und lädt danach die Konto- und Anbieteransichten neu.

Über die CLI:

```bash
# Zu einem gespeicherten Codex-Konto wechseln
codex-switchbridge use work

# Zu einem gespeicherten, Responses-kompatiblen API-Anbieter wechseln
# Der gemeinsame lokale Verlauf ist standardmäßig aktiviert
codex-switchbridge mode team-api

# Einen anbieterspezifischen Verlauf beibehalten, wenn dies für die Kompatibilität erforderlich ist
codex-switchbridge mode team-api --separate-history
```

Mit `codex-switchbridge use <name>` kehrst du zu einem benannten Konto zurück. Wenn `mode account` genau ein gespeichertes Konto erkennt, wird dieses Konto wiederhergestellt. Sind mehrere Konten gespeichert, fordert dich die CLI mit `use <name>` zur Auswahl auf, statt ein Konto zu erraten.

Ein API-Anbieterprofil speichert die Authentifizierungsdaten für `auth.json` und die Anbieterkonfiguration für `config.toml`. Für den gemeinsamen Verlauf sind `wire_api = "responses"` und eine gültige `base_url` des Anbieters erforderlich.

## Editor-Dashboard, Kontingent-Rücksetzzeit und lokale Token-Nutzung

Das VS Code-Dashboard liest Kontingent-Metadaten des Kontos und kumulierte `token_count`-Ereignisse aus lokalen Codex-Rollout-Dateien im aktuellen `CODEX_HOME`. Es zeigt:

- den verbleibenden Prozentsatz für jedes Kontingentfenster, das der Kontodienst zurückgibt, darunter 5-Stunden-, 7-Tage- und benannte Limits;
- jede verfügbare Rücksetzung als sekundengenauen Live-Countdown;
- dieselbe Rücksetzung als Ortszeit mit Sekunden und Zeitzonenoffset;
- den genauen UTC-Zeitstempel des Dienstes, einschließlich Millisekunden, sofern vorhanden;
- die Anzahl verfügbarer, erworbener Rücksetzungen des Ratenlimits, falls der Kontodienst diesen Wert bereitstellt;
- eine bestätigungspflichtige Aktion **Use one reset** für das aktuelle Konto, wenn eine erworbene Rücksetzung verwendet werden kann;
- die aufgezeichneten Token insgesamt sowie Eingabe-, Ausgabe-, zwischengespeicherte Eingabe- und Reasoning-Ausgabe-Token;
- zugeordnete und nicht zugeordnete Summen;
- Nutzung und Sitzungszahl pro Konto und API-Anbieter;
- ein Quellen-Ringdiagramm zum Vergleich der überschneidungsfreien Summen von Konten, API-Anbietern und nicht zugeordneten Daten;
- ein oranges tägliches, wöchentliches oder monatliches Nutzungsdiagramm mit Quell- und Datumsfiltern;
- Summe, Durchschnitt, Spitzenwert und geschätzte Nutzung für den ausgewählten Bereich;
- Indexabdeckung, Sitzungszahl, Beginn der Erfassung und Zeitpunkt der letzten Aktualisierung.

Die Rücksetzuhren verwenden bevorzugt den absoluten Zeitstempel des Kontingentdienstes. Steht nur ein relativer Countdown zur Verfügung, berechnet RouteSync den zugehörigen Zeitstempel zum Abfragezeitpunkt. Fehlende, ungültige oder bereits fällige Metadaten werden eindeutig angezeigt. Der Countdown wird anhand der Systemzeit neu berechnet und aktualisiert sich, ohne das gesamte Dashboard neu zu laden. Kontingentabfragen und die Erneuerung von OAuth-Token verwenden zuerst `codex-switchbridge.proxy`, danach `http.proxy` von VS Code und schließlich die Umgebungsvariablen `HTTPS_PROXY`, `HTTP_PROXY` oder `ALL_PROXY` des Erweiterungshosts. Bei der Auflösung der Umgebungsvariablen wird `NO_PROXY` weiterhin berücksichtigt. Die eigene Proxy-Einstellung gilt nur für den Rechner und ist von Settings Sync ausgeschlossen. VS Code speichert ihren Wert in den lokalen Einstellungen. Nutze daher möglichst einen lokalen Proxy ohne Authentifizierung oder schütze die Datei mit den Computereinstellungen, wenn die URL Anmeldedaten enthält.

Mit der Sprachauswahl im Dashboard-Kopf wählst du **Auto**, **English** oder **简体中文**. Auto folgt der Anzeigesprache von VS Code. Eine ausdrückliche Auswahl wird als Fenstereinstellung gespeichert und ohne Neuladen von VS Code übernommen.

Die Rücksetzaktion verwendet die offizielle Methode des Codex App Server. Sie prüft, ob dasselbe gespeicherte Konto noch aktiv ist, fragt nach einer Bestätigung, verbraucht mit einem Idempotenzschlüssel höchstens eine erworbene Rücksetzung und aktualisiert anschließend das Kontingent. Unterstützt die installierte Codex-Version den Verbrauch von Rücksetzungen nicht, öffnet RouteSync stattdessen die offizielle Usage-Seite.

Eingabe und Ausgabe bilden zusammen die aufgezeichnete Gesamtsumme. Zwischengespeicherte Eingaben sind bereits in den Eingaben enthalten, und Reasoning-Ausgaben sind bereits in den Ausgaben enthalten. Diese beiden Werte werden daher nicht erneut addiert. Das Ringdiagramm verwendet nur überschneidungsfreie, zugeordnete Quellensummen und zählt zwischengespeicherte Eingaben oder Reasoning-Ausgaben deshalb nicht doppelt.

Die Zuordnung pro Auswahl beginnt, sobald RouteSync die lokale Erfassung startet. Der Index ordnet danach jeden Token-Zuwachs dem Konto oder API-Anbieter zu, der bei der Aufzeichnung durch Codex aktiv war. Das gilt auch, wenn ein Gespräch über einen Moduswechsel hinweg fortgesetzt wird. Ältere gemeinsame `openai`-Sitzungen lassen sich keinem bestimmten gespeicherten Eintrag sicher zuordnen und bleiben unter **Earlier or unattributed**. Ältere Sitzungen mit Anbieterkennzeichnung werden nur dann zugeordnet, wenn ihre Anbieter-ID genau einem gespeicherten Profil entspricht.

Der Kontodienst liefert einen verbleibenden Prozentsatz, keine absolute Zahl verbleibender Token. Das Verlaufsdiagramm enthält lokale Aktivitätszähler des Geräts und keine Abrechnungs-, Kosten- oder entfernten Guthabendaten. Ältere indizierte Aktivitäten ohne genaue zeitliche Zuordnung werden als geschätzt markiert. Aktivitäten ohne verlässliches Datum erscheinen nicht im Diagramm. API-Anbieterprofile zeigen nur lokale Zähler an, es sei denn, der Anbieter stellt eine kompatible Kontingent-API bereit. RouteSync lädt keine Rollout-Inhalte hoch. Der lokale Index speichert Zähler, Zeitstempel, Datei-Fingerabdrücke und nicht lesbare IDs, aber keine Gesprächstexte, Pfade, Kontobezeichnungen, Anbieternamen oder Anmeldedaten. Mit **Refresh Local Token Usage** kannst du sofort neu indizieren. Andernfalls geschieht dies während der normalen Hintergrundwartung der Erweiterung.

## So bleibt der Gesprächsverlauf verfügbar

Codex gruppiert lokale Threads normalerweise nach Modellanbieter. Eine benutzerdefinierte Anbieter-ID kann dazu führen, dass Threads beim Wechsel zurück in den Kontomodus verschwunden wirken, obwohl die Dateien weiterhin vorhanden sind.

RouteSync verhindert diese Trennung bei neuen Threads:

1. Der Kontomodus verwendet den integrierten Codex-Anbieter `openai`.
2. Ein Responses-kompatibler API-Anbieter behält dieselbe Verlaufsidentität bei, während RouteSync dessen API-Schlüssel und Basis-URL anwendet.
3. Beim Zurückwechseln werden die Anmeldedaten des Kontos und die ursprüngliche OpenAI-Route wiederhergestellt.

Beide Modi lesen deshalb denselben lokalen Gesprächsverlauf im selben `CODEX_HOME`. RouteSync synchronisiert die Route, die zur Indizierung des Verlaufs verwendet wird. Gesprächsinhalte werden nach einem Wechsel nicht kopiert.

Der gemeinsame Verlauf ist in der VS Code-Erweiterung und bei kompatiblen Anbieterwechseln über die CLI standardmäßig aktiviert. In VS Code steuerst du ihn mit `codex-switchbridge.shareHistoryAcrossProviders`.

### Ältere Threads mit Anbieterkennzeichnung reparieren

Threads, die vor dem gemeinsamen Routing erstellt wurden, können noch eine anbieterspezifische ID verwenden. So übernimmst du sie in den gemeinsamen lokalen Verlauf:

1. Beende jede aktive Codex-Ausgabe.
2. Führe **Codex RouteSync: Repair Shared Conversation History** aus.
3. Verwende nach Abschluss der Reparatur die Statusleistenaktion **Reload recommended**.

Der Reparaturbefehl erstellt Sicherungen, ändert nur Felder zur Anbieteridentität, validiert JSONL- und SQLite-Datensätze und bricht ab, wenn sich ein Rollout während der Prüfung ändert. Bei der Aktivierung schreibt die Erweiterung den Verlauf nie um. Python 3 wird nur für diesen Wartungsbefehl benötigt.

Unter [Gesprächsverlauf über mehrere Modi](./docs/shared-history.md) findest du den genauen Umfang und die Sicherheitsprüfungen.

## Funktionen

- Wechsel mit einem Klick zwischen lokalen oder synchronisierten Codex-Konten und API-Anbietern in VS Code
- Eine flache Routenliste in der Seitenleiste mit gespeicherten Konten und API-Anbietern auf derselben Ebene
- Konto- und API-Anbieterwechsel mit einem Befehl über die CLI
- Gemeinsamer lokaler Gesprächsverlauf für Responses-kompatible Anbieterrouten
- Breites Editor-Dashboard mit grafischen Kontingenten, genauen Rücksetzuhren, Nutzung erworbener Rücksetzungen, Quellen-Ringdiagramm und filterbarem täglichem, wöchentlichem oder monatlichem Token-Verlauf
- Umschaltung des Dashboards zwischen Englisch und vereinfachtem Chinesisch zur Laufzeit sowie lokalisierte VS Code-Befehle und Einstellungen
- Anzeige von Kontokontingenten, Token-Erneuerung und wechselnde Hintergrundwartung
- Lokale Speicherung oder VS Code Settings Sync für gespeicherte Konten und Anbieter
- Optionale Verschlüsselung gespeicherter Authentifizierungsdaten
- Import und Export gespeicherter Konten
- Reparatur älterer lokaler Threads mit Anbieterkennzeichnung und vorheriger Sicherung
- Fensterübergreifende Wechselsperren und Wiederherstellungs-Snapshots

## CLI-Befehle

| Befehl | Beschreibung |
| --- | --- |
| `codex-switchbridge add <name>` | Führt `codex login` aus und speichert das Ergebnis als benanntes Konto |
| `codex-switchbridge list` | Listet gespeicherte Konten und API-Anbieter auf |
| `codex-switchbridge use <name>` | Wechselt zu einem gespeicherten Konto und stellt den Kontomodus wieder her |
| `codex-switchbridge mode [name]` | Zeigt den aktuellen Modus oder wechselt standardmäßig mit gemeinsamem Verlauf zu einem API-Anbieter |
| `codex-switchbridge mode <name> --separate-history` | Wechselt zu einem API-Anbieter mit anbieterspezifischem lokalen Verlauf |
| `codex-switchbridge remove <name>` | Entfernt ein gespeichertes Konto |
| `codex-switchbridge quota [name]` | Zeigt die Kontingentnutzung eines Kontos |
| `codex-switchbridge current` | Zeigt das aktuelle Konto oder den aktuellen API-Anbietermodus |
| `codex-switchbridge refresh [name]` | Erneuert das Zugriffstoken eines Kontos |
| `codex-switchbridge export [file]` | Exportiert gespeicherte Konten als JSON |
| `codex-switchbridge import <file>` | Importiert gespeicherte Konten aus einer JSON-Datei |

Mit `--auth-dir <path>` oder `CODEX_SWITCHBRIDGE_AUTH_DIR` kannst du gespeicherte Einträge außerhalb des Standardverzeichnisses von Codex ablegen. Verwende `--password` oder `CODEX_SWITCHBRIDGE_PASSWORD`, um verschlüsselte Einträge zu entsperren.

## VS Code-Einstellungen

| Einstellung | Standardwert | Beschreibung |
| --- | --- | --- |
| `codex-switchbridge.language` | `auto` | Folgt VS Code oder verwendet Englisch beziehungsweise vereinfachtes Chinesisch im Dashboard |
| `codex-switchbridge.proxy` | `""` | Nur für diesen Rechner geltender HTTP(S)-Proxy für Kontingentabfragen und die OAuth-Token-Erneuerung. Von Settings Sync ausgeschlossen. Bei leerem Wert werden die Proxy-Einstellungen von VS Code und dem Erweiterungshost verwendet |
| `codex-switchbridge.shareHistoryAcrossProviders` | `true` | Hält neue lokale Gesprächsverläufe im Kontomodus und in kompatiblen API-Anbietermodi verfügbar |
| `codex-switchbridge.reloadWindowAfterSwitch` | `statusBar` | Zeigt eine Aktion zum Neuladen, unterdrückt Hinweise vollständig oder lädt nach einem Wechsel automatisch neu |
| `codex-switchbridge.quotaRefreshInterval` | `30` | Prüft pro Intervall ein gespeichertes Konto zur Token-Wartung und Kontingentaktualisierung |
| `codex-switchbridge.tokenAutoUpdate` | `true` | Erneuert Token gespeicherter Konten während der Hintergrundwartung, wenn sie abgelaufen sind oder bald ablaufen |
| `codex-switchbridge.showStatusBar` | `true` | Zeigt die aktuelle Auswahl, das Kontingent, die Token-Nutzung und Empfehlungen zum Neuladen in der Statusleiste |
| `codex-switchbridge.authDirectory` | `""` | Speichert lokale Einträge in diesem Verzeichnis. Bei leerem Wert wird das Standardverzeichnis von Codex verwendet |

## Daten- und Wechselsicherheit

Lokale Konten verwenden `auth_{name}.json`. Lokale API-Anbieter verwenden `provider_{name}.json`. VS Code kann verschlüsselte Einträge außerdem im synchronisierten Erweiterungsspeicher ablegen.

Bevor ein Wechsel die aktive Datei `auth.json` überschreibt, schreibt RouteSync die neuesten ausgehenden Anmeldedaten in den passenden gespeicherten Konto- oder Anbietereintrag zurück. Anschließend aktualisiert der Wechsel Authentifizierung, Anbieter-Routing und den gemeinsamen Verlaufsroutenstatus unter einer einzigen prozessübergreifenden Sperre. Authentifizierungsdateien werden atomar ersetzt. Bei fehlgeschlagenen Übergängen werden die Snapshots wiederhergestellt.

Kontingentabfrage und lokale Token-Indizierung sind schreibgeschützt. Sie rotieren keine Token, überschreiben keine gespeicherte Authentifizierung und ändern keine Gesprächsdateien. Die Token-Wartung ist ein eigener Vorgang.

Einige Codex-Werkzeuge speichern die Authentifizierung beim Start im Cache. RouteSync kann einen anderen Erweiterungsprozess nicht dazu zwingen, diesen Cache zu verwerfen. Daher kann nach einem erfolgreichen Dateiwechsel weiterhin ein Neuladen des VS Code-Fensters erforderlich sein. Standardmäßig bleibt diese Empfehlung in der Statusleiste, statt wiederholt Pop-up-Hinweise anzuzeigen.

Führe **Codex Account Switch** und Codex RouteSync nicht gleichzeitig aus. Beide Erweiterungen schreiben in dieselben lokalen Codex-Dateien.

## Entwicklung

```bash
npm install
npm run build
npm run verify
```

Für die visuellen Dashboard-Tests werden außerdem Playwright Chromium und dessen Linux-Systemabhängigkeiten benötigt:

```bash
npx playwright install --with-deps chromium
npm run test:visual -w packages/vscode
```

Minimale Linux-Images ohne `/etc/fonts/fonts.conf` müssen über `FONTCONFIG_FILE` und `FONTCONFIG_PATH` eine gültige Fontconfig-Konfiguration bereitstellen. Andernfalls kann Chromium Text weder messen noch darstellen.

Projektstruktur:

```text
packages/
  core/     Gemeinsame Logik für Authentifizierung, Anbieter- und Verlaufs-Routing, Kontingente und Speicherung
  cli/      Befehlszeilenschnittstelle
  vscode/   VS Code-Erweiterung
scripts/    Werkzeuge zur Verlaufspflege und Release-Erstellung
docs/       Hinweise zu Architektur, Verhalten und Bereitstellung
```

Die Release-Abläufe sind unter [Bereitstellung](./docs/deployment.md) dokumentiert.

## Herkunft und Lizenz

Codex RouteSync ist ein unabhängiges Open-Source-Projekt, das von [jqknono/codex-account-switch](https://github.com/jqknono/codex-account-switch) abgeleitet wurde. `ShawBob001` hat es umfassend verändert.

Das Projekt steht unter der [MIT-Lizenz](./LICENSE). Der Copyright-Hinweis und der Lizenztext des ursprünglichen Projekts bleiben erhalten.
