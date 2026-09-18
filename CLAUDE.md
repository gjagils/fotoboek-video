# CLAUDE.md

Context voor Claude Code over dit project. Lees dit bij de start van een sessie.

## Wat dit project is

Een zelf-gehost systeem om video's vanaf een Synology NAS af te spelen via een
"geheime" link + QR-code, zonder dat er een app geïnstalleerd hoeft te worden.
Bedoeld gebruik: QR-codes laten afdrukken in een fysiek fotoboek. Scan de code op
je telefoon → filmpje speelt direct af in de browser (Safari/Chrome).

## Architectuur

- `videos/` — bronmap met mp4's, mag submappen bevatten (bv. `videos/thailand/strand.mp4`).
  Wordt gemount als Docker volume, staat normaal niet in git (zie `.gitignore`).
- `generate.js` — scant `videos/` recursief. Nieuwe bestanden krijgen een random
  10-teken hex-ID, opgeslagen in `data/mapping.json` (id → relatief bestandspad).
  Bestaande ID's blijven stabiel bij herhaald draaien. Genereert per ID een QR-code
  in `data/qrcodes/<videonaam>--<id>.png` die verwijst naar
  `BASE_URL/v?id=<id>`. Bestaande ID-only QR-bestanden worden bij een scan
  automatisch naar dit herkenbare formaat hernoemd. Genereert daarnaast via ffmpeg
  per video een thumbnail (`data/thumbnails/<id>.jpg`, eerste niet-zwarte frame) en
  een webversie (`data/streamable/<id>.mp4`, altijd `-movflags +faststart`) zodat de
  browser direct kan starten met afspelen. Beide worden alleen aangemaakt als ze nog
  niet bestaan of als de bron wijzigde; het origineel in `videos/` blijft
  ongewijzigd. Vereist `ffmpeg` in de container (zie Dockerfile).
- `streaming.js` — pure functies die bepalen hóé die webversie gemaakt wordt.
  `generate.js` leest eerst codec, resolutie en bitrate van de bron uit de stderr van
  een korte ffmpeg-run (geen losse ffprobe nodig). Webvriendelijke bronnen (H.264,
  korte zijde ≤ `STREAM_MAX_HEIGHT`, ≤ `STREAM_MAX_BITRATE_KBPS`) worden alleen
  geremuxt; te zware of ongeschikte bronnen (4K, hoge bitrate, HEVC) worden één keer
  her-encodeerd naar H.264/AAC met afgetopte bitrate en keyframes elke 2 seconden.
  Dat is de kern van de oplossing tegen haperen: remuxen verlaagt de bitrate niet, en
  een bitrate die hoger ligt dan de verbinding aankan blijft haperen. De gekozen
  aanpak staat per video in `data/source-state.json` (`streamMode`, `streamVersion`),
  zodat een rescan niets dubbel doet. Grenzen zijn via omgevingsvariabelen bij te
  stellen (zie README); `STREAM_VERSION` in `streaming.js` verhogen laat alles
  opnieuw beoordelen.
- `views.js` — kijkcijfers per video in `data/views.json`, gebufferd weggeschreven.
  Alleen tellingen (geopend/gestart/uitgekeken, ook per dag); bewust geen IP-adressen
  of cookies.
- Bevroren albums: `freeze.js` legt de dán geldende webversie en afspeelpagina vast,
  dus een album dat ná deze wijziging bevroren wordt krijgt de nieuwe webversie,
  `preload="auto"` en de kijkcijfers. Een album dat er al vóór stond houdt zijn
  oude kopie: `generate.js` slaat bronnen in bevroren albums over en een archief
  wordt nooit vervangen.
- `refresh.js` — de uitzondering daarop, alleen op uitdrukkelijk verzoek via `/admin`
  (of `node refresh.js "<map>"`). Verlicht de video's ín een bevroren album en legt de
  pagina's opnieuw vast, met dezelfde ID's, zodat gedrukte QR-codes blijven werken.
  De vorige editie gaat via een `rename` naar `data/frozen-album-backups/<sleutel>/`
  en wordt bij een tweede verversing niet overschreven: daar staat dus altijd de
  gedrukte editie. `node refresh.js --terug "<map>"` zet die terug, maar alleen nadat
  elke sha256 uit het manifest gecontroleerd is. Het manifest noteert per video
  `streamVersion`/`streamMode`, zodat een tweede verversing alleen de pagina's
  vernieuwt: een omgezette film meet zelf vaak nét boven de bitrategrens (audio en
  containeropslag tellen mee), dus op de bitrate afgaan zou elke keer opnieuw
  coderen, met kwaliteitsverlies. Beide stappen zijn hernoemingen van
  mappen (klaarzetten in `.verversen-*`, dan omwisselen), dus er staat nooit een halve
  editie live. `freeze.js` deelt hiervoor `capturePage`, `inlineGalleryAssets` en
  `verifyArchive`; `req.captureLive` en `req.mediaDirectory` laten de renderers een
  pagina opnieuw opbouwen voor een album dat al gearchiveerd is.
