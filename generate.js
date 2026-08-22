// generate.js
// Scant recursief door VIDEOS_DIR (incl. submappen zoals videos/thailand/),
// geeft nieuwe video's een random ID, houdt bestaande ID's bij mapping.json,
// en genereert per (nieuwe) video een QR-code die naar BASE_URL/v?id=<id> wijst.
//
// Runnen: node generate.js
// (of: docker compose run --rm app npm run generate)

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { promisify } = require("util");
const QRCode = require("qrcode");

const execFileAsync = promisify(execFile);

const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(__dirname, "videos");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const QR_DIR = path.join(DATA_DIR, "qrcodes");
const THUMB_DIR = path.join(DATA_DIR, "thumbnails");
const STREAM_DIR = path.join(DATA_DIR, "streamable");
const MAPPING_FILE = path.join(DATA_DIR, "mapping.json");
const BASE_URL = process.env.BASE_URL || "https://gerdjan.nl";
const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov"]);

// Eerste frame als thumbnail (voor de galerij-pagina en als poster op de afspeelpagina).
// 0.5s in plaats van 0s, want frame 0 is bij sommige video's zwart/leeg.
async function generateThumbnail(inputPath, outputPath) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-ss", "0.5",
    "-i", inputPath,
    "-frames:v", "1",
    "-vf", "scale=480:-2",
    "-q:v", "4",
    outputPath,
  ]);
}

// Kopieert de video met de moov-atom vooraan ("faststart"), zodat de browser
// direct kan beginnen met afspelen zonder eerst het hele bestand te downloaden.
// Puur remuxen (geen her-encode), dus snel en zonder kwaliteitsverlies. Het
// origineel in videos/ blijft ongewijzigd; dit is een aparte kopie in data/.
async function generateStreamableCopy(inputPath, outputPath) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-i", inputPath,
    "-c", "copy",
    "-movflags", "+faststart",
    outputPath,
  ]);
}

function loadMapping() {
  if (fs.existsSync(MAPPING_FILE)) {
    return JSON.parse(fs.readFileSync(MAPPING_FILE, "utf8"));
  }
  return {};
}

function saveMapping(mapping) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2));
}

// Loopt recursief door een map en geeft alle videobestanden terug,
// als pad relatief t.o.v. VIDEOS_DIR (dus submappen als "thailand/strand.mp4" blijven behouden).
function findVideos(dir, baseDir = dir) {
  let results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(findVideos(fullPath, baseDir));
    } else if (VIDEO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(path.relative(baseDir, fullPath));
    }
  }
  return results;
}

function generateId() {
  return crypto.randomBytes(5).toString("hex"); // bv. "8f3a1c9d2b"
}

function qrFileName(relativePath, id) {
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

async function main() {
  if (!fs.existsSync(VIDEOS_DIR)) {
    console.error(`Videomap niet gevonden: ${VIDEOS_DIR}`);
    process.exit(1);
  }

  const mapping = loadMapping(); // { id: "relatief/pad.mp4" }
  const pathToId = new Map(Object.entries(mapping).map(([id, p]) => [p, id]));

  const foundVideos = findVideos(VIDEOS_DIR);
  fs.mkdirSync(QR_DIR, { recursive: true });
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  fs.mkdirSync(STREAM_DIR, { recursive: true });

  let newCount = 0;

  for (const relativePath of foundVideos) {
    let id = pathToId.get(relativePath);

    if (!id) {
      // Nieuw bestand: nieuw random ID, uniek t.o.v. bestaande ID's
      do {
        id = generateId();
      } while (mapping[id]);

      mapping[id] = relativePath;
      pathToId.set(relativePath, id);
      newCount++;
      console.log(`Nieuw:   ${relativePath}  ->  id=${id}`);
    } else {
      console.log(`Bestaat: ${relativePath}  ->  id=${id}`);
    }

    const qrPath = path.join(QR_DIR, qrFileName(relativePath, id));
    const legacyQrPath = path.join(QR_DIR, `${id}.png`);

    // Migreer eerder gegenereerde QR-codes zonder herkenbare videonaam.
    if (fs.existsSync(legacyQrPath) && !fs.existsSync(qrPath)) {
      fs.renameSync(legacyQrPath, qrPath);
      console.log(`QR hernoemd: ${path.basename(qrPath)}`);
    }

    if (!fs.existsSync(qrPath)) {
      const url = `${BASE_URL}/v?id=${id}`;
      await QRCode.toFile(qrPath, url, { width: 600, margin: 2 });
      console.log(`QR gemaakt:  ${path.basename(qrPath)}`);
    }

    const sourcePath = path.join(VIDEOS_DIR, relativePath);
    const thumbPath = path.join(THUMB_DIR, `${id}.jpg`);
    const streamPath = path.join(STREAM_DIR, `${id}.mp4`);

    if (!fs.existsSync(thumbPath)) {
      try {
        await generateThumbnail(sourcePath, thumbPath);
        console.log(`Thumbnail gemaakt: ${id}.jpg`);
      } catch (err) {
        console.warn(`Kon geen thumbnail maken voor ${relativePath}: ${err.message}`);
      }
    }

    if (!fs.existsSync(streamPath)) {
      try {
        await generateStreamableCopy(sourcePath, streamPath);
        console.log(`Streamable kopie gemaakt: ${id}.mp4`);
      } catch (err) {
        console.warn(`Kon geen streamable kopie maken voor ${relativePath}: ${err.message}`);
      }
    }
  }

  // Waarschuw voor mapping-entries waarvan het bestand niet meer bestaat
  for (const [id, relativePath] of Object.entries(mapping)) {
    if (!foundVideos.includes(relativePath)) {
      console.warn(`Let op: mapping voor id=${id} verwijst naar ontbrekend bestand "${relativePath}"`);
    }
  }

  saveMapping(mapping);
  console.log(`\nKlaar. ${newCount} nieuw(e) video('s), ${foundVideos.length} totaal.`);
  console.log(`Mapping: ${MAPPING_FILE}`);
  console.log(`QR-codes: ${QR_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
