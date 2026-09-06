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
const QRCode = require("qrcode");
const { loadArchive, withDataLock } = require("./archive");

const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(__dirname, "videos");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const QR_DIR = path.join(DATA_DIR, "qrcodes");
const FOLDER_QR_DIR = path.join(DATA_DIR, "folder-qrcodes");
const THUMB_DIR = path.join(DATA_DIR, "thumbnails");
const STREAM_DIR = path.join(DATA_DIR, "streamable");
const MAPPING_FILE = path.join(DATA_DIR, "mapping.json");
const GALLERY_SETTINGS_FILE = path.join(DATA_DIR, "gallery-settings.json");
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || "https://albumvideo.gerdjan.nl").replace(/\/$/, "");
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";

const app = express();
app.use(express.urlencoded({ extended: false, limit: "20kb" }));
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

function qrDownloadFileName(relativePath, id) {
  const extension = path.extname(relativePath);
  const withoutExtension = relativePath.slice(0, -extension.length);
  const readableName = withoutExtension
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 100) || "video";

  return `${readableName}--${id}.png`;
}

function folderQrFileName(folder) {
  const readableName = folder
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 100) || "map";
  const suffix = crypto.createHash("sha256").update(folder).digest("hex").slice(0, 8);
  return `${readableName}--${suffix}.png`;
}

function mappedFolders(mapping) {
  return [...new Set(Object.values(mapping)
    .map((relativePath) => path.dirname(relativePath))
    .filter((folder) => folder !== "."))]
    .sort((left, right) => left.localeCompare(right, "nl"));
}

function loadGallerySettings() {
  if (!fs.existsSync(GALLERY_SETTINGS_FILE)) return {};
  return JSON.parse(fs.readFileSync(GALLERY_SETTINGS_FILE, "utf8"));
}