- `server.js` — Express-app met de volgende routes:
  - `GET /v?id=<id>` — HTML-afspeelpagina met een `<video>`-tag (`preload="auto"`,
    `poster` naar `/thumb/<id>.jpg`), een laad-indicator bij haperen en een klein
    script dat kijkcijfers meldt via `navigator.sendBeacon`.
  - `GET /video/<id>.mp4` — levert het videobestand via `res.sendFile`, wat
    Range-requests ondersteunt (nodig om te kunnen spoelen/scrubben op mobiel).
    Gebruikt de webversie uit `data/streamable/` als die bestaat, anders het origineel.
    Onbekende ID's geven 404. `/video/<id>` zonder extensie blijft werken (oude
    bevroren pagina's gebruiken dat pad).
  - `GET /thumb/<id>.jpg` — levert de thumbnail-JPEG van een video.
  - Media-URL's krijgen een versiesleutel (`?v=…`) uit grootte + mtime van het
    bestand. Mét sleutel mag alles onderweg het een jaar cachen (`immutable`), zonder
    sleutel blijft de oude "altijd hervalideren"-regel gelden. De extensie in het pad
    is er omdat Cloudflare `.mp4`/`.jpg` standaard wél cachet en extensieloze paden niet.
  - `POST /stats/view` — telt `open`, `play` of `complete` voor een bestaand ID.
    Onbekende of verzonnen ID's worden geweigerd.
  - `GET /gallery` — **publieke** pagina met alle video's gegroepeerd per (sub)map,
    met thumbnails. Bewuste uitzondering op het "geen overzicht"-principe hieronder,
    zodat video's ook zonder fotoboek aan mensen getoond kunnen worden.
  - Elk ander pad geeft 404 — er is geen manier om de rauwe mappenstructuur op de NAS
    te doorbladeren.
- `Dockerfile` / `docker-compose.yml` — draait de server als container. `BASE_URL`
  en volumes (video's + data) worden via `docker-compose.yml` ingesteld.
- Publicatie loopt via een bestaande Cloudflare Tunnel naar een subdomain van
  `gerdjan.nl` (niet in deze repo — staat in de losstaande NAS-infrastructuur).

## Beveiligingsmodel

Geen wachtwoord, geen login. Beveiliging = niet-raadbare random ID's (16^10
mogelijkheden) + geen route die de video's per ID laat doorbladeren. Voor een
fotoboek-use-case is dat bewust voldoende; niet geschikt voor gevoeligere content.
Uitzondering: `/gallery` is bewust wél publiek en toont een overzicht van alle
video's met thumbnail, zodat ze ook los van het fotoboek getoond kunnen worden.

## CI/CD-pipeline

Bij iedere push naar `main` bouwt GitHub Actions de image en pusht die naar
`ghcr.io/gjagils/fotoboek-video`. Daarna verbindt de workflow via Tailscale met
Portainer, pullt de nieuwste image en werkt de bestaande stack bij. De benodigde
GitHub-secrets staan per repository ingesteld. Het publieke adres is
`https://albumvideo.gerdjan.nl`; de Cloudflare Tunnel verwijst naar NAS-poort 3000.
De beveiligde beheerpagina op `/admin` kan `generate.js` starten. Authenticatie
gebruikt gebruiker `admin` en `ADMIN_PASSWORD` uit de Portainer stackomgeving.
De scan draait in de achtergrond en schrijft naar `data/generate.log`; `/admin`
toont die voortgang (`GET /admin/scan-status`) en de kijkcijfers per film.

## Losse commando's

```
npm install
node generate.js          # mapping + QR-codes bijwerken na nieuwe video's
node server.js             # lokaal testen
docker compose up -d --build
docker compose run --rm fotoboek-video node generate.js
```
