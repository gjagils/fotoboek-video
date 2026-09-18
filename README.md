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
  `/video/<id>.mp4` levert het videobestand (met Range-support, nodig om te kunnen
  spoelen op mobiel), `/stats/view` telt hoe vaak een film bekeken wordt. Bekende
  ID's zijn nodig om een video te bekijken; alleen `/gallery` is een publiek
  overzicht (zie hieronder).

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
   **Video's scannen en QR-codes genereren**. De scan draait in de achtergrond;
   de voortgang staat onder **Scan en webversies** en zware video's worden daar
   omgezet naar een vlot afspeelbare webversie. Daarna kun je per video de link
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
**Ontwerp kader**, pas eventueel URL, stapnummer, stad, activiteit en stijl aan en bekijk het resultaat
direct. Losse kaarten en de ZIP gebruiken dezelfde kaderstijlen en tekstindeling.
Bij het openen van een video worden de herkende teksten (of je aanpassingen in het
bulkformulier) overgenomen. Bij een album blijft het veld voor de albumtitel beschikbaar.
De roze reiskaderstijl bevat het video-icoon, de titel en subtiele roze
drukwerkdetails uit het Thailand-fotoboek.

De stijl **Startbeeld-filmkaart** voegt een lokaal gekozen startbeeld als brede
filmstill boven de QR-code toe. Het beeld blijft in de browser en wordt niet naar
de server geüpload. De QR houdt een eigen rustige zone voor betrouwbare scanning.

De PNG-export is 1800 × 2250 pixels en bevat 300-dpi-metadata. De achtergrond
kan transparant of wit worden geëxporteerd; transparant is standaard. Gebruik
voor Albelli bij voorkeur **Wit · Albelli veilig**. De JPG-reserve-export heeft
altijd een witte achtergrond.

Onder **Vakantiealbum downloaden** kies je een videomap. De ZIP bevat alle
videokaarten rechtstreeks uit die map, plus één QR-kaart die de bijbehorende
`/gallery?folder=…`-totaalpagina opent. Dit volgt hetzelfde mapfilter als de galerij;
eventuele submappen kies je afzonderlijk. De titel van de albumkaart is aanpasbaar.
Ook bij **Vakantie-albums → Ontwerp kader** kun je een losse albumkaart maken.

Stapnummer, plaats en activiteit worden zo mogelijk uit de bestandsnaam gehaald:
`01 - Chiang Mai - Tempelbezoek.mp4` of `Step 02_Bangkok_Fietsen.mp4`.
`Stap nr. 03 - Pai - Wandelen.mp4` werkt ook. Exportaanduidingen zoals
`compleet 9x16` en kopienummers tussen haakjes worden verwijderd. Controleer de
herkende teksten voor het downloaden; bij onduidelijke namen blijft de plaats
leeg. Het stapnummer is optioneel en komt samen met de plaats boven de activiteit.
De kaarten volgen de stapnummers en krijgen unieke bestandsnamen.

Alle kaarten gebruiken dezelfde gekozen Studio-stijl, achtergrond en afmetingen
(1800 × 2250 pixels, 300 dpi). Bij **Startbeeld-filmkaart** gebruikt elke video
zijn eigen gegenereerde thumbnail en de albumkaart die van de eerste video.
Ontbreekt een thumbnail, scan de video's opnieuw. De teksten blijven alleen in
de geopende pagina staan. Houd de pagina open tot de export klaar is; de ZIP
wordt lokaal in de browser samengesteld.

## Let op bij de video's zelf

- Gebruik H.264/mp4 — dat speelt native af in Safari (iOS) en Chrome (Android).
- Check de rotatie (EXIF) voordat je 'm erin zet, anders staat 'm scheef op de telefoon.
- Comprimeer grote bestanden (bv. met HandBrake) — kleinere bestanden laden sneller
  wanneer iemand net de QR-code gescand heeft.

## Galerij-pagina

`/` en `/gallery` tonen alle vakantiealbums als kaarten. Elke kaart opent de
bijbehorende publieke albumpagina met video's. Deze
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
- een **webversie** (`data/streamable/<id>.mp4`) met de moov-atom vooraan
  ("faststart"). Veel telefoonopnames hebben die metadata juist aan het eínd van
  het bestand staan, waardoor de browser eerst (bijna) het hele bestand moet
  downloaden voordat 'ie kan beginnen met afspelen. De webversie lost dat op en
  wordt automatisch gebruikt door `/video/<id>` als 'ie bestaat. Het origineel in
  `videos/` blijft altijd ongewijzigd.

### Waarom een video hapert — en wat er nu gebeurt

