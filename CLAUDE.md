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

## Wat er nog moet gebeuren: CI/CD-pipeline

Doel: bij een push naar `main` moet de NAS automatisch de nieuwe versie draaien,
zonder dat er handmatig `docker compose up --build` op de Synology nodig is.

Twee opties, nog niet gekozen/geïmplementeerd:

1. **GitHub Actions bouwt en pusht naar GHCR (GitHub Container Registry) + Watchtower
   op de NAS.** GitHub-hosted runner bouwt de image bij elke push, pusht naar
   `ghcr.io/<user>/fotoboek-video`. Watchtower draait als aparte container op de NAS,
   pollt periodiek of er een nieuwe image-tag is, en herstart de container automatisch.
   Voordeel: geen inkomend verkeer naar de NAS nodig, Watchtower is homelab-standaard.

2. **Self-hosted GitHub Actions runner op de NAS zelf.** De workflow draait dan
   letterlijk op de Synology (als container/proces) en doet zelf `docker compose
   up -d --build` na een push. Voordeel: geen externe registry nodig. Nadeel: runner
   moet altijd actief zijn en heeft toegang tot de Docker-daemon van de NAS.

Nog te doen in deze sessie:
- Kies optie 1 of 2 (voorkeur nog niet vastgelegd).
- Workflow-bestand toevoegen: `.github/workflows/deploy.yml` (build + push, of
  build + restart).
- Bij optie 1: Watchtower-service toevoegen aan `docker-compose.yml` op de NAS,
  gescoped op alleen deze container (label-based, niet alle containers).
- `.gitignore` controleren/aanvullen zodat `videos/`, `data/mapping.json` en
  `data/qrcodes/` nooit in git terechtkomen (privacygevoelig, en `data/` wordt
  toch runtime gegenereerd).
- README bijwerken met de gekozen deploy-flow.

## Losse commando's

```
npm install
node generate.js          # mapping + QR-codes bijwerken na nieuwe video's
node server.js             # lokaal testen
docker compose up -d --build
docker compose run --rm fotoboek-video node generate.js
```
