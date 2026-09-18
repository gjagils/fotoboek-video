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

// A scan that transcodes runs for a long time, so a restart in the middle used to
// leave a lock nobody owns. Only a lock whose process is really gone is taken over.
function lockIsStale(lockPath) {
  let contents;
  try {
    contents = fs.readFileSync(lockPath, 'utf8');
  } catch {
    return false; // Just vanished: the next attempt decides.
  }
  if (!contents.trim()) return Date.now() - fs.statSync(lockPath).mtimeMs > 60_000; // Written moments after creation.
  try {
    process.kill(JSON.parse(contents).pid, 0);
    return false;
  } catch (error) {
    return error.code !== 'EPERM'; // EPERM: the process exists but is someone else's.
  }
}

async function withDataLock(dataDir, action) {
  fs.mkdirSync(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, 'update.lock');
  let lock;
  for (const isRetry of [false, true]) {
    try {
      lock = fs.openSync(lockPath, 'wx');
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (isRetry || !lockIsStale(lockPath)) throw new Error('Er draait al een scan of archivering. Probeer het later opnieuw.');
      fs.rmSync(lockPath, { force: true });
    }
  }
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    return await action();
  } finally {
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

module.exports = { archiveKey, loadArchive, withDataLock, lockIsStale };
