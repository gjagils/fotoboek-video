# Fotoboek Video

Zet video's op je Synology, deel ze via een geheime link + QR-code, en speel ze op elke
smartphone af in de browser — zonder app te hoeven installeren.

## Hoe het werkt

- `videos/` — hier zet je je mp4's neer. Submappen mogen (bv. `videos/thailand/strand.mp4`).
- `generate.js` — scant `videos/` recursief, geeft nieuwe bestanden een random ID, en
  genereert per video een QR-code, thumbnail en voor streaming geoptimaliseerde kopie.
  Bestaande ID's blijven hetzelfde. Gewijzigde video's krijgen automatisch nieuwe
  afgeleide bestanden; verwijderde video's worden uit de mapping en galerij verwijderd.
- `server.js` — de webserver. `/v?id=<id>` toont een simpele afspeelpagina,
  `/video/<id>` levert het videobestand (met Range-support, nodig om te kunnen spoelen
  op mobiel). Bekende ID's zijn nodig om een video te bekijken; alleen `/gallery` is
  een publiek overzicht (zie hieronder).

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
   openen, met **Kopieer link** rechtstreeks voor WhatsApp kopiëren of met
   **Download QR** de bijbehorende PNG downloaden.
   Onder **Vakantie-albums** staat daarnaast voor elke submap een eigen galerijlink
   met **Kopieer link** en **Download QR**. Daar stel je per vakantie ook de
   vormgeving, paginatitel en subtitel in. Deze instellingen blijven bewaard in
   `data/gallery-settings.json`.
   De WhatsApp-linkpreview gebruikt automatisch de videobestandsnaam als titel.

Als alternatief kan het generate-script vanuit de container worden gestart:
   ```
   node generate.js
   ```
3. Pak de nieuwe QR-code(s) uit
   `/volume1/homes/gjagils/fotoboek-video/data/qrcodes/`. De bestandsnaam bevat
   het videopad en de geheime ID, bijvoorbeeld
   `thailand-strand--8f3a1c9d2b.png`.

## QR Studio voor het fotoboek

Op de beveiligde beheerpagina staat een QR Studio. Klik bij een video op
**Ontwerp kader**, pas eventueel URL, titel en stijl aan en bekijk het resultaat
direct. De roze reiskaderstijl bevat het video-icoon, de titel en subtiele roze
drukwerkdetails uit het Thailand-fotoboek.

De stijl **Startbeeld-filmkaart** voegt een lokaal gekozen startbeeld als brede
filmstill boven de QR-code toe. Het beeld blijft in de browser en wordt niet naar
de server geüpload. De QR houdt een eigen rustige zone voor betrouwbare scanning.

De PNG-export is 1800 × 2250 pixels en bevat 300-dpi-metadata. De achtergrond
kan transparant of wit worden geëxporteerd; transparant is standaard. Gebruik
voor Albelli bij voorkeur **Wit · Albelli veilig**. De JPG-reserve-export heeft
altijd een witte achtergrond.

## Let op bij de video's zelf

- Gebruik H.264/mp4 — dat speelt native af in Safari (iOS) en Chrome (Android).
- Check de rotatie (EXIF) voordat je 'm erin zet, anders staat 'm scheef op de telefoon.
- Comprimeer grote bestanden (bv. met HandBrake) — kleinere bestanden laden sneller
  wanneer iemand net de QR-code gescand heeft.

## Galerij-pagina

`/gallery` toont alle video's gegroepeerd per (sub)map, met een thumbnail van het
eerste frame, zodat je ze ook zonder fotoboek aan mensen kunt laten zien. Deze
pagina is publiek (geen ID nodig) — deel de link dus alleen met wie de video's mag
zien.

Elke submap heeft ook een eigen publieke vakantiepagina, bijvoorbeeld
`/gallery?folder=thailand`. Bij iedere scan wordt daarvoor automatisch een QR-code
in `data/folder-qrcodes/` gemaakt. Nieuwe mappen verschijnen vanzelf; als de laatste
video uit een map verdwijnt, wordt ook de bijbehorende map-QR verwijderd.

### Thailand-vormgeving (mock-up)

De losse mock-up staat in `index.html`, met de vormgeving in
`thailand-films.css` en lokale voorbeeldillustraties in `assets/`. Open
`index.html` via een lokale webserver om hem te bekijken.

Om een voorbeeldkaart te vervangen:

1. Zet bij `href` de bestaande videolink (`/v?id=...`).
2. Zet bij `img src` de bestaande thumbnail (`/thumb/<id>`).
3. Vervang de zichtbare `<h2>` en `aria-label` door de leesbare videotitel.
4. Laat `width`, `height` en de klasse `portrait`/`landscape` aansluiten op de
   thumbnail. CSS vervormt of snijdt het beeld niet bij.

De mock-up is ook aangesloten op de dynamische `/gallery?folder=thailand`.
Thailand gebruikt standaard het reisdagboekthema; via `/admin` kan elke map
afzonderlijk op **Standaard** of **Thailand-reisdagboek** worden gezet.

## Snellere laadtijd

`generate.js` maakt per video, naast de QR-code, ook automatisch (via ffmpeg):

- een **thumbnail** (`data/thumbnails/<id>.jpg`) van het eerste frame — gebruikt
  als `poster` op de afspeelpagina en op `/gallery`, zodat er meteen een beeld
  staat terwijl de video nog laadt.
- een **streamable kopie** (`data/streamable/<id>.mp4`) met de moov-atom vooraan
  ("faststart"). Veel telefoonopnames hebben die metadata juist aan het eínd van
  het bestand staan, waardoor de browser eerst (bijna) het hele bestand moet
  downloaden voordat 'ie kan beginnen met afspelen. De streamable kopie lost dat
  op zonder opnieuw te coderen (dus snel, geen kwaliteitsverlies) en wordt
  automatisch gebruikt door `/video/<id>` als 'ie bestaat. Het origineel in
  `videos/` blijft ongewijzigd.

## Beveiliging

De ID's zijn random 10-tekens hex-strings (dus 16^10 mogelijkheden) — niet te raden,
en er is geen route die de video's per ID laat doorbladeren. Voor een fotoboek is dit
ruim voldoende; een wachtwoord is niet nodig en zou het scannen alleen maar lastiger
maken. De galerij op `/gallery` is een bewuste uitzondering: die is publiek en toont
wél een overzicht van alle video's.
