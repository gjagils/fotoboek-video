const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function archiveKey(folder) {
  return crypto.createHash('sha256').update(folder).digest('hex');
}

function loadArchive(dataDir) {
  const root = path.join(dataDir, 'frozen-albums');
  const albums = Object.create(null), mapping = {}, videos = {};
  if (!fs.existsSync(root)) return { albums, mapping, videos };
  for (const key of fs.readdirSync(root)) {
    if (!/^[a-f0-9]{64}$/.test(key)) continue;
    const directory = path.join(root, key);
    // A damaged archive must fail visibly, never silently serve a newer version.
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
    if (manifest.version !== 1 || archiveKey(manifest.folder) !== key) throw new Error('Ongeldig albumarchief');
    albums[manifest.folder] = { ...manifest, directory };
    for (const [id, video] of Object.entries(manifest.videos)) {
      if (!/^[a-f0-9]{10}$/.test(id) || videos[id]) throw new Error('Ongeldige of dubbele archief-ID');
      mapping[id] = video.relativePath;
      videos[id] = { ...video, directory };
    }
  }
  return { albums, mapping, videos };
}

async function withDataLock(dataDir, action) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, 'update.lock');
  let lock;
  try {
    lock = fs.openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error('Er draait al een scan of archivering. Probeer het later opnieuw.');
    throw error;
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await action();
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

module.exports = { archiveKey, loadArchive, withDataLock };
