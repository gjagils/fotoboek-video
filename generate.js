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
const FOLDER_QR_DIR = path.join(DATA_DIR, "folder-qrcodes");
const THUMB_DIR = path.join(DATA_DIR, "thumbnails");
const STREAM_DIR = path.join(DATA_DIR, "streamable");
const MAPPING_FILE = path.join(DATA_DIR, "mapping.json");
const SOURCE_STATE_FILE = path.join(DATA_DIR, "source-state.json");
const GALLERY_SETTINGS_FILE = path.join(DATA_DIR, "gallery-settings.json");
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

async function generateAtomically(generator, inputPath, outputPath) {
  const extension = path.extname(outputPath);
  const temporaryPath = `${outputPath.slice(0, -extension.length)}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}${extension}`;

  try {
    await generator(inputPath, temporaryPath);
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
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

function loadSourceState() {
  if (fs.existsSync(SOURCE_STATE_FILE)) {
    return JSON.parse(fs.readFileSync(SOURCE_STATE_FILE, "utf8"));
  }
  return {};
}

function saveSourceState(sourceState) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SOURCE_STATE_FILE, JSON.stringify(sourceState, null, 2));
}

function sourceSignature(filePath) {
  const stats = fs.statSync(filePath);
  return { size: stats.size, mtimeMs: stats.mtimeMs };
}

function signaturesEqual(left, right) {
  return left && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function removeIfExists(filePath, label) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log(`${label} verwijderd: ${path.basename(filePath)}`);
  }
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

async function main() {
  if (!fs.existsSync(VIDEOS_DIR)) {
    console.error(`Videomap niet gevonden: ${VIDEOS_DIR}`);
    process.exit(1);
  }

  const mapping = loadMapping(); // { id: "relatief/pad.mp4" }
  const sourceState = loadSourceState(); // { id: { size, mtimeMs } }
  const pathToId = new Map(Object.entries(mapping).map(([id, p]) => [p, id]));

  const foundVideos = findVideos(VIDEOS_DIR);
  const foundVideoSet = new Set(foundVideos);
  fs.mkdirSync(QR_DIR, { recursive: true });
  fs.mkdirSync(FOLDER_QR_DIR, { recursive: true });
  fs.mkdirSync(THUMB_DIR, { recursive: true });
  fs.mkdirSync(STREAM_DIR, { recursive: true });

  let newCount = 0;
  let updatedCount = 0;
  let removedCount = 0;

  // Verwijder video's die niet meer in de bronmap staan ook uit de index en
  // ruim alle afgeleide bestanden op. Daardoor verdwijnen ze uit /gallery en
  // werken hun oude afspeellinks niet meer.
  for (const [id, relativePath] of Object.entries(mapping)) {
    if (foundVideoSet.has(relativePath)) continue;

    removeIfExists(path.join(QR_DIR, qrFileName(relativePath, id)), "QR");
    removeIfExists(path.join(QR_DIR, `${id}.png`), "QR");
    removeIfExists(path.join(THUMB_DIR, `${id}.jpg`), "Thumbnail");
    removeIfExists(path.join(STREAM_DIR, `${id}.mp4`), "Streamable kopie");
    delete mapping[id];
    delete sourceState[id];
    pathToId.delete(relativePath);
    removedCount++;
    console.log(`Verwijderd uit mapping: ${relativePath}  (id=${id})`);
  }

  for (const relativePath of foundVideos) {
    let id = pathToId.get(relativePath);
    const isNew = !id;

    if (isNew) {
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
    const signature = sourceSignature(sourcePath);
    // Een bestaande video zonder status komt van vóór deze wijzigingsdetectie;
    // ververs hem één keer zodat we zeker weten dat de afgeleide bestanden actueel zijn.
    const sourceChanged = !isNew && !signaturesEqual(sourceState[id], signature);
    let generationSucceeded = true;

    if (sourceChanged) {
      updatedCount++;
      console.log(`Gewijzigd: ${relativePath}  ->  afgeleide bestanden verversen`);
    }

    if (sourceChanged || !fs.existsSync(thumbPath)) {
      try {
        await generateAtomically(generateThumbnail, sourcePath, thumbPath);
        console.log(`Thumbnail ${sourceChanged ? "ververst" : "gemaakt"}: ${id}.jpg`);
      } catch (err) {
        generationSucceeded = false;
        console.warn(`Kon geen thumbnail maken voor ${relativePath}: ${err.message}`);
      }
    }

    if (sourceChanged || !fs.existsSync(streamPath)) {
      try {
        await generateAtomically(generateStreamableCopy, sourcePath, streamPath);
        console.log(`Streamable kopie ${sourceChanged ? "ververst" : "gemaakt"}: ${id}.mp4`);
      } catch (err) {
        generationSucceeded = false;
        console.warn(`Kon geen streamable kopie maken voor ${relativePath}: ${err.message}`);
      }
    }

    if (generationSucceeded) sourceState[id] = signature;
  }

  // Maak één deelbare galerij-QR per echte submap. De queryparameter behoudt
  // ook spaties, accenten en geneste mapnamen correct via URL-encoding.
  const folders = new Set(foundVideos.map((relativePath) => path.dirname(relativePath)).filter((folder) => folder !== "."));
  const expectedFolderQrFiles = new Set();
  for (const folder of [...folders].sort((left, right) => left.localeCompare(right, "nl"))) {
    const fileName = folderQrFileName(folder);
    expectedFolderQrFiles.add(fileName);
    const outputPath = path.join(FOLDER_QR_DIR, fileName);
    if (!fs.existsSync(outputPath)) {
      const url = `${BASE_URL}/gallery?folder=${encodeURIComponent(folder)}`;
      await QRCode.toFile(outputPath, url, { width: 600, margin: 2 });
      console.log(`Map-QR gemaakt: ${folder} -> ${fileName}`);
    }
  }

  for (const fileName of fs.readdirSync(FOLDER_QR_DIR)) {
    if (fileName.endsWith(".png") && !expectedFolderQrFiles.has(fileName)) {
      removeIfExists(path.join(FOLDER_QR_DIR, fileName), "Map-QR");
    }
  }

  // Verwijder ook opgeslagen vormgeving van mappen die niet meer bestaan.
  if (fs.existsSync(GALLERY_SETTINGS_FILE)) {
    const gallerySettings = JSON.parse(fs.readFileSync(GALLERY_SETTINGS_FILE, "utf8"));
    let settingsChanged = false;
    for (const folder of Object.keys(gallerySettings)) {
      if (!folders.has(folder)) {
        delete gallerySettings[folder];
        settingsChanged = true;
      }
    }
    if (settingsChanged) {
      fs.writeFileSync(GALLERY_SETTINGS_FILE, JSON.stringify(gallerySettings, null, 2));
      console.log("Instellingen van verwijderde vakantie-albums opgeruimd.");
    }
  }

  saveMapping(mapping);
  saveSourceState(sourceState);
  console.log(`\nKlaar. ${newCount} nieuw, ${updatedCount} ververst, ${removedCount} verwijderd, ${foundVideos.length} totaal.`);
  console.log(`Mapping: ${MAPPING_FILE}`);
  console.log(`QR-codes: ${QR_DIR}`);
  console.log(`Map-QR-codes: ${FOLDER_QR_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
