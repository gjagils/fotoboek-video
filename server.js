// server.js
// Twee routes:
//   GET /v?id=<id>       -> afspeelpagina met <video> tag
//   GET /video/<id>      -> het videobestand zelf (met Range-support voor spoelen/scrubben)
//
// Er is GEEN route die de videomap toont of doorbladert; alleen bekende ID's uit mapping.json werken.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const express = require("express");

const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(__dirname, "videos");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const QR_DIR = path.join(DATA_DIR, "qrcodes");
const MAPPING_FILE = path.join(DATA_DIR, "mapping.json");
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || "https://albumvideo.gerdjan.nl").replace(/\/$/, "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const app = express();
let generationInProgress = false;

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function requireAdmin(req, res, next) {
  const authorization = req.get("authorization") || "";
  const encodedCredentials = authorization.startsWith("Basic ") ? authorization.slice(6) : "";
  let password = "";

  try {
    const credentials = Buffer.from(encodedCredentials, "base64").toString("utf8");
    const separator = credentials.indexOf(":");
    password = separator >= 0 ? credentials.slice(separator + 1) : "";
  } catch {
    password = "";
  }

  if (!ADMIN_PASSWORD || !safeEqual(password, ADMIN_PASSWORD)) {
    res.set("WWW-Authenticate", 'Basic realm="Fotoboek beheer", charset="UTF-8"');
    res.status(401).send("Inloggen vereist.");
    return;
  }

  res.set("Cache-Control", "no-store");
  next();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function adminPage(result = "") {
  const resultHtml = result ? `<pre>${escapeHtml(result)}</pre>` : "";
  const videos = Object.entries(loadMapping()).sort((left, right) => left[1].localeCompare(right[1], "nl"));
  const videosHtml = videos.length
    ? `<section>
        <h2>Videolinks</h2>
        <div class="videos">
          ${videos.map(([id, relativePath]) => {
            const url = `${BASE_URL}/v?id=${encodeURIComponent(id)}`;
            return `<article>
              <strong>${escapeHtml(relativePath)}</strong>
              <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>
              <div class="actions">
                <button class="copy" type="button" data-url="${escapeHtml(url)}">Kopieer link</button>
                <a class="button secondary" href="/admin/qr/${encodeURIComponent(id)}">Download QR</a>
              </div>
            </article>`;
          }).join("")}
        </div>
      </section>`
    : `<p class="empty">Nog geen video's verwerkt.</p>`;

  return `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Fotoboek-video beheer</title>
  <style>
    body { max-width: 760px; margin: 48px auto; padding: 0 20px; font: 16px/1.5 system-ui, sans-serif; color: #1f2937; }
    button, .button { border: 0; border-radius: 8px; padding: 12px 18px; background: #2563eb; color: white; font: inherit; cursor: pointer; text-decoration: none; }
    button:hover, .button:hover { background: #1d4ed8; }
    .button.secondary { background: #374151; }
    .button.secondary:hover { background: #1f2937; }
    pre { margin-top: 24px; padding: 16px; overflow: auto; border-radius: 8px; background: #f3f4f6; white-space: pre-wrap; }
    section { margin-top: 36px; }
    .videos { display: grid; gap: 12px; }
    article { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 16px; padding: 16px; border: 1px solid #d1d5db; border-radius: 10px; }
    article strong, article > a { overflow-wrap: anywhere; }
    article > a { color: #1d4ed8; }
    article .actions { grid-column: 2; grid-row: 1 / span 2; align-self: center; display: flex; gap: 8px; }
    .empty { margin-top: 32px; color: #6b7280; }
    @media (max-width: 600px) {
      article { grid-template-columns: 1fr; }
      article .actions { grid-column: 1; grid-row: auto; justify-self: start; flex-wrap: wrap; }
    }
  </style>
</head>
<body>
  <h1>Fotoboek-video beheer</h1>
  <p>Scan de videomap en maak ontbrekende geheime links en QR-codes aan.</p>
  <form method="post" action="/admin/generate">
    <button type="submit">Video's scannen en QR-codes genereren</button>
  </form>
  ${resultHtml}
  ${videosHtml}
  <script>
    document.querySelectorAll(".copy").forEach((button) => {
      button.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(button.dataset.url);
        } catch {
          const input = document.createElement("textarea");
          input.value = button.dataset.url;
          input.style.position = "fixed";
          input.style.opacity = "0";
          document.body.appendChild(input);
          input.select();
          document.execCommand("copy");
          input.remove();
        }
        const originalText = button.textContent;
        button.textContent = "Gekopieerd!";
        setTimeout(() => { button.textContent = originalText; }, 1600);
      });
    });
  </script>
</body>
</html>`;
}

app.get("/admin", requireAdmin, (req, res) => {
  res.status(200).type("html").send(adminPage());
});

app.get("/admin/qr/:id", requireAdmin, (req, res) => {
  const id = String(req.params.id || "");
  const mapping = loadMapping();

  if (!/^[a-f0-9]{10}$/.test(id) || !mapping[id] || !fs.existsSync(QR_DIR)) {
    res.status(404).send("QR-code niet gevonden.");
    return;
  }

  const qrFileName = fs.readdirSync(QR_DIR).find((fileName) =>
    fileName === `${id}.png` || fileName.endsWith(`--${id}.png`)
  );

  if (!qrFileName) {
    res.status(404).send("QR-code niet gevonden. Draai eerst de generator.");
    return;
  }

  res.download(path.join(QR_DIR, qrFileName), qrFileName);
});

app.post("/admin/generate", requireAdmin, (req, res) => {
  if (generationInProgress) {
    res.status(409).type("html").send(adminPage("Er draait al een scan. Probeer het straks opnieuw."));
    return;
  }

  generationInProgress = true;
  execFile(process.execPath, [path.join(__dirname, "generate.js")], { timeout: 5 * 60 * 1000 }, (error, stdout, stderr) => {
    generationInProgress = false;
    const output = [stdout, stderr].filter(Boolean).join("\n").trim();

    if (error) {
      res.status(500).type("html").send(adminPage(`Genereren mislukt.\n${output || error.message}`));
      return;
    }

    res.status(200).type("html").send(adminPage(output || "Genereren voltooid."));
  });
});

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

  const videoTitle = path.parse(relativePath).name;
  const escapedTitle = escapeHtml(videoTitle);
  const pageUrl = `${BASE_URL}/v?id=${encodeURIComponent(id)}`;

  const html = `<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapedTitle}</title>
  <meta name="description" content="Bekijk ${escapedTitle}" />
  <meta property="og:type" content="video.other" />
  <meta property="og:title" content="${escapedTitle}" />
  <meta property="og:description" content="Bekijk deze video" />
  <meta property="og:url" content="${escapeHtml(pageUrl)}" />
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

// Geen enkele andere route bestaat (dus ook geen mapoverzicht of index-listing).
// /admin is alleen beschikbaar met het beheerderswachtwoord.
app.use((req, res) => {
  res.status(404).send("Niet gevonden.");
});

app.listen(PORT, () => {
  console.log(`Server draait op poort ${PORT}`);
});
