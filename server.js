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
                <button class="design" type="button" data-url="${escapeHtml(url)}" data-title="${escapeHtml(path.parse(relativePath).name)}">Ontwerp kader</button>
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
    .empty { margin-top: 32px; color: #6b7280; }
    @media (max-width: 600px) {
      .studio { padding: 18px; }
      .studio-grid { grid-template-columns: 1fr; }
      .preview-shell { max-width: 320px; }
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
  <section class="studio" id="qr-studio">
    <h2>QR Studio</h2>
    <p class="studio-intro">Maak een drukklare QR-kaart voor het Thailand-fotoboek.</p>
    <div class="studio-grid">
      <div class="fields">
        <label>URL
          <input id="design-url" type="url" value="${escapeHtml(BASE_URL)}" placeholder="https://…" />
        </label>
        <label>Titel
          <input id="design-title" type="text" maxlength="42" value="VIDEO" placeholder="Bijvoorbeeld TUKTUK" />
        </label>
        <label>Stijl
          <select id="design-style">
            <option value="pink">Roze reiskader</option>
            <option value="clean">Rustig zonder kader</option>
          </select>
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
  ${videosHtml}
  <script>
    const canvas = document.getElementById("qr-canvas");
    const context = canvas.getContext("2d", { alpha: true });
    const urlInput = document.getElementById("design-url");
    const titleInput = document.getElementById("design-title");
    const styleInput = document.getElementById("design-style");
    const backgroundInput = document.getElementById("design-background");
    const previewShell = document.querySelector(".preview-shell");
    const printNote = document.getElementById("print-note");
    let qrImage = null;
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

    function drawDesign() {
      const title = (titleInput.value.trim() || "VIDEO").toUpperCase();
      const pink = styleInput.value === "pink";
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

      if (!transparent) {
        context.fillStyle = "#ffffff";
        context.fillRect(295, 245, 1210, 1210);
      }
      if (qrImage) {
        context.imageSmoothingEnabled = false;
        context.drawImage(qrImage, 300, 250, 1200, 1200);
      } else {
        context.fillStyle = transparent ? "rgba(223, 14, 104, .08)" : "#f7e8ef";
        context.fillRect(300, 250, 1200, 1200);
      }

      if (pink) drawPinkDetails();

      const fontSize = fitTitle(title);
      const textWidth = context.measureText(title).width;
      const iconWidth = 120;
      const gap = 42;
      const startX = (canvas.width - textWidth - iconWidth - gap) / 2;
      const titleY = 1940;
      drawVideoIcon(startX + 48, titleY - 38);
      context.fillStyle = "#202020";
      context.textBaseline = "alphabetic";
      context.fillText(title, startX + iconWidth + gap, titleY);

      if (pink) {
        context.strokeStyle = "#df0e68";
        context.lineWidth = 20;
        context.lineCap = "round";
        context.beginPath();
        context.moveTo(530, 2045);
        context.quadraticCurveTo(900, 2070, 1270, 2045);
        context.stroke();
      }
      context.restore();
    }

    async function updateQr() {
      const value = urlInput.value.trim();
      if (!value) {
        qrImage = null;
        drawDesign();
        return;
      }
      try {
        const transparent = backgroundInput.value === "transparent";
        const response = await fetch("/admin/qr-preview?transparent=" + (transparent ? "1" : "0") + "&url=" + encodeURIComponent(value));
        if (!response.ok) throw new Error("Ongeldige URL");
        const blob = await response.blob();
        const objectUrl = URL.createObjectURL(blob);
        const image = new Image();
        image.onload = () => {
          URL.revokeObjectURL(objectUrl);
          qrImage = image;
          drawDesign();
        };
        image.src = objectUrl;
      } catch {
        qrImage = null;
        drawDesign();
      }
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
      const slug = (titleInput.value.trim() || "video").normalize("NFKD").replace(/[\\u0300-\\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "qr-" + (slug || "video") + "." + extension;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }

    document.querySelectorAll(".design").forEach((button) => {
      button.addEventListener("click", () => {
        urlInput.value = button.dataset.url;
        titleInput.value = button.dataset.title;
        document.getElementById("qr-studio").scrollIntoView({ behavior: "smooth", block: "start" });
        updateQr();
      });
    });

    urlInput.addEventListener("input", () => {
      clearTimeout(qrTimer);
      qrTimer = setTimeout(updateQr, 300);
    });
    titleInput.addEventListener("input", drawDesign);
    styleInput.addEventListener("change", drawDesign);
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
