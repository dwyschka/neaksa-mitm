# Neakasa M1 — capture proxy + log UI

[![build](https://github.com/dwyschka/neaksa-mitm/actions/workflows/build.yml/badge.svg)](https://github.com/dwyschka/neaksa-mitm/actions/workflows/build.yml)

Ein Container, der die Backend-API der Katzenklos *entgegennimmt*, jedes Paket
unverändert an das echte Backend weiterreicht und dabei alles mitschreibt: die
Geräte-Identität, die Header, die Bodies, die Antworten, die Latenz.

Kein TLS-Abfangen. Das Gerät vertraut keinem lokalen CA, also wird ihm über die
Cloud-Property `regionBaseurl` einfach gesagt, wo es klingeln soll. Deshalb ist
der Listener **plain HTTP** – das ist Absicht, nicht Nachlässigkeit.

```
Box  ──HTTP──▶  capture:8999  ──HTTPS──▶  deveuapi.neakasa.com/api
                    │
                    └── JSONL  ──▶  capture:8998  (UI)
```

## Was hier ankommt – und was nicht

| Kanal | sichtbar? |
|---|---|
| Alles, was die Box an ihre `regionBaseurl` schickt (Token-Report, Status, Heartbeats) | **ja**, vollständig |
| Was das Backend zurückschickt | **ja** |
| Aliyun IoT (`api-iot.*.aliyuncs.com`, MQTT/TLS, Properties, OTA) | **nein** – das läuft nie über diesen Proxy |
| Firmware-Downloads (OSS) | **nein** |

Der Container ersetzt also nicht die MQTT-Beobachtung aus `scripts/`, sondern
deckt genau den Teil ab, der bisher ein blinder Fleck war.

## Start

Lokal bauen:

```bash
cd mitm
docker compose up -d --build
```

Oder direkt das fertige Image aus der Registry (siehe *Images & CI*):

```bash
docker compose -f compose.stack.yaml up -d
```

- **Proxy:** `:8999` auf allen Host-Interfaces (dort muss die Box hin)
- **UI:** <http://127.0.0.1:8998> (nur Loopback)
- **Logs:** `./captures/<datum>.jsonl`

Die UI zeigt beim ersten Start den fertigen `set`-Befehl mit der richtigen
Adresse an; die Adresse ist die, unter der du die UI aufrufst, nur mit Port
8999.

## Die Box umbiegen

```bash
# vorher: wie sieht es aus?
python3 scripts/neakasa_ota.py detail --device B1vVD2lnYXeuduHRnESN000000

# die Box auf den Proxy zeigen lassen
python3 scripts/neakasa_ota.py set --device B1vVD2lnYXeuduHRnESN000000 --yes \
    --items '{"regionBaseurl":"http://10.10.48.124:8999/api"}'

# und zurück, wenn der Mitschnitt fertig ist
python3 scripts/neakasa_ota.py set --device B1vVD2lnYXeuduHRnESN000000 --yes \
    --items '{"regionBaseurl":"https://deveuapi.neakasa.com/api"}'
```

Der `set` läuft über Aliyun IoT und funktioniert **auch dann**, wenn die Box
gerade auf eine tote Adresse zeigt – der Rückweg ist also nicht davon abhängig,
dass der Proxy läuft.

> Beim Schreiben der Property kann die Box kurz die Verbindung zum Backend
> verlieren. Der Undo-Befehl gehört deshalb in die Zwischenablage, *bevor* du
> umstellst.

## Oberfläche

- Liste live über SSE, Filter über Pfad, Header, Body und Status (`/` fokussiert
  das Suchfeld, `Leertaste` pausiert den Stream, `j`/`k` blättert)
- Detailansicht mit Request-/Response-Headern und hübsch formatiertem Body
- **Secrets sind standardmäßig maskiert** (Token, Passwort, Signatur, …) –
  „reveal secrets" zeigt sie
- „copy as curl" baut den Aufruf gegen das *echte* Backend nach
- Export als JSONL, Deep-Link pro Request (`/#<id>`)
- „delete logs" leert Platte **und** Ansicht

## Images & CI

`.github/workflows/build.yml` baut bei jedem Push auf `master` und bei jedem
`v*`-Tag:

| Job | Was er tut |
|---|---|
| `test` | baut das Image für amd64, **startet den Container** und prüft Health-Endpoint, UI-Assets und dass ein unerreichbarer Upstream sauber `502` liefert statt zu hängen |
| `publish` | baut `linux/amd64` + `linux/arm64`, pusht nach GHCR |

Tags: `latest` (nur `master`), `sha-<kurz>`, `x.y.z` bei Git-Tags.

```bash
docker pull ghcr.io/dwyschka/neaksa-mitm:latest
```

Pull Requests bauen und testen nur, sie pushen nichts. Das Paket ist anonym
pullbar; stellst du es auf privat, braucht der Zielhost einmal
`docker login ghcr.io`.

## Konfiguration

Alles über `environment` in `compose.yaml` bzw. eine `.env` daneben:

| Variable | Default | Bedeutung |
|---|---|---|
| `UPSTREAM` | `https://deveuapi.neakasa.com/api` | wohin weitergeleitet wird |
| `VERIFY_TLS` | `false` | TLS-Prüfung zum Upstream. Aus, damit ein kaputtes Zertifikat den Mitschnitt nicht verhindert – mit dem Preis, dass alles, was auf dem Weg antwortet, vertraut wird. Auf `true` setzen, wenn die Gegenstelle echt sein muss. |
| `UI_TOKEN` | leer | wenn gesetzt, verlangt die UI dieses Token (`?token=` oder Bearer) |
| `UI_PORT` / `UI_BIND` | `8998` / `127.0.0.1` | UI-Port und -Interface |
| `MAX_BODY_BYTES` | `262144` | pro Body wird nur so viel gespeichert (weitergeleitet wird alles) |
| `MEM_LIMIT` | `5000` | Einträge im Speicher; die Datei behält alles |
| `CAPTURE_DIR` | `./captures` | Host-Verzeichnis für die JSONL-Dateien |

## Logformat

Eine Zeile pro Austausch, eine Datei pro Tag:

```json
{"id":"mvw9e74t-1","ts":"2026-10-31T10:30:49.887Z","method":"POST",
 "url":"/api/thing/properties/set","target":"/api/thing/properties/set",
 "patched":false,"client":"10.10.46.120:51234",
 "req":{"headers":{...},"body":{"encoding":"utf8","size":61,"truncated":false,"data":"..."}},
 "res":{"status":200,"headers":{...},"body":{"encoding":"utf8","size":339,"truncated":false,"data":"..."}},
 "ms":19,"error":null}
```

`patched: true` heißt: die Box hat einen Pfad ohne `/api`-Präfix aufgerufen und
der Proxy hat ihn ergänzt – ein Hinweis darauf, wie diese Firmware ihre Base
interpretiert. Binär-Bodies stehen base64-kodiert in `data`.

## Sicherheit

Das Transkript ist so sensibel wie das DeviceSecret: es enthält, womit sich die
Box authentifiziert. Deshalb:

- die UI hört nur auf `127.0.0.1` – für Zugriff aus dem LAN `UI_BIND=0.0.0.0`
  **und** `UI_TOKEN` setzen
- `./captures/` nicht weitergeben, nicht in ein Repo legen
- der Container läuft als root (nötig, damit ein bind-gemountetes
  Host-Verzeichnis beschreibbar bleibt) – er tut sonst nichts außer den beiden
  Ports

## Wenn nichts ankommt

1. **Erreicht die Box den Host überhaupt?** Sie sitzt typischerweise in einem
   anderen /24 als der Rechner. `ping <box-ip>` von hier ist nur die halbe
   Miete; entscheidend ist die Gegenrichtung.
2. **Lauscht der Proxy?** `lsof -nP -iTCP:8999 -sTCP:LISTEN`
3. **Kommt ein SYN an?** `sudo tcpdump -n -i any 'tcp port 8999'`
4. **Hat der `set` gegriffen?** `detail` zeigt `regionBaseurl`; die Box
   übernimmt es erst beim nächsten Verbindungsaufbau, ggf. Reboot.
5. **Schreibt die Box überhaupt noch HTTP?** Wenn nach dem Umstellen gar nichts
   kommt, ist genau das die Antwort – dann läuft alles über MQTT.

## Grenzen

- Antworten werden gepuffert, um sie vollständig loggen zu können. Für die
  JSON-API der Box ist das irrelevant, für große Downloads nicht.
- Bodys über `MAX_BODY_BYTES` werden gekürzt protokolliert (`truncated: true`),
  aber vollständig weitergeleitet.
- Der Mitschnitt endet, wenn der Host schläft. `restart: unless-stopped` fängt
  nur Prozess-Abstürze ab, keinen schlafenden Rechner.

`scripts/neakasa_proxy.js` bleibt als schlanke Referenz liegen (kein Zustand,
keine UI); dieser Container ist die Variante für längere Beobachtung.
