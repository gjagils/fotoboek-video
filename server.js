// server.js
// Twee routes:
//   GET /v?id=<id>       -> afspeelpagina met <video> tag
//   GET /video/<id>      -> het videobestand zelf (met Range-support voor spoelen/scrubben)
//
// Er is GEEN route die de videomap toont of doorbladert; alleen bekende ID's uit mapping.json werken.

const fs = require("fs");
const path = require("path");
const express = require("express");

const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(__dirname, "videos");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const MAPPING_FILE = path.join(DATA_DIR, "mapping.json");
const PORT = process.env.PORT || 3000;

const app = express();

function loadMapping() {
  if (!fs.existsSync(MAPPING_FILE)) return {};
  return JSON.parse(fs.readFileSync(MAPPING_FILE, "utf8"));
}

// Afspeelpagina
app.get("/v", (req, res) => {
  const id = String(req.query.id || "");
  const mapping = loadMapping();
  const relativePath = mapping[id];

  if (!relativePath) {
    res.status(404).send("Video niet gevonden.");
    return;
  }

  const html = `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Filmpje</title>
  <style>
    html, body { margin: 0; height: 100%; background: #000; }
    .wrap { display: flex; align-items: center; justify-content: center; height: 100%; }
    video { max-width: 100%; max-height: 100%; }
  </style>
</head>
<body>
  <div class="wrap">
    <video controls playsinline preload="metadata">
      <source src="/video/${encodeURIComponent(id)}" type="video/mp4" />
      Je browser ondersteunt deze video niet.
    </video>
  </div>
</body>
</html>`;

  res.status(200).type("html").send(html);
});

// Video-bestand zelf. res.sendFile ondersteunt Range-requests automatisch,
// dat is nodig zodat je op je telefoon door de video heen kunt spoelen.
app.get("/video/:id", (req, res) => {
  const mapping = loadMapping();
  const relativePath = mapping[req.params.id];

  if (!relativePath) {
    res.status(404).send("Video niet gevonden.");
    return;
  }

  const absolutePath = path.join(VIDEOS_DIR, relativePath);

  // Veiligheidscheck: voorkom dat iemand via het pad buiten VIDEOS_DIR komt
  if (!absolutePath.startsWith(path.resolve(VIDEOS_DIR))) {
    res.status(400).send("Ongeldig pad.");
    return;
  }

  res.sendFile(absolutePath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).send("Video niet gevonden.");
    }
  });
});

// Geen enkele andere route bestaat (dus ook geen mapoverzicht of index-listing)
app.use((req, res) => {
  res.status(404).send("Niet gevonden.");
});

app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});
