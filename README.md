# Fotoboek Video

Zet video's op je Synology, deel ze via een geheime link + QR-code, en speel ze op elke
smartphone af in de browser — zonder app te hoeven installeren.

## Hoe het werkt

- `videos/` — hier zet je je mp4's neer. Submappen mogen (bv. `videos/thailand/strand.mp4`).
- `generate.js` — scant `videos/` recursief, geeft nieuwe bestanden een random ID, en
  genereert per video een QR-code (in `data/qrcodes/`) die naar `BASE_URL/v?id=<id>` wijst.
  Bestaande ID's blijven altijd hetzelfde, ook als je het script opnieuw draait.
- `server.js` — de webserver. `/v?id=<id>` toont een simpele afspeelpagina,
  `/video/<id>` levert het videobestand (met Range-support, nodig om te kunnen spoelen
  op mobiel). Er is geen enkele route die de videomap toont — alleen bekende ID's werken.

## Installatie op de Synology

1. Zet deze map ergens neer, bv. via File Station in `/docker/fotoboek-video/`.
2. Pas in `docker-compose.yml` de volume-mapping aan naar je echte videomap, bv.:
   ```yaml
   volumes:
     - /volume1/video/fotoboek:/app/videos
     - ./data:/app/data
   ```
3. De productie-URL is `https://albumvideo.gerdjan.nl`. Laat de bestaande
   Cloudflare Tunnel doorsturen naar poort `3000` van de NAS.
4. De productiecontainer wordt automatisch via GitHub Actions en Portainer
   bijgewerkt bij iedere push naar `main`.

## Nieuwe video's toevoegen

1. Zet het mp4-bestand in `/volume1/homes/gjagils/fotoboek-video/videos/`
   (eventueel in een submap).
2. Open `https://albumvideo.gerdjan.nl/admin`, log in als `admin` en klik op
   **Video's scannen en QR-codes genereren**. Daarna kun je per video de link
   openen of met **Kopieer link** rechtstreeks voor WhatsApp kopiëren.

Als alternatief kan het generate-script vanuit de container worden gestart:
   ```
   node generate.js
   ```
3. Pak de nieuwe QR-code(s) uit
   `/volume1/homes/gjagils/fotoboek-video/data/qrcodes/`. De bestandsnaam bevat
   het videopad en de geheime ID, bijvoorbeeld
   `thailand-strand--8f3a1c9d2b.png`.

## Let op bij de video's zelf

- Gebruik H.264/mp4 — dat speelt native af in Safari (iOS) en Chrome (Android).
- Check de rotatie (EXIF) voordat je 'm erin zet, anders staat 'm scheef op de telefoon.
- Comprimeer grote bestanden (bv. met HandBrake) — kleinere bestanden laden sneller
  wanneer iemand net de QR-code gescand heeft.

## Beveiliging

De ID's zijn random 10-tekens hex-strings (dus 16^10 mogelijkheden) — niet te raden,
en er is geen manier om de lijst met video's te doorbladeren. Voor een fotoboek is dit
ruim voldoende; een wachtwoord is niet nodig en zou het scannen alleen maar lastiger maken.