function saveGallerySettings(settings) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(GALLERY_SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

function defaultGallerySettings(folder) {
  const isThailand = folder.toLocaleLowerCase("nl") === "thailand";
  return {
    theme: isThailand ? "thailand" : "default",
    title: isThailand ? "ONZE THAILAND FILMS" : folder,
    subtitle: isThailand ? "THAILAND · VERDONK & VAN GILS · 2026" : "",
  };
}

function displayVideoTitle(relativePath) {
  let title = path.parse(relativePath).name
    .replace(/\(\s*\d+\s*\)/g, " ")
    .replace(/compleet[\s_-]*9\s*[x×]\s*16/gi, " ")
    .replace(/\bcompleet\b/gi, " ")
    .replace(/[_-]+/g, " ")
    .replace(/^thailand\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();

  const normalized = title.toLocaleLowerCase("nl");
  const preferredTitles = {
    "river kwai 2": "The River Kwai",
    "river kwai": "The River Kwai",
    "fietsen bangkok": "Fietsen in Bangkok",
    "santichon schommel": "Santichon Village — Schommel",
  };
  if (preferredTitles[normalized]) return preferredTitles[normalized];
  return title ? title.charAt(0).toLocaleUpperCase("nl") + title.slice(1) : "Video";
}

// Explicit separators keep multi-word places intact; ambiguous names remain editable.
function parseVideoLabel(relativePath) {
  let name = path.parse(relativePath).name
    .replace(/\(\s*\d+\s*\)/g, " ")
    .replace(/compleet[\s_-]*9\s*[x×]\s*16/gi, " ")
    .replace(/\bcompleet\b/gi, " ")
    .replace(/^thailand[\s_-]+/i, "").trim();
  const match = name.match(/^(?:(?:step|stap)\s*(?:nr\.?\s*)?[_-]?\s*)?(\d{1,3})(?:[\s._-]+|$)/i);
  const step = match ? match[1] : "";
  if (match) name = name.slice(match[0].length).trim();
  const separator = /\s[-–—]\s|__+/.test(name) ? /\s+[-–—]\s+|__+/ : /[_–—-]+/;
  const parts = name.split(separator).map(part => part.replace(/_/g, " ").replace(/\s+/g, " ").trim()).filter(Boolean);
  return {
    step,
    city: parts.length > 1 ? parts[0] : "",
    activity: parts.length > 1 ? parts.slice(1).join(" ") : displayVideoTitle(name + ".mp4"),
  };
}

function adminPage(result = "") {
  const resultHtml = result ? `<pre>${escapeHtml(result)}</pre>` : "";
  const mapping = loadMapping();
  const videos = Object.entries(mapping).sort((left, right) => {
    const folderOrder = path.dirname(left[1]).localeCompare(path.dirname(right[1]), "nl");
    if (folderOrder) return folderOrder;
    const leftStep = parseVideoLabel(left[1]).step;
    const rightStep = parseVideoLabel(right[1]).step;
    if (Boolean(leftStep) !== Boolean(rightStep)) return leftStep ? -1 : 1;
    if (leftStep && rightStep && Number(leftStep) !== Number(rightStep)) return Number(leftStep) - Number(rightStep);
    return left[1].localeCompare(right[1], "nl", { numeric: true });
  });
  const folders = mappedFolders(mapping);
  const gallerySettings = loadGallerySettings();
  const frozenAlbums = loadArchive(DATA_DIR).albums;
  const foldersHtml = folders.length
    ? `<section>
        <h2>Vakantie-albums</h2>
        <div class="videos">
          ${folders.map((folder) => {
            const url = `${BASE_URL}/gallery?folder=${encodeURIComponent(folder)}`;
            const settings = { ...defaultGallerySettings(folder), ...gallerySettings[folder] };
            return `<article>
              <strong>${escapeHtml(folder)}</strong>
              <a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>
              <div class="actions">
                <button class="copy" type="button" data-url="${escapeHtml(url)}">Kopieer link</button>
                <button class="design" type="button" data-url="${escapeHtml(url)}" data-title="${escapeHtml(settings.title)}">Ontwerp kader</button>
                <a class="button secondary" href="/admin/folder-qr?folder=${encodeURIComponent(folder)}">Download QR</a>
              </div>
              <form method="post" action="/admin/freeze" class="freeze-settings">
                <input type="hidden" name="folder" value="${escapeHtml(folder)}" />
                <label><input type="checkbox" name="freeze" value="yes" required${frozenAlbums[folder] ? " checked disabled" : ""} /> Fotoboek besteld — dit album blijvend bevriezen</label>
                <small>${frozenAlbums[folder] ? `Bevroren op ${escapeHtml(new Date(frozenAlbums[folder].frozenAt).toLocaleDateString("nl-NL"))}. De gedrukte QR-links gebruiken het archief. Nieuwe editie? Gebruik een andere map.` : "Bewaart een aparte kopie van de huidige video's en pagina's. Bestaande QR-links blijven deze editie openen. Dit kost extra schijfruimte. Neem het archief mee in je NAS-back-up."}</small>
                ${frozenAlbums[folder] ? "" : '<button type="submit">Album bevriezen</button>'}
              </form>
              <form class="album-settings" method="post" action="/admin/gallery-settings">
                <fieldset${frozenAlbums[folder] ? " disabled" : ""} style="display:contents">
                <input type="hidden" name="folder" value="${escapeHtml(folder)}" />
                <label>Vormgeving
                  <select name="theme">
                    <option value="default"${settings.theme === "default" ? " selected" : ""}>Standaard</option>
                    <option value="thailand"${settings.theme === "thailand" ? " selected" : ""}>Thailand-reisdagboek</option>
                  </select>
                </label>
                <label>Paginatitel
                  <input name="title" maxlength="80" value="${escapeHtml(settings.title)}" />
                </label>
                <label>Subtitel
                  <input name="subtitle" maxlength="120" value="${escapeHtml(settings.subtitle)}" />
                </label>
                <button type="submit">Instellingen opslaan</button>
                </fieldset>
              </form>
            </article>`;
          }).join("")}
        </div>
      </section>`
    : "";
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
                <button class="design" type="button" data-url="${escapeHtml(url)}" data-id="${escapeHtml(id)}" data-title="${escapeHtml(parseVideoLabel(relativePath).activity)}" data-city="${escapeHtml(parseVideoLabel(relativePath).city)}" data-step="${escapeHtml(parseVideoLabel(relativePath).step)}">Ontwerp kader</button>
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
    .button.secondary, button.secondary { background: #374151; }
    .button.secondary:hover, button.secondary:hover { background: #1f2937; }
    pre { margin-top: 24px; padding: 16px; overflow: auto; border-radius: 8px; background: #f3f4f6; white-space: pre-wrap; }
    section { margin-top: 36px; }
    .studio { padding: 24px; border: 1px solid #f2bdd2; border-radius: 18px; background: #fff8fb; box-shadow: 0 18px 45px rgba(143, 20, 72, .08); }
    .studio h2 { margin: 0 0 4px; font-family: Georgia, serif; font-size: 30px; color: #7d123f; }
    .studio-intro { margin: 0 0 22px; color: #765565; }
    .studio-grid { display: grid; grid-template-columns: minmax(0, 1fr) 280px; gap: 24px; align-items: start; }
    .fields { display: grid; gap: 16px; }
    label { display: grid; gap: 6px; font-weight: 700; color: #5d293f; }
    input, select { min-width: 0; border: 1px solid #dba8bd; border-radius: 9px; padding: 11px 12px; background: white; color: #2b1720; font: inherit; }
    input:focus, select:focus { outline: 3px solid rgba(226, 15, 103, .15); border-color: #df1768; }
    .export-actions { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
    .preview-shell { padding: 14px; border-radius: 12px; background: white; box-shadow: 0 10px 28px rgba(64, 21, 39, .12); }
    .preview-shell.transparent { background-color: #f7f7f7; background-image: linear-gradient(45deg, #e6e6e6 25%, transparent 25%), linear-gradient(-45deg, #e6e6e6 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #e6e6e6 75%), linear-gradient(-45deg, transparent 75%, #e6e6e6 75%); background-size: 24px 24px; background-position: 0 0, 0 12px, 12px -12px, -12px 0; }
    #qr-canvas { display: block; width: 100%; height: auto; background: transparent; }
    .print-note { margin: 10px 0 0; color: #806573; font-size: 13px; text-align: center; }
    .videos { display: grid; gap: 12px; }
    article { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 16px; padding: 16px; border: 1px solid #d1d5db; border-radius: 10px; }
    article strong, article > a { overflow-wrap: anywhere; }
    article > a { color: #1d4ed8; }
    article .actions { grid-column: 2; grid-row: 1 / span 2; align-self: center; display: flex; gap: 8px; }
    .album-settings { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)) auto; gap: 10px; align-items: end; margin-top: 12px; padding-top: 14px; border-top: 1px dashed #d1d5db; }
    .freeze-settings { grid-column: 1 / -1; display: grid; gap: 10px; padding-top: 16px; border-top: 1px solid #d1d5db; }
    .freeze-settings input[type="checkbox"] { width: auto; }
    .album-settings label { font-size: 13px; }
    .album-settings button { white-space: nowrap; }
    .batch-row[hidden] { display: none; }
    #batch-form > label { display: grid; gap: 5px; margin: 12px 0; }
    #batch-form > label input, #batch-folder { width: 100%; box-sizing: border-box; padding: 10px; font: inherit; }
    .batch-row { grid-template-columns: repeat(2, minmax(0, 1fr)); background: #fff; }
    .batch-row strong { grid-column: 1 / -1; font-size: 13px; color: #6b7280; }
    .batch-row label { display: grid; gap: 5px; }
    .batch-row input { box-sizing: border-box; width: 100%; min-width: 0; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; }
    #download-all { margin-top: 18px; background: #bf175d; }
    button:disabled { opacity: .55; cursor: wait; }
    .empty { margin-top: 32px; color: #6b7280; }
    @media (max-width: 600px) {
      .studio { padding: 18px; }
      .studio-grid { grid-template-columns: 1fr; }
      .preview-shell { max-width: 320px; }
      article { grid-template-columns: 1fr; }
      article .actions { grid-column: 1; grid-row: auto; justify-self: start; flex-wrap: wrap; }
      .album-settings { grid-template-columns: 1fr; }
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
  <section class="studio" id="qr-studio">
    <h2>QR Studio</h2>
    <p class="studio-intro">Maak een drukklare QR-kaart voor het Thailand-fotoboek.</p>
    <div class="studio-grid">
      <div class="fields">
        <label>URL
          <input id="design-url" type="url" value="${escapeHtml(BASE_URL)}" placeholder="https://…" />
        </label>
        <label>Stapnummer
          <input id="design-step" type="text" maxlength="12" placeholder="Optioneel" />
        </label>
        <label>Stad / plaats
          <input id="design-city" type="text" maxlength="60" placeholder="Bijvoorbeeld Bangkok" />
        </label>
        <label>Activiteit / albumtitel
          <input id="design-title" type="text" maxlength="80" value="VIDEO" placeholder="Bijvoorbeeld Fietsen" />
        </label>
        <label>Stijl
          <select id="design-style">
            <option value="pink">Roze reiskader</option>
            <option value="photo">Startbeeld-filmkaart</option>
            <option value="clean">Rustig zonder kader</option>
          </select>
        </label>
        <label>Startbeeld
          <input id="design-image" type="file" accept="image/png,image/jpeg,image/webp" />
          <small>Blijft lokaal in je browser; gebruik dit veld voor de startbeeld-filmkaart.</small>
        </label>
        <label>Achtergrond
          <select id="design-background">
            <option value="transparent">Transparant</option>
            <option value="white">Wit · Albelli veilig</option>
          </select>
        </label>
        <div class="export-actions">
          <button id="download-design" type="button">Download PNG · 300 dpi</button>
          <button id="download-jpg" class="secondary" type="button">JPG reserve</button>
        </div>
      </div>
      <div>
        <div class="preview-shell transparent"><canvas id="qr-canvas" width="1800" height="2250"></canvas></div>
        <p class="print-note" id="print-note">Transparante PNG · 1800 × 2250 px · 300 dpi</p>
      </div>
    </div>
  </section>
  <section class="studio" id="batch-studio">
    <h2>Vakantiealbum downloaden</h2>
    <p>Kies een map: de ZIP bevat alle videokaarten uit die map én een QR-kaart voor de totaalpagina. Alle kaarten gebruiken de gekozen QR Studio-stijl en achtergrond, op 1800 × 2250 px en 300 dpi.</p>
    <form id="batch-form">
      <label>Vakantiemap
        <select id="batch-folder" required>
          ${folders.map(folder => {
            const settings = { ...defaultGallerySettings(folder), ...gallerySettings[folder] };
            return `<option value="${escapeHtml(folder)}" data-title="${escapeHtml(settings.title)}" data-url="${escapeHtml(`${BASE_URL}/gallery?folder=${encodeURIComponent(folder)}`)}">${escapeHtml(folder)}</option>`;
          }).join("")}
        </select>
      </label>
      <label>Titel op de albumkaart <input id="batch-album-title" required maxlength="80" /></label>
      <p><small>Controleer de herkende stap, plaats en activiteit. Naamvoorbeeld: 01 - Chiang Mai - Tempelbezoek.mp4. Bij de filmkaart krijgt de albumkaart het startbeeld van de eerste video.</small></p>
      <div class="videos">
        ${videos.map(([id, relativePath]) => {
          const label = parseVideoLabel(relativePath);
          return `<article class="batch-row" data-folder="${escapeHtml(path.dirname(relativePath))}" data-id="${escapeHtml(id)}" data-url="${escapeHtml(`${BASE_URL}/v?id=${encodeURIComponent(id)}`)}">
          <strong>${escapeHtml(relativePath)}</strong>
          <label>Stapnummer <input class="batch-step" maxlength="12" value="${escapeHtml(label.step)}" placeholder="Optioneel" /></label>
          <label>Plaats <input class="batch-city" required maxlength="60" value="${escapeHtml(label.city)}" placeholder="Bijvoorbeeld Bangkok" /></label>
          <label>Activiteit <input class="batch-activity" required maxlength="80" value="${escapeHtml(label.activity)}" /></label>
        </article>`;
        }).join("")}
      </div>
      <p><small>De teksten blijven in deze pagina staan zolang je niet vernieuwt. Houd de pagina open tijdens het maken van de ZIP.</small></p>
      <button id="download-all" type="submit"${folders.length ? "" : " disabled"}>Download vakantiealbum (.zip)</button>
      <p id="batch-status" role="status" aria-live="polite"></p>
    </form>
  </section>
  ${foldersHtml}
  ${videosHtml}
  <script>
    const canvas = document.getElementById("qr-canvas");
    const context = canvas.getContext("2d", { alpha: true });
    const urlInput = document.getElementById("design-url");
    const titleInput = document.getElementById("design-title");
    const cityInput = document.getElementById("design-city");
    const stepInput = document.getElementById("design-step");
    const styleInput = document.getElementById("design-style");
    const imageInput = document.getElementById("design-image");
    const backgroundInput = document.getElementById("design-background");
    const previewShell = document.querySelector(".preview-shell");
    const printNote = document.getElementById("print-note");
    let qrImage = null;
    let startImage = null;
    let qrTimer = null;

    function roundedRect(ctx, x, y, width, height, radius) {
      ctx.beginPath();
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + width - radius, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
      ctx.lineTo(x + width, y + height - radius);
      ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
      ctx.lineTo(x + radius, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
    }

    function fitTitle(title) {
      let size = 132;
      context.font = "800 " + size + "px 'Avenir Next Condensed', 'Trebuchet MS', sans-serif";
      while (size > 62 && context.measureText(title).width > 1180) {
        size -= 4;
        context.font = "800 " + size + "px 'Avenir Next Condensed', 'Trebuchet MS', sans-serif";
      }
      return size;
    }

    function drawVideoIcon(centerX, centerY) {
      context.save();
      context.strokeStyle = "#202020";
      context.fillStyle = "#202020";
      context.lineWidth = 12;
      context.beginPath();
      context.roundRect(centerX - 48, centerY - 38, 82, 76, 14);
      context.stroke();
      context.beginPath();
      context.moveTo(centerX - 15, centerY - 21);
      context.lineTo(centerX + 18, centerY);
      context.lineTo(centerX - 15, centerY + 21);
      context.closePath();
      context.fill();
      context.beginPath();
      context.moveTo(centerX + 40, centerY - 21);
      context.lineTo(centerX + 67, centerY - 38);
      context.lineTo(centerX + 67, centerY + 38);
      context.lineTo(centerX + 40, centerY + 21);
      context.closePath();
      context.stroke();
      context.restore();
    }

    function drawPinkDetails() {
      context.save();
      context.fillStyle = "#ea6b9f";
      for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < 9; column += 1) {
          context.beginPath();
          context.arc(315 + column * 34, 1740 + row * 34, 6, 0, Math.PI * 2);
          context.fill();
        }
      }
      context.strokeStyle = "#dc4f8a";
      context.lineWidth = 13;
      context.lineCap = "round";
      for (let line = 0; line < 3; line += 1) {
        context.beginPath();
        context.moveTo(1330, 1740 + line * 36);
        context.lineTo(1485, 1716 + line * 36);
        context.stroke();
      }
      context.restore();
    }

    function drawImageCover(image, x, y, width, height, radius) {
      const scale = Math.max(width / image.naturalWidth, height / image.naturalHeight);
      const sourceWidth = width / scale;
      const sourceHeight = height / scale;
      const sourceX = (image.naturalWidth - sourceWidth) / 2;
      const sourceY = (image.naturalHeight - sourceHeight) / 2;
      context.save();
      roundedRect(context, x, y, width, height, radius);
      context.clip();
      context.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight, x, y, width, height);
      context.restore();
    }

    function cardCaption(step, city) {
      return [step.trim() ? "Stap " + step.trim() : "", city.trim()].filter(Boolean).join(" · ");
    }

    function drawDesign(city = cardCaption(stepInput.value, cityInput.value)) {
      if (typeof city !== "string") city = cardCaption(stepInput.value, cityInput.value);
      const title = (titleInput.value.trim() || "VIDEO").toUpperCase();
      const pink = styleInput.value === "pink";
      const photo = styleInput.value === "photo";
      const transparent = backgroundInput.value === "transparent";
      context.save();
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (!transparent) {
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, canvas.width, canvas.height);
      }

      if (pink) {
        context.strokeStyle = "#df0e68";
        context.lineWidth = 34;
        context.lineCap = "round";
        context.lineJoin = "round";
        roundedRect(context, 205, 155, 1390, 1500, 72);
        context.stroke();
        context.strokeStyle = "#ee92b8";
        context.lineWidth = 9;
        roundedRect(context, 245, 195, 1310, 1420, 54);
        context.stroke();
      }

      if (photo) {
        if (startImage) {
          drawImageCover(startImage, 120, 105, 1560, 620, 64);
        } else {
          context.fillStyle = "rgba(223, 14, 104, .10)";
          roundedRect(context, 120, 105, 1560, 620, 64);
          context.fill();
          context.fillStyle = "#9b5975";
          context.font = "700 48px 'Avenir Next Condensed', 'Trebuchet MS', sans-serif";
          context.textAlign = "center";
          context.fillText("KIES EEN STARTBEELD", 900, 430);
          context.textAlign = "start";
        }
        context.strokeStyle = "#df0e68";
        context.lineWidth = 18;
        roundedRect(context, 120, 105, 1560, 620, 64);
        context.stroke();
      }

      const qrX = photo ? 410 : 300;
      const qrY = photo ? 775 : 250;
      const qrSize = photo ? 980 : 1200;
      if (!transparent) {
        context.fillStyle = "#ffffff";
        context.fillRect(qrX - 5, qrY - 5, qrSize + 10, qrSize + 10);
      }
      if (qrImage) {
        context.imageSmoothingEnabled = false;
        context.drawImage(qrImage, qrX, qrY, qrSize, qrSize);
      } else {
        context.fillStyle = transparent ? "rgba(223, 14, 104, .08)" : "#f7e8ef";
        context.fillRect(qrX, qrY, qrSize, qrSize);
      }

      if (pink) drawPinkDetails();

      if (city) {
        context.fillStyle = "#9b5975";
        context.font = "700 70px 'Avenir Next Condensed', 'Trebuchet MS', sans-serif";
        context.textAlign = "center";
        context.fillText(city.toUpperCase(), 900, photo ? 1870 : 1780, 1380);
        context.textAlign = "start";
      }
      const fontSize = fitTitle(title);
      const textWidth = Math.min(context.measureText(title).width, 1180);
      const iconWidth = 120;
      const gap = 42;
      const startX = (canvas.width - textWidth - iconWidth - gap) / 2;
      const titleY = photo ? 2010 : 1940;
      drawVideoIcon(startX + 48, titleY - 38);
      context.fillStyle = "#202020";
      context.textBaseline = "alphabetic";
      context.fillText(title, startX + iconWidth + gap, titleY, 1180);

      if (pink || photo) {
        context.strokeStyle = "#df0e68";
        context.lineWidth = 20;
        context.lineCap = "round";
        context.beginPath();
        const lineY = photo ? 2120 : 2045;
        context.moveTo(530, lineY);
        context.quadraticCurveTo(900, lineY + 25, 1270, lineY);
        context.stroke();
      }
      context.restore();
    }

    let qrRequest = 0;
    async function loadImage(url) {
      const image = new Image();
      image.src = url;
      await image.decode();
      return image;
    }

    async function fetchQr(value, transparent) {
      const response = await fetch("/admin/qr-preview?transparent=" + (transparent ? "1" : "0") + "&url=" + encodeURIComponent(value));
      if (!response.ok) throw new Error("QR-code kon niet worden geladen");
      const objectUrl = URL.createObjectURL(await response.blob());
      try { return await loadImage(objectUrl); }
      finally { URL.revokeObjectURL(objectUrl); }
    }

    async function updateQr() {
      const request = ++qrRequest;
      try {
        const image = urlInput.value.trim() ? await fetchQr(urlInput.value.trim(), backgroundInput.value === "transparent") : null;
        if (request !== qrRequest) return;
        qrImage = image;
      } catch {
        if (request !== qrRequest) return;
        qrImage = null;
      }
      drawDesign();
    }

    function crc32(bytes) {
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
      }
      return (crc ^ 0xffffffff) >>> 0;
    }

    async function pngAt300Dpi(blob) {
      const source = new Uint8Array(await blob.arrayBuffer());
      const chunk = new Uint8Array(21);
      const view = new DataView(chunk.buffer);
      view.setUint32(0, 9);
      chunk.set([112, 72, 89, 115], 4);
      view.setUint32(8, 11811);
      view.setUint32(12, 11811);
      chunk[16] = 1;
      view.setUint32(17, crc32(chunk.slice(4, 17)));
      const output = new Uint8Array(source.length + chunk.length);
      output.set(source.slice(0, 33), 0);
      output.set(chunk, 33);
      output.set(source.slice(33), 54);
      return new Blob([output], { type: "image/png" });
    }

    function downloadBlob(blob, extension) {
      const slug = fileSlug([stepInput.value.trim(), cityInput.value.trim(), titleInput.value.trim()].filter(Boolean).join("-"));
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "qr-" + (slug || "video") + "." + extension;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }

    // ZIP in store mode: PNGs are already compressed. No external service needed.
    function zipFiles(files) {
      const parts = [], directory = [];
      let offset = 0, directorySize = 0;
      if (files.length > 65535) throw new Error("Te veel kaarten voor één ZIP");
      for (const file of files) {
        const name = new TextEncoder().encode(file.name);
        const crc = crc32(file.bytes);
        const local = new Uint8Array(30 + name.length);
        const lv = new DataView(local.buffer);
        lv.setUint32(0, 0x04034b50, true);
        lv.setUint16(4, 20, true);
        lv.setUint16(6, 0x0800, true);
        lv.setUint16(12, 33, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, file.bytes.length, true);
        lv.setUint32(22, file.bytes.length, true);
        lv.setUint16(26, name.length, true);
        local.set(name, 30);
        const central = new Uint8Array(46 + name.length);
        const cv = new DataView(central.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true);
        central.set(local.slice(4, 30), 6);
        cv.setUint32(42, offset, true);
        central.set(name, 46);
        parts.push(local, file.bytes);
        directory.push(central);
        offset += local.length + file.bytes.length;
        directorySize += central.length;
        if (offset + directorySize > 0xffffffff) throw new Error("ZIP is te groot");
      }
      const end = new Uint8Array(22);
      const ev = new DataView(end.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, files.length, true);
      ev.setUint16(10, files.length, true);
      ev.setUint32(12, directorySize, true);
      ev.setUint32(16, offset, true);
      return new Blob([...parts, ...directory, end], { type: "application/zip" });
    }

    const folderInput = document.getElementById("batch-folder");
    const albumTitleInput = document.getElementById("batch-album-title");
    const albumTitles = new Map();
    albumTitleInput.addEventListener("input", () => albumTitles.set(folderInput.value, albumTitleInput.value));
    function selectBatchFolder() {
      const folder = folderInput.value;
      albumTitleInput.value = albumTitles.get(folder) ?? folderInput.selectedOptions[0]?.dataset.title ?? "";
      let count = 0;
      document.querySelectorAll(".batch-row").forEach(row => {
        row.hidden = row.dataset.folder !== folder;
        row.querySelectorAll("input").forEach(input => { input.disabled = row.hidden; });
        if (!row.hidden) count++;
      });
      document.getElementById("download-all").disabled = !count;
      document.getElementById("batch-status").textContent = count ? count + " videokaarten + 1 albumkaart in de ZIP." : "Geen video's in deze map.";
    }
    folderInput.addEventListener("change", selectBatchFolder);
    selectBatchFolder();

    async function cardBytes(url, title, caption, thumbnailId) {
      qrImage = await fetchQr(url, backgroundInput.value === "transparent");
      if (styleInput.value === "photo") startImage = await loadImage("/thumb/" + encodeURIComponent(thumbnailId));
      titleInput.value = title;
      drawDesign(caption);
      const png = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("PNG maken mislukt")), "image/png"));
      return new Uint8Array(await (await pngAt300Dpi(png)).arrayBuffer());
    }

    function fileSlug(value) {
      return value.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase().slice(0, 120) || "kaart";
    }

    document.getElementById("batch-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const rows = [...document.querySelectorAll(".batch-row")].filter(row => row.dataset.folder === folderInput.value);
      if (!rows.length) return;
      const status = document.getElementById("batch-status");
      const saved = { title: titleInput.value, qr: qrImage, image: startImage };
      const controls = [...document.querySelectorAll("input, button, select")];
      const disabled = controls.map((control) => control.disabled);
      clearTimeout(qrTimer);
      ++qrRequest;
      controls.forEach((control) => { control.disabled = true; });
      try {
        const option = folderInput.selectedOptions[0];
        const albumTitle = albumTitleInput.value.trim();
        if (!albumTitle) throw new Error("Vul een titel in voor de albumkaart");
        status.textContent = "Albumkaart maken: " + albumTitle;
        const files = [{ name: "00-album-" + fileSlug(albumTitle) + ".png", bytes: await cardBytes(option.dataset.url, albumTitle, "Alle video's", rows[0].dataset.id) }];
        for (const [index, row] of rows.entries()) {
          const city = row.querySelector(".batch-city").value.trim();
          const activity = row.querySelector(".batch-activity").value.trim();
          if (!city || !activity) throw new Error("Vul voor elke video een stadsnaam en activiteit in.");
          status.textContent = "Kaart " + (index + 1) + " van " + rows.length + ": " + city + " · " + activity;
          const step = row.querySelector(".batch-step").value.trim();
          const caption = cardCaption(step, city);
          const bytes = await cardBytes(row.dataset.url, activity, caption, row.dataset.id);
          files.push({ name: String(index + 1).padStart(3, "0") + "-" + fileSlug([step, city, activity].filter(Boolean).join("-")) + ".png", bytes });
        }
        const link = document.createElement("a");
        link.href = URL.createObjectURL(zipFiles(files));
        link.download = "qr-" + fileSlug(folderInput.value) + ".zip";
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 60000);
        status.textContent = files.length + " QR-kaarten klaar. De ZIP-download is gestart.";
      } catch (error) {
        status.textContent = "Download niet gemaakt: " + error.message + ". Controleer de teksten en startbeelden en probeer opnieuw.";
      } finally {
        titleInput.value = saved.title;
        qrImage = saved.qr;
        startImage = saved.image;
        controls.forEach((control, index) => { control.disabled = disabled[index]; });
        drawDesign();
        updateQr();
      }
    });

    document.querySelectorAll(".design").forEach((button) => {
      button.addEventListener("click", () => {
        urlInput.value = button.dataset.url;
        const row = [...document.querySelectorAll(".batch-row")].find(row => row.dataset.id === button.dataset.id);
        titleInput.value = row ? row.querySelector(".batch-activity").value : button.dataset.title;
        cityInput.value = row ? row.querySelector(".batch-city").value : button.dataset.city || "";
        stepInput.value = row ? row.querySelector(".batch-step").value : button.dataset.step || "";
        document.getElementById("qr-studio").scrollIntoView({ behavior: "smooth", block: "start" });
        updateQr();
      });
    });

    urlInput.addEventListener("input", () => {
      clearTimeout(qrTimer);
      qrTimer = setTimeout(updateQr, 300);
    });
    titleInput.addEventListener("input", drawDesign);
    cityInput.addEventListener("input", drawDesign);
    stepInput.addEventListener("input", drawDesign);
    styleInput.addEventListener("change", drawDesign);
    imageInput.addEventListener("change", () => {
      const file = imageInput.files && imageInput.files[0];
      if (!file) {
        startImage = null;
        drawDesign();
        return;
      }
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        startImage = image;
        styleInput.value = "photo";
        drawDesign();
      };
      image.src = objectUrl;
    });
    backgroundInput.addEventListener("change", () => {
      const transparent = backgroundInput.value === "transparent";
      previewShell.classList.toggle("transparent", transparent);
      printNote.textContent = transparent
        ? "Transparante PNG · 1800 × 2250 px · 300 dpi"
        : "Witte PNG · 1800 × 2250 px · 300 dpi · Albelli veilig";
      updateQr();
    });
    document.getElementById("download-design").addEventListener("click", () => {
      canvas.toBlob(async (blob) => downloadBlob(await pngAt300Dpi(blob), "png"), "image/png");
    });
    document.getElementById("download-jpg").addEventListener("click", () => {
      const jpgCanvas = document.createElement("canvas");
      jpgCanvas.width = canvas.width;
      jpgCanvas.height = canvas.height;
      const jpgContext = jpgCanvas.getContext("2d", { alpha: false });
      jpgContext.fillStyle = "#ffffff";
      jpgContext.fillRect(0, 0, jpgCanvas.width, jpgCanvas.height);
      jpgContext.drawImage(canvas, 0, 0);
      jpgCanvas.toBlob((blob) => downloadBlob(blob, "jpg"), "image/jpeg", 0.96);
    });

    drawDesign();
    updateQr();

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

app.get("/admin/qr-preview", requireAdmin, async (req, res) => {
  const value = String(req.query.url || "").trim();
  const transparent = req.query.transparent === "1";

  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || value.length > 2048) {
      throw new Error("Ongeldige URL");
    }

    const png = await QRCode.toBuffer(value, {
      type: "png",
      width: 1200,
      margin: 4,
      errorCorrectionLevel: "M",
      color: { dark: "#111111", light: transparent ? "#00000000" : "#ffffff" },
    });
    res.status(200).type("png").send(png);
  } catch {
    res.status(400).send("Vul een geldige http- of https-URL in.");
  }
});

app.get("/admin/qr/:id", requireAdmin, (req, res) => {
  const id = String(req.params.id || "");
  const mapping = loadMapping();
  const archived = loadArchive(DATA_DIR).videos[id];
  if (archived) {
    res.download(path.join(archived.directory, `${id}.png`), qrDownloadFileName(archived.relativePath, id));
    return;
  }

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

  res.download(path.join(QR_DIR, qrFileName), qrDownloadFileName(mapping[id], id));
});

app.get("/admin/folder-qr", requireAdmin, (req, res) => {
  const folder = typeof req.query.folder === "string" ? req.query.folder : "";
  const mapping = loadMapping();

  if (!mappedFolders(mapping).includes(folder)) {
    res.status(404).send("Map-QR-code niet gevonden.");
    return;
  }

  const fileName = folderQrFileName(folder);
  const archived = loadArchive(DATA_DIR).albums[folder];
  if (archived) {
    res.download(path.join(archived.directory, "album.png"), fileName);
    return;
  }
  const absolutePath = path.join(FOLDER_QR_DIR, fileName);
  if (!fs.existsSync(absolutePath)) {
    res.status(404).send("Map-QR-code niet gevonden. Draai eerst de generator.");
    return;
  }

  res.download(absolutePath, fileName);
});

app.post("/admin/gallery-settings", requireAdmin, async (req, res) => {
  const folder = String(req.body.folder || "");
  const theme = String(req.body.theme || "default");
  const title = String(req.body.title || "").trim().slice(0, 80);
  const subtitle = String(req.body.subtitle || "").trim().slice(0, 120);
  const mapping = loadMapping();

  if (!mappedFolders(mapping).includes(folder) || !["default", "thailand"].includes(theme)) {
    res.status(400).type("html").send(adminPage("Ongeldige vakantie-instellingen."));
    return;
  }

  try {
    await withDataLock(DATA_DIR, async () => {
      if (loadArchive(DATA_DIR).albums[folder]) throw new Error("Dit album is bevroren. Maak een andere map voor een nieuwe editie.");
      const settings = loadGallerySettings();
      settings[folder] = { theme, title: title || folder, subtitle };
      saveGallerySettings(settings);
    });
    res.status(200).type("html").send(adminPage(`Instellingen voor ${folder} opgeslagen.`));
  } catch (error) {
    res.status(409).type("html").send(adminPage(error.message));
  }
});

app.post("/admin/freeze", requireAdmin, (req, res) => {
  const folder = typeof req.body.folder === "string" ? req.body.folder : "";
  if (req.body.freeze !== "yes" || !mappedFolders(loadMapping()).includes(folder)) {
    res.status(400).type("html").send(adminPage("Kies een bestaande map en vink bevriezen aan."));
    return;
  }
  if (generationInProgress) {
    res.status(409).type("html").send(adminPage("Er draait al een scan of archivering. Probeer het later opnieuw."));
    return;
  }
  generationInProgress = true;
  // Run copying in a worker so existing QR links keep responding during the copy.
  execFile(process.execPath, [path.join(__dirname, "freeze.js"), folder], (error, stdout, stderr) => {
    generationInProgress = false;
    res.status(error ? 500 : 200).type("html").send(adminPage(error
      ? `Bevriezen niet voltooid: ${stderr || error.message}. Het vinkje wordt pas na een volledige kopie actief.`
      : stdout));
  });
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
  const current = fs.existsSync(MAPPING_FILE) ? JSON.parse(fs.readFileSync(MAPPING_FILE, "utf8")) : {};
  const archive = loadArchive(DATA_DIR);
  // Suppress new/replaced live entries under a frozen gallery link.
  return { ...Object.fromEntries(Object.entries(current).filter(([, file]) => !archive.albums[path.dirname(file)])), ...archive.mapping };
}

// Afspeelpagina
app.get("/v", renderPlayer);
function renderPlayer(req, res) {
  const id = String(req.query.id || "");
  const archived = loadArchive(DATA_DIR).videos[id];
  if (archived) { res.sendFile(path.join(archived.directory, `${id}.html`)); return; }
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
    <video controls playsinline preload="metadata" poster="/thumb/${encodeURIComponent(id)}">
      <source src="/video/${encodeURIComponent(id)}" type="video/mp4" />
      Je browser ondersteunt deze video niet.
    </video>
  </div>
</body>
</html>`;

  res.status(200).type("html").send(html);
}

// Video-bestand zelf. res.sendFile ondersteunt Range-requests automatisch,
// dat is nodig zodat je op je telefoon door de video heen kunt spoelen.
// Als generate.js een "streamable" kopie heeft gemaakt (moov-atom vooraan,
// zie STREAM_DIR), gebruiken we die: de browser kan dan direct beginnen met
// afspelen in plaats van eerst het hele bestand te moeten downloaden.
app.get("/video/:id", (req, res) => {
  const archived = loadArchive(DATA_DIR).videos[req.params.id];
  if (archived) { res.sendFile(path.join(archived.directory, `${req.params.id}.mp4`)); return; }
  const mapping = loadMapping();
  const relativePath = mapping[req.params.id];

  if (!relativePath) {
    res.status(404).send("Video niet gevonden.");
    return;
  }

  const streamablePath = path.join(STREAM_DIR, `${req.params.id}.mp4`);
  const absolutePath = fs.existsSync(streamablePath) ? streamablePath : path.join(VIDEOS_DIR, relativePath);

  // Veiligheidscheck: voorkom dat iemand via het pad buiten de toegestane mappen komt
  if (!absolutePath.startsWith(path.resolve(VIDEOS_DIR)) && !absolutePath.startsWith(path.resolve(STREAM_DIR))) {
    res.status(400).send("Ongeldig pad.");
    return;
  }

  // Dezelfde ID blijft behouden als een bronvideo wordt vervangen. Laat de
  // browser daarom hervalideren, zodat een vernieuwde kopie zichtbaar wordt.
  res.set("Cache-Control", "public, max-age=0, must-revalidate");
  res.sendFile(absolutePath, (err) => {
    if (err && !res.headersSent) {
      res.status(404).send("Video niet gevonden.");
    }
  });
});

// Thumbnail (eerste frame) van een video, gebruikt als poster op de afspeelpagina
// en op de publieke galerij-pagina.
app.get("/thumb/:id", (req, res) => {
  const archived = loadArchive(DATA_DIR).videos[req.params.id];
  if (archived) {
    if (!archived.hasThumbnail) { res.status(404).send("Thumbnail niet gevonden."); return; }
    res.sendFile(path.join(archived.directory, `${req.params.id}.jpg`));
    return;
  }
  const mapping = loadMapping();
  const id = req.params.id;

  if (!mapping[id]) {
    res.status(404).send("Thumbnail niet gevonden.");
    return;
  }

  const thumbPath = path.join(THUMB_DIR, `${id}.jpg`);
  if (!fs.existsSync(thumbPath)) {
    res.status(404).send("Thumbnail niet gevonden.");
    return;
  }

  res.set("Cache-Control", "public, max-age=0, must-revalidate");
  res.sendFile(thumbPath);
});

app.get("/thailand-films.css", (req, res) => {
  res.set("Cache-Control", "public, max-age=3600");
  res.sendFile(path.join(__dirname, "thailand-films.css"));
});

app.use("/assets", express.static(path.join(__dirname, "assets"), {
  fallthrough: false,
  maxAge: "1h",
}));

// Publieke galerij: overzicht van alle video's per map, met thumbnails,
// zodat je ze ook aan mensen kunt laten zien zonder het fotoboek erbij.
app.get("/gallery", renderGallery);
function renderGallery(req, res) {
  const requestedFolder = typeof req.query.folder === "string" ? req.query.folder : null;
  const archived = loadArchive(DATA_DIR).albums[requestedFolder];
  if (archived) { res.sendFile(path.join(archived.directory, "gallery.html")); return; }
  const mapping = loadMapping();
  const folders = mappedFolders(mapping);

  if (requestedFolder !== null && !folders.includes(requestedFolder)) {
    res.status(404).send("Vakantie-album niet gevonden.");
    return;
  }

  const entries = Object.entries(mapping)
    .filter(([, relativePath]) => requestedFolder === null || path.dirname(relativePath) === requestedFolder)
    .sort((left, right) => left[1].localeCompare(right[1], "nl"));

  const groups = new Map();
  for (const [id, relativePath] of entries) {
    const folder = path.dirname(relativePath);
    const folderName = folder === "." ? "Overig" : folder;
    if (!groups.has(folderName)) groups.set(folderName, []);
    groups.get(folderName).push({ id, name: displayVideoTitle(relativePath) });
  }

  const storedSettings = loadGallerySettings();
  const activeSettings = requestedFolder === null
    ? null
    : { ...defaultGallerySettings(requestedFolder), ...storedSettings[requestedFolder] };
  const pageTitle = activeSettings?.title || "Video's";

  if (activeSettings?.theme === "thailand") {
    const videos = groups.get(requestedFolder) || [];
    const cardsHtml = videos.map(({ id, name }) => `
      <article class="film-card">
        <a class="film-card__link" href="/v?id=${encodeURIComponent(id)}" aria-label="Bekijk ${escapeHtml(name)}">
          <div class="film-card__image-wrap">
            <img src="/thumb/${encodeURIComponent(id)}" alt="${escapeHtml(name)}" loading="lazy" />
            <span class="film-card__play" aria-hidden="true"><span></span></span>
          </div>
          <h2><span class="film-card__icon" aria-hidden="true">▶</span> ${escapeHtml(name)}</h2>
        </a>
      </article>`).join("");

    res.status(200).type("html").send(`<!doctype html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${escapeHtml(activeSettings.subtitle || activeSettings.title)}" />
  <title>${escapeHtml(activeSettings.title)}</title>
  <link rel="stylesheet" href="/thailand-films.css" />
</head>
<body>
  <header class="travel-hero">
    <img class="travel-hero__art" src="/assets/thailand-header-decoration.svg" alt="" aria-hidden="true" />
    <div class="travel-hero__title-strip">
      <p class="travel-hero__eyebrow">Reisfilmarchief · Zuidoost-Azië</p>
      <h1>${escapeHtml(activeSettings.title)}</h1>
      ${activeSettings.subtitle ? `<p class="travel-hero__subtitle">${escapeHtml(activeSettings.subtitle)}</p>` : ""}
    </div>
  </header>
  <main class="travel-main">
    <a class="travel-back" href="/gallery">← Alle vakanties</a>
    <section aria-labelledby="vacation-label">
      <div class="section-label" id="vacation-label"><span aria-hidden="true">✦</span> ${escapeHtml(requestedFolder)} <span aria-hidden="true">✦</span></div>
      <div class="film-grid">${cardsHtml}</div>
    </section>
  </main>
  <footer class="travel-footer"><p>${escapeHtml(activeSettings.subtitle || requestedFolder)}</p></footer>
</body>
</html>`);
    return;
  }

  const sectionsHtml = groups.size
    ? [...groups.entries()].map(([folderName, videos]) => `
      <section>
        ${requestedFolder !== null
          ? ""
          : folderName === "Overig"
            ? `<h2>${escapeHtml(folderName)}</h2>`
            : `<h2><a href="/gallery?folder=${encodeURIComponent(folderName)}">${escapeHtml(folderName)}</a></h2>`}
        <div class="grid">
          ${videos.map(({ id, name }) => `
            <a class="card" href="/v?id=${encodeURIComponent(id)}">
              <img src="/thumb/${encodeURIComponent(id)}" alt="${escapeHtml(name)}" loading="lazy" />
              <span>${escapeHtml(name)}</span>
            </a>`).join("")}
        </div>
      </section>`).join("")
    : `<p class="empty">Nog geen video's beschikbaar.</p>`;

  res.status(200).type("html").send(`<!DOCTYPE html>
<html lang="nl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(pageTitle)}</title>
  <style>
    body { max-width: 960px; margin: 40px auto; padding: 0 20px; font: 16px/1.5 system-ui, sans-serif; color: #1f2937; }
    h1 { margin-bottom: 4px; }
    h2 { margin-top: 40px; text-transform: capitalize; }
    h2 a { color: inherit; text-decoration: none; }
    h2 a:hover { text-decoration: underline; }
    .back { display: inline-block; margin-bottom: 12px; color: #1d4ed8; }
    .subtitle { margin: 4px 0 28px; color: #6b7280; }
    .grid { columns: 4 150px; column-gap: 16px; }
    .card { display: inline-flex; width: 100%; margin-bottom: 16px; break-inside: avoid; flex-direction: column; gap: 8px; text-decoration: none; color: inherit; }
    .card img { display: block; width: 100%; height: auto; border-radius: 10px; background: #e5e7eb; }
    .card span { font-size: 14px; overflow-wrap: anywhere; }
    .batch-row[hidden] { display: none; }
    #batch-form > label { display: grid; gap: 5px; margin: 12px 0; }
    #batch-form > label input, #batch-folder { width: 100%; box-sizing: border-box; padding: 10px; font: inherit; }
    .batch-row { grid-template-columns: repeat(2, minmax(0, 1fr)); background: #fff; }
    .batch-row strong { grid-column: 1 / -1; font-size: 13px; color: #6b7280; }
    .batch-row label { display: grid; gap: 5px; }
    .batch-row input { box-sizing: border-box; width: 100%; min-width: 0; padding: 10px; border: 1px solid #d1d5db; border-radius: 6px; font: inherit; }
    #download-all { margin-top: 18px; background: #bf175d; }
    button:disabled { opacity: .55; cursor: wait; }
    .empty { margin-top: 32px; color: #6b7280; }
  </style>
</head>
<body>
  ${requestedFolder === null ? "" : `<a class="back" href="/gallery">← Alle vakanties</a>`}
  <h1>${escapeHtml(pageTitle)}</h1>
  ${activeSettings?.subtitle ? `<p class="subtitle">${escapeHtml(activeSettings.subtitle)}</p>` : ""}
  ${sectionsHtml}
</body>
</html>`);
}

// Geen enkele andere route bestaat (dus ook geen mapoverzicht of index-listing).
// /admin is alleen beschikbaar met het beheerderswachtwoord.
app.use((req, res) => {
  res.status(404).send("Niet gevonden.");
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server draait op poort ${PORT}`);
  });
}

module.exports = { app, adminPage, parseVideoLabel, renderGallery, renderPlayer };
