const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-album-test-'));
process.env.DATA_DIR = path.join(temporary, 'data');
process.env.VIDEOS_DIR = path.join(temporary, 'videos');
process.env.ADMIN_PASSWORD = 'test-only';
const { app } = require('../server');
const { freezeAlbum } = require('../freeze');
const { loadArchive, withDataLock } = require('../archive');
const data = process.env.DATA_DIR;
const sources = process.env.VIDEOS_DIR;
const id = '0123456789';
const auth = 'Basic ' + Buffer.from('admin:test-only').toString('base64');
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function json(file, value) { write(file, JSON.stringify(value)); }

// Exercise real HTTP routing, immutable files, Range requests and the scan worker.
test('printed links keep the same edition after edits, removals and rescanning', async () => {
  const folder = 'Thailand & reis';
  const relativePath = `${folder}/01 - Bangkok - Fietsen.mp4`;
  json(path.join(data, 'mapping.json'), { [id]: relativePath, abcdef0123: 'Other/delete.mp4' });
  json(path.join(data, 'gallery-settings.json'), { [folder]: { theme: 'thailand', title: 'Gedrukt album', subtitle: 'Origineel' } });
  write(path.join(sources, relativePath), 'original-source');
  write(path.join(data, 'streamable', `${id}.mp4`), '0123456789-frozen-video');
  write(path.join(data, 'thumbnails', `${id}.jpg`), 'original-thumbnail');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, values, authorized = true) => fetch(base + route, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(authorized ? { authorization: auth } : {}) },
    body: new URLSearchParams(values),
  });
  try {
    assert.equal((await post('/admin/freeze', { folder, freeze: 'yes' }, false)).status, 401);
    assert.equal((await post('/admin/freeze', { folder })).status, 400);
    const beforePlayer = await (await fetch(base + `/v?id=${id}`)).text();
    const frozen = await post('/admin/freeze', { folder, freeze: 'yes' });
    assert.equal(frozen.status, 200, await frozen.text());
    const album = loadArchive(data).albums[folder];
    assert.ok(album);
    const beforeGallery = await (await fetch(base + '/gallery?folder=' + encodeURIComponent(folder))).text();
    assert.match(beforeGallery, /Gedrukt album/);
    assert.match(beforeGallery, /data:image\/svg\+xml;base64/);
    assert.doesNotMatch(beforeGallery, /href="\/thailand-films.css"/);
    for (const [file, hash] of Object.entries(album.sha256)) {
      assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(album.directory, file))).digest('hex'), hash);
    }
    write(path.join(data, 'streamable', `${id}.mp4`), 'replacement-stream');
    write(path.join(data, 'thumbnails', `${id}.jpg`), 'replacement-thumbnail');
    fs.rmSync(path.join(sources, folder), { recursive: true });
    write(path.join(sources, folder, 'new.mp4'), 'new-video-must-not-enter-frozen-edition');
    json(path.join(data, 'gallery-settings.json'), { [folder]: { title: 'Changed title', theme: 'default' } });
    execFileSync(process.execPath, [path.join(__dirname, '../generate.js')], { env: process.env });
    assert.equal((await post('/admin/gallery-settings', { folder, title: 'Not allowed', theme: 'default' })).status, 409);
    assert.equal(await (await fetch(base + `/v?id=${id}`)).text(), beforePlayer);
    assert.equal(await (await fetch(base + '/gallery?folder=' + encodeURIComponent(folder))).text(), beforeGallery);
    assert.equal(await (await fetch(base + `/video/${id}`)).text(), '0123456789-frozen-video');
    assert.equal(await (await fetch(base + `/thumb/${id}`)).text(), 'original-thumbnail');
    const range = await fetch(base + `/video/${id}`, { headers: { range: 'bytes=2-5' } });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), '2345');
    const scanned = JSON.parse(fs.readFileSync(path.join(data, 'mapping.json')));
    assert.deepEqual(scanned, { [id]: relativePath });
    // Even loss/replacement of the live index must not break a printed link.
    json(path.join(data, 'mapping.json'), {});
    assert.equal(await (await fetch(base + `/video/${id}`)).text(), '0123456789-frozen-video');
    assert.equal((await fetch(base + `/admin/qr/${id}`, { headers: { authorization: auth } })).status, 200);
    assert.equal((await fetch(base + '/admin/folder-qr?folder=' + encodeURIComponent(folder), { headers: { authorization: auth } })).status, 200);
    const repeated = await freezeAlbum(folder);
    assert.equal(repeated.frozenAt, album.frozenAt);
    assert.equal((await fetch(base + '/video/fffffffffe')).status, 404);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('failed copies do not publish an archive and the shared lock blocks overlapping work', async () => {
  json(path.join(data, 'mapping.json'), { abcdef9998: 'Incomplete/ok.mp4', abcdef9999: 'Incomplete/missing.mp4' });
  write(path.join(sources, 'Incomplete/ok.mp4'), 'first-copy-succeeds');
  await assert.rejects(freezeAlbum('Incomplete'), /ENOENT/);
  assert.equal(loadArchive(data).albums.Incomplete, undefined);
  assert.equal(fs.existsSync(path.join(data, 'update.lock')), false);
  assert.ok(fs.readdirSync(path.join(data, 'frozen-albums')).every(name => !name.startsWith('.pending-')));
  await withDataLock(data, async () => {
    await assert.rejects(freezeAlbum('Incomplete'), /Er draait al/);
  });
});

test('a missing source directory does not leave the scanner lock behind', () => {
  assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, '../generate.js')], { env: { ...process.env, VIDEOS_DIR: path.join(temporary, 'absent') }, stdio: 'pipe' }));
  assert.equal(fs.existsSync(path.join(data, 'update.lock')), false);
});

test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