Haperen komt bijna nooit doordat de browser "te weinig buffert": de browser
buffert zo snel als de verbinding toelaat. Het komt doordat de video méér data
per seconde vraagt dan de verbinding levert. Een telefoonopname van 4K/45 Mbit/s
blijft na een remux gewoon 45 Mbit/s, en dat haalt een mobiele verbinding via de
NAS-upload en de tunnel niet.

Daarom kijkt `generate.js` nu eerst naar de bron:

- Is de bron al webvriendelijk (H.264, korte zijde ≤ 1080 px, ≤ 4500 kb/s), dan
  wordt hij alleen geremuxt — snel en zonder kwaliteitsverlies, precies als eerst.
- Is de bron te zwaar (4K, hoge bitrate) of ongeschikt (HEVC speelt niet overal),
  dan wordt hij **één keer** omgezet naar H.264/AAC met de korte zijde op maximaal
  1080 px en de bitrate afgetopt op 4500 kb/s, met een keyframe elke 2 seconden
  zodat spoelen snel blijft reageren. Bij een staande video blijft de breedte dus
  1080 px — staande filmpjes worden niet kleiner gemaakt dan nodig.

Dat omzetten kost rekentijd op de NAS (ordegrootte: een minuut per minuut video),
dus de scan draait in de achtergrond. Op `/admin` staat onder **Scan en
webversies** de live voortgang; je kunt de pagina gerust sluiten.

Bij te stellen via de omgeving (Portainer-stack), als de standaardwaarden niet
bevallen:

| Variabele | Standaard | Betekenis |
| --- | --- | --- |
| `STREAM_MAX_HEIGHT` | `1080` | Maximale korte zijde van de webversie |
| `STREAM_MAX_BITRATE_KBPS` | `4500` | Maximale bitrate in kb/s |
| `STREAM_CRF` | `23` | Kwaliteit (lager = mooier en groter) |
| `STREAM_PRESET` | `veryfast` | Snelheid/compressie-afweging van x264 |
| `STREAM_AUDIO_BITRATE_KBPS` | `128` | Geluidsbitrate in kb/s |
| `STREAM_TRANSCODE` | aan | Op `off` zetten schakelt omzetten uit (alleen remux) |

Verhoog `STREAM_VERSION` in `generate.js` om alle webversies opnieuw te laten
beoordelen na het wijzigen van deze grenzen.

Let op bij HDR-opnames (iPhone "Dolby Vision", 10-bits): die worden omgezet naar
gewone SDR-kleuren en kunnen daardoor iets vlakker ogen dan het origineel. Valt
dat tegen bij een bepaalde film, zet `STREAM_TRANSCODE=off`, scan opnieuw en
lever die film als remux uit — dan blijft de kwaliteit, maar keert het haperen
terug bij een trage verbinding.

### Caching

De afspeelpagina verwijst naar `/video/<id>.mp4?v=<versie>` en
`/thumb/<id>.jpg?v=<versie>`. De versiesleutel komt uit de grootte en
wijzigingstijd van het bestand, dus:

- mét sleutel mogen browser en Cloudflare het bestand een jaar bewaren
  (`immutable`) — een tweede kijker of een herhaalde scan van dezelfde QR-code
  hoeft niet opnieuw door de tunnel;
- wordt de bronvideo vervangen, dan verandert de sleutel en dus de URL, zodat
  niemand een oude kopie uit de cache krijgt;
