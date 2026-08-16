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
  in `data/qrcodes/<id>.png` die verwijst naar `BASE_URL/v?id=<id>`.
- `server.js` — Express-app met twee routes:
  - `GET /v?id=<id>` — HTML-afspeelpagina met een `<video>`-tag.
  - `GET /video/<id>` — levert het bestand zelf via `res.sendFile`, wat Range-requests
    ondersteunt (nodig om te kunnen spoelen/scrubben op mobiel). Onbekende ID's en elk
    ander pad geven 404 — er is geen manier om de mappenstructuur te doorbladeren.
- `Dockerfile` / `docker-compose.yml` — draait de server als container. `BASE_URL`
  en volumes (video's + data) worden via `docker-compose.yml` ingesteld.
- Publicatie loopt via een bestaande Cloudflare Tunnel naar een subdomain van
  `gerdjan.nl` (niet in deze repo — staat in de losstaande NAS-infrastructuur).

## Beveiligingsmodel

Geen wachtwoord, geen login. Beveiliging = niet-raadbare random ID's (16^10
mogelijkheden) + geen enkele route die een overzicht of index toont. Voor een
fotoboek-use-case is dat bewust voldoende; niet geschikt voor gevoeligere content.

## CI/CD-pipeline

Bij iedere push naar `main` bouwt GitHub Actions de image en pusht die naar
`ghcr.io/gjagils/fotoboek-video`. Daarna verbindt de workflow via Tailscale met
Portainer, pullt de nieuwste image en werkt de bestaande stack bij. De benodigde
GitHub-secrets staan per repository ingesteld. Het publieke adres is
`https://albumvideo.gerdjan.nl`; de Cloudflare Tunnel verwijst naar NAS-poort 3000.

## Losse commando's

```
npm install
node generate.js          # mapping + QR-codes bijwerken na nieuwe video's
node server.js             # lokaal testen
docker compose up -d --build
docker compose run --rm fotoboek-video node generate.js
```
