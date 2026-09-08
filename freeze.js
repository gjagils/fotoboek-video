// Copies the version served today, then atomically publishes the complete archive.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const { archiveKey, loadArchive, withDataLock } = require('./archive');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const VIDEOS_DIR = process.env.VIDEOS_DIR || path.join(__dirname, 'videos');
const BASE_URL = (process.env.BASE_URL || 'https://albumvideo.gerdjan.nl').replace(/\/$/, '');

function capturePage(render, query) {
  let html;
  const response = {
    status(code) { if (code !== 200) throw new Error('Album of video bestaat niet'); return this; },
    type() { return this; },
    send(value) { html = value; },
  };
  render({ query }, response);
  if (!html) throw new Error('Pagina kon niet worden vastgelegd');
  return html;
}

async function copyStable(source, target) {
  const before = await fs.promises.stat(source);
  if (!before.isFile() || !before.size) throw new Error(`Leeg of ongeldig bestand: ${source}`);
  await fs.promises.copyFile(source, target); // An independent copy, never a hard link.
  const after = await fs.promises.stat(source);
  const copied = await fs.promises.stat(target);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino || copied.size !== before.size) {
    throw new Error('Een bestand veranderde tijdens het archiveren. Probeer opnieuw nadat het kopiëren naar de NAS klaar is.');
  }
}

async function freezeAlbum(folder) {
  return withDataLock(DATA_DIR, async () => {
    const existing = loadArchive(DATA_DIR).albums[folder];
    if (existing) return existing; // Repeated requests never replace the first edition.
    const mapping = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'mapping.json'), 'utf8'));
    const entries = Object.entries(mapping).filter(([, file]) => path.dirname(file) === folder);
    if (!folder || !entries.length) throw new Error('Geen video’s in deze vakantiemap.');
    const { renderGallery, renderPlayer } = require('./server');
    const root = path.join(DATA_DIR, 'frozen-albums');
    await fs.promises.mkdir(root, { recursive: true });
    const staging = await fs.promises.mkdtemp(path.join(root, '.pending-'));
    const manifest = { version: 1, folder, frozenAt: new Date().toISOString(), baseUrl: BASE_URL, videos: {} };
    try {
      let gallery = capturePage(renderGallery, { folder });
      gallery = gallery.replace('<link rel="stylesheet" href="/thailand-films.css" />', () => `<style>${fs.readFileSync(path.join(__dirname, 'thailand-films.css'), 'utf8')}</style>`)
        .replace('src="/assets/thailand-header-decoration.svg"', () => `src="data:image/svg+xml;base64,${fs.readFileSync(path.join(__dirname, 'assets/thailand-header-decoration.svg')).toString('base64')}"`);
      gallery = gallery.replace('<link rel="stylesheet" href="/assets/safari-films.css" />', () => `<style>${fs.readFileSync(path.join(__dirname, 'assets/safari-films.css'), 'utf8')}</style>`)
        .replace('src="/assets/safari-header.jpg"', () => `src="data:image/jpeg;base64,${fs.readFileSync(path.join(__dirname, 'assets/safari-header.jpg')).toString('base64')}"`);
      await fs.promises.writeFile(path.join(staging, 'gallery.html'), gallery);
      for (const [id, relativePath] of entries) {
        if (!/^[a-f0-9]{10}$/.test(id)) throw new Error('Ongeldige video-ID');
        const source = path.resolve(VIDEOS_DIR, relativePath);
        if (!source.startsWith(path.resolve(VIDEOS_DIR) + path.sep)) throw new Error('Ongeldig videopad');
        const stream = path.join(DATA_DIR, 'streamable', `${id}.mp4`);
        const effective = fs.existsSync(stream) ? stream : source;
        await copyStable(effective, path.join(staging, `${id}.mp4`));
        const thumbnail = path.join(DATA_DIR, 'thumbnails', `${id}.jpg`);
        const hasThumbnail = fs.existsSync(thumbnail);
        if (hasThumbnail) await copyStable(thumbnail, path.join(staging, `${id}.jpg`));
        await fs.promises.writeFile(path.join(staging, `${id}.html`), capturePage(renderPlayer, { id }));
        await QRCode.toFile(path.join(staging, `${id}.png`), `${BASE_URL}/v?id=${id}`, { width: 600, margin: 2 });
        manifest.videos[id] = { relativePath, hasThumbnail, size: (await fs.promises.stat(path.join(staging, `${id}.mp4`))).size };
      }
      await QRCode.toFile(path.join(staging, 'album.png'), `${BASE_URL}/gallery?folder=${encodeURIComponent(folder)}`, { width: 600, margin: 2 });
      // Hashes allow a backup/restore to verify the complete frozen edition later.
      manifest.sha256 = {};
      for (const file of await fs.promises.readdir(staging)) {
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(path.join(staging, file))) hash.update(chunk);
        manifest.sha256[file] = hash.digest('hex');
      }
      await fs.promises.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
      await fs.promises.rename(staging, path.join(root, archiveKey(folder)));
      return manifest;
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
  });
}

if (require.main === module) {
  freezeAlbum(process.argv[2]).then(result => console.log(`Album ${result.folder} bevroren: ${Object.keys(result.videos).length} video's. Bestaande QR-links zijn beschermd.`)).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
module.exports = { freezeAlbum };