- `/video/<id>` zonder sleutel blijft werken en blijft hervalideren (oude
  bevroren pagina's en gedeelde links gebruiken dat pad nog).

De extensie in het pad staat er bewust: Cloudflare cachet `.mp4` en `.jpg`
standaard wel, een extensieloos pad niet.

## Kijkcijfers

De afspeelpagina meldt drie dingen aan de server: **geopend** (pagina geladen),
**gestart** (de film begint te lopen) en **uitgekeken** (tot het einde). Per
paginabezoek telt elke gebeurtenis hoogstens één keer.

- Zichtbaar op `/admin` onder **Kijkcijfers**: per film het totaal, de laatste
  30 dagen en wanneer de film voor het laatst bekeken is. Per album staat het
  aantal starts in de albumkop.
- Opgeslagen in `data/views.json` — alleen tellingen per video en per dag. Geen
  cookies, geen IP-adressen, geen bezoekersprofielen. Wie de pagina herlaadt,
  telt opnieuw mee; linkpreviews (zoals in WhatsApp) tellen niet mee omdat die
  geen video afspelen en het script niet uitvoeren.
- Ook bevroren albums tellen mee: hun vastgelegde pagina's bevatten hetzelfde
  script.
- Het bestand hoort bij je NAS-back-up als je de geschiedenis wilt houden; het
  wordt gebufferd weggeschreven (elke paar seconden en bij afsluiten).

## Beveiliging

De ID's zijn random 10-tekens hex-strings (dus 16^10 mogelijkheden) — niet te raden,
en er is geen route die de video's per ID laat doorbladeren. Voor een fotoboek is dit
ruim voldoende; een wachtwoord is niet nodig en zou het scannen alleen maar lastiger
maken. De galerij op `/gallery` is een bewuste uitzondering: die is publiek en toont
wél een overzicht van alle video's.

## Gedrukt fotoboek: album bevriezen

Ga naar **Beheer → Vakantie-albums → Thailand**, vink **Fotoboek besteld — dit
album blijvend bevriezen** aan en klik **Album bevriezen**. Doe dit voordat je
bronvideo's wijzigt of verwijdert. Het vinkje staat pas definitief aan als de
volledige kopie is voltooid. Bij grote albums kan dit enkele minuten duren;
vernieuw de beheerpagina als de verbinding tussentijds afloopt om de status te zien.

De reeds gedrukte QR-codes veranderen **niet**. Zowel `/v?id=…`, `/video/…`,
`/thumb/…` als `/gallery?folder=thailand` blijven dezelfde editie leveren (met de
oorspronkelijke spelling van je map). De app bewaart de momenteel afgespeelde
videokopieën, beschikbare thumbnails, QR-afbeeldingen, afspeelpagina's en de
albumoverzichtspagina inclusief de huidige Thailand-vormgeving. Het archief staat
in **`data/frozen-albums/`** op het bestaande blijvende Docker-volume. Er worden
zelfstandige bestandskopieën gemaakt, geen verwijzingen naar de bronbestanden.

Een scan overschrijft of verwijdert deze editie niet. Nieuwe bestanden in diezelfde
map worden overgeslagen. Maak voor een nieuwe editie een **andere mapnaam**;
die krijgt eigen links. Bevriezen geldt voor de direct in de gekozen map opgenomen
video's, net als de albumgalerij; submappen zijn afzonderlijke albums. Bevroren
albums hebben bewust geen ontgrendel- of verwijderknop. Een herhaalde
bevriesopdracht behoudt het eerste archief.

**Back-up:** neem de volledige NAS-map `data/` op in een back-up op een andere
schijf of locatie; neem ook `videos/` mee voor niet-bevroren albums. Alleen een
kopie van `mapping.json` is niet genoeg. Bewaar daarnaast je Docker-instellingen,
domein en Cloudflare Tunnel-configuratie. Bij herstel zet je `data/` terug op
hetzelfde volume en laat je het bestaande domein naar de server wijzen. De
`manifest.json` per archief bevat SHA-256-controlesommen om de archiefbestanden
na herstel te controleren. Het vinkje beschermt tegen wijzigingen in deze app,
niet tegen schijfverlies, handmatig verwijderen van het archief of het vervallen
van het domein. Reserveer extra schijfruimte ter grootte van de bewaarde video's.

Scannen, instellingen opslaan en bevriezen gebruiken dezelfde `data/update.lock`
om gelijktijdige wijzigingen te voorkomen. Bij een afgebroken proces kan die
lock blijven staan: stop eerst de container en eventuele losse generators,
controleer dat er geen archivering meer draait en verwijder dan alleen
`data/update.lock` voordat je de container start. Mappen met de prefix `.pending-`
zijn onvoltooide archieven en worden nooit als bevroren editie gepubliceerd.
Een mislukte kopie activeert het vinkje niet.

Ontwikkelcontrole: `npm test` test onder andere dat verwijderen, vervangen en
opnieuw scannen de bevroren links en Range-requests intact laat.

### Zuid-Afrika 2025

`/gallery?folder=zuid-afrika` heeft een eigen safarithema met terracotta,
reisdagboekpapier, jeep en verrekijker. Deze pagina is alvast beschikbaar voordat
er video's zijn toegevoegd. Plaats de MP4's in `videos/zuid-afrika/` en scan ze
via Beheer; de thumbnails en bestaande afspeellinks verschijnen automatisch.
Gebruik bijvoorbeeld `Tussen de leeuwen.mp4` voor de eerste film.
Andere mapnamen kunnen via Beheer het thema **Zuid-Afrika · Op safari** kiezen.
Titel en subtitel zijn aanpasbaar. Ook dit thema wordt bij albumbevriezing
zelfstandig gearchiveerd, inclusief de vormgeving en headerillustratie.

### Publieke startpagina

`/` en `/gallery` tonen een rustig albumoverzicht zonder login. Iedere kaart opent de bestaande `/gallery?folder=…`-pagina. Het overzicht gebruikt albumtitels en ondertitels uit beheer en toont ook bevroren albums en de bestaande Zuid-Afrika-preview. Losse video’s staan onder Overige herinneringen. `/admin` blijft beveiligd. Alle bestaande galerijen zijn publiek; het overzicht maakt ze direct vindbaar. De startpagina vraagt zoekmachines om niet te indexeren (dit is geen toegangsbeveiliging).
