// refresh.js
// Vervangt de video's in een bevroren album door een lichte webversie, zónder de
// ID's te veranderen. De gedrukte QR-codes blijven dus exact werken: dezelfde
// film, alleen zo gecodeerd dat 'ie op mobiel internet doorloopt. De pagina's
// worden opnieuw vastgelegd, dus de bevroren editie krijgt ook de laad-indicator
// en de kijkcijfers.
//
// De vorige editie gaat naar data/frozen-album-backups/<sleutel>/ en blijft daar
// staan tot je hem terugzet. Bij een tweede verversing blijft die eerste
// (gedrukte) editie bewaard — je kunt dus altijd terug naar wat in het boek zat.
//
// Runnen:
//   node refresh.js "<mapnaam>"          -> ververst de bevroren editie
//   node refresh.js --terug "<mapnaam>"  -> zet de bewaarde editie terug

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { archiveKey, loadArchive, withDataLock } = require('./archive');
const { capturePage, inlineGalleryAssets, verifyArchive } = require('./freeze');
const { STREAM_VERSION, limitsFromEnv, chooseStreamPlan, describePlan, remuxArgs, transcodeArgs, runFfmpeg, probeFile, hasFastStart } = require('./streaming');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ARCHIVE_ROOT = path.join(DATA_DIR, 'frozen-albums');
const BACKUP_ROOT = path.join(DATA_DIR, 'frozen-album-backups');
const STREAM_LIMITS = limitsFromEnv();

// Is deze video al door een verversing gegaan? Zo ja: nooit opnieuw omzetten.
// Een omgezette film meet zelf vaak nét boven de grens (audio en containeropslag
// tellen mee), dus op de bitrate afgaan zou hem elke keer opnieuw laten coderen,
// met kwaliteitsverlies en uren rekentijd voor niets.
function alreadyRefreshed(manifest, video) {
  if (video.streamVersion === STREAM_VERSION) return true;
  // Edities uit de eerste versie van deze verversing noteerden nog niets per
  // video; het manifest zelf verraadt dat ze al verlicht zijn.
  return Boolean(manifest.refreshedAt) && video.streamVersion === undefined;
}

function backupDirectory(folder) {
  return path.join(BACKUP_ROOT, archiveKey(folder));
}

function hasBackup(folder) {
  return fs.existsSync(backupDirectory(folder));
}

// Vervangt de bevroren map door een klaargezette map. Beide staan op hetzelfde
// volume, dus dit zijn hernoemingen: geen kopieerslag, geen halve editie.
async function swapIn(staging, current, keep) {
  const discarded = path.join(ARCHIVE_ROOT, `.vervangen-${crypto.randomBytes(4).toString('hex')}`);
  await fs.promises.rename(current, keep || discarded);
  try {
    await fs.promises.rename(staging, current);
  } catch (error) {
    await fs.promises.rename(keep || discarded, current); // Nooit zonder editie achterblijven.
    throw error;
  }
  if (!keep) await fs.promises.rm(discarded, { recursive: true, force: true });
}

async function refreshAlbum(folder) {
  return withDataLock(DATA_DIR, async () => {
    const album = loadArchive(DATA_DIR).albums[folder];
    if (!album) throw new Error('Dit album is niet bevroren; een gewone scan volstaat.');
    const current = path.join(ARCHIVE_ROOT, archiveKey(folder));
    const manifest = JSON.parse(await fs.promises.readFile(path.join(current, 'manifest.json'), 'utf8'));
    await fs.promises.mkdir(BACKUP_ROOT, { recursive: true });
    const staging = await fs.promises.mkdtemp(path.join(ARCHIVE_ROOT, '.verversen-'));

    try {
      // Alles wat niet verandert (thumbnails, QR-codes) gaat ongewijzigd mee.
      for (const file of await fs.promises.readdir(current)) {
        if (!file.endsWith('.mp4') && file !== 'manifest.json') await fs.promises.copyFile(path.join(current, file), path.join(staging, file));
      }

      for (const [id, video] of Object.entries(manifest.videos)) {
        const source = path.join(current, `${id}.mp4`);
        const target = path.join(staging, `${id}.mp4`);
        const keepAsIs = alreadyRefreshed(manifest, video);
        const probe = keepAsIs ? null : await probeFile(source);
        const plan = keepAsIs ? { mode: 'copy', reasons: [] } : chooseStreamPlan(probe, STREAM_LIMITS);

        if (keepAsIs) {
          await fs.promises.copyFile(source, target);
          console.log(`${video.relativePath}: al eerder verlicht, alleen de pagina wordt vernieuwd`);
        } else if (!probe) {
          // Niet te lezen door ffmpeg: nooit aan zitten, anders raak je de
          // gedrukte editie kwijt aan een mislukte omzetting.
          await fs.promises.copyFile(source, target);
          console.warn(`${video.relativePath}: kon niet gelezen worden, ongewijzigd overgenomen`);
        } else if (plan.mode === 'transcode') {
          await runFfmpeg(transcodeArgs(source, target, STREAM_LIMITS));
          console.log(`${video.relativePath}: ${describePlan(plan, STREAM_LIMITS)}`);
        } else if (!hasFastStart(source)) {
          await runFfmpeg(remuxArgs(source, target));
          console.log(`${video.relativePath}: moov-atom naar voren gezet, verder ongewijzigd`);
        } else {
          await fs.promises.copyFile(source, target);
          console.log(`${video.relativePath}: al geschikt, ongewijzigd overgenomen`);
        }

        const before = video.size;
        const after = (await fs.promises.stat(target)).size;
        if (!after) throw new Error(`Lege videokopie voor ${video.relativePath}`);
        manifest.videos[id] = { ...video, size: after, streamVersion: STREAM_VERSION, streamMode: keepAsIs ? video.streamMode || 'transcode' : plan.mode };
        console.log(`  ${Math.round(before / 1024 / 1024)} MB -> ${Math.round(after / 1024 / 1024)} MB`);
      }

      // Pagina's opnieuw vastleggen, zodat de bevroren editie ook vooruit buffert
      // en meetelt in de kijkcijfers. De ID's en links blijven hetzelfde.
      const { renderGallery, renderPlayer } = require('./server');
      const request = { captureLive: true, mediaDirectory: staging };
      await fs.promises.writeFile(path.join(staging, 'gallery.html'), inlineGalleryAssets(capturePage(renderGallery, { folder }, request)));
      for (const id of Object.keys(manifest.videos)) {
        await fs.promises.writeFile(path.join(staging, `${id}.html`), capturePage(renderPlayer, { id }, request));
      }

      manifest.refreshedAt = new Date().toISOString();
      manifest.sha256 = {};
      for (const file of await fs.promises.readdir(staging)) {
        const hash = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(path.join(staging, file))) hash.update(chunk);
        manifest.sha256[file] = hash.digest('hex');
      }
      await fs.promises.writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));

      // De eerste bewaarde editie is de gedrukte; die wordt nooit overschreven.
      await swapIn(staging, current, hasBackup(folder) ? null : backupDirectory(folder));
      await verifyArchive(current);
      return manifest;
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
  });
}

async function restoreAlbum(folder) {
  return withDataLock(DATA_DIR, async () => {
    if (!loadArchive(DATA_DIR).albums[folder]) throw new Error('Dit album is niet bevroren.');
    const backup = backupDirectory(folder);
    if (!fs.existsSync(backup)) throw new Error('Er is geen bewaarde editie van dit album.');
    // Eerst controleren, dan pas terugzetten: een beschadigde back-up mag de
    // draaiende editie niet vervangen.
    const manifest = await verifyArchive(backup);
    await swapIn(backup, path.join(ARCHIVE_ROOT, archiveKey(folder)));
    return manifest;
  });
}

if (require.main === module) {
  const restore = process.argv[2] === '--terug';
  const folder = restore ? process.argv[3] : process.argv[2];
  const action = restore ? restoreAlbum : refreshAlbum;
  action(folder)
    .then((manifest) => console.log(restore
      ? `Bewaarde editie van ${manifest.folder} teruggezet: ${Object.keys(manifest.videos).length} video's. De gedrukte QR-codes wijzen weer naar de oorspronkelijke bestanden.`
      : `Bevroren album ${manifest.folder} ververst: ${Object.keys(manifest.videos).length} video's. De gedrukte QR-codes blijven werken; de vorige editie staat in ${path.basename(BACKUP_ROOT)}.`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}

module.exports = { refreshAlbum, restoreAlbum, hasBackup, backupDirectory, alreadyRefreshed };
