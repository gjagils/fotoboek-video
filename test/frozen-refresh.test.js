const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'frozen-refresh-test-'));
process.env.DATA_DIR = path.join(temporary, 'data');
process.env.VIDEOS_DIR = path.join(temporary, 'videos');
process.env.ADMIN_PASSWORD = 'test-only';
const { app } = require('../server');
const { freezeAlbum } = require('../freeze');
const { refreshAlbum, restoreAlbum, backupDirectory, alreadyRefreshed } = require('../refresh');
const { STREAM_VERSION } = require('../streaming');
const { loadArchive } = require('../archive');
const data = process.env.DATA_DIR;
const sources = process.env.VIDEOS_DIR;
const folder = 'Thailand & reis';
const id = '0123456789';
const relativePath = `${folder}/01 - Bangkok - Fietsen.mp4`;
const auth = 'Basic ' + Buffer.from('admin:test-only').toString('base64');
const printedPage = '<!DOCTYPE html><html><body><video preload="metadata" poster="/thumb/0123456789"></video></body></html>';
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function json(file, value) { write(file, JSON.stringify(value)); }
function read(file) { return fs.readFileSync(file, 'utf8'); }
function sha256(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

// Zet een bevroren album neer zoals het vóór deze wijziging op de NAS stond:
// een gedrukte editie met de oude afspeelpagina.
test('een al gedrukt album staat bevroren met zijn oorspronkelijke pagina', async () => {
  json(path.join(data, 'mapping.json'), { [id]: relativePath });
  json(path.join(data, 'gallery-settings.json'), { [folder]: { theme: 'thailand', title: 'Gedrukt album', subtitle: 'Origineel' } });
  write(path.join(sources, relativePath), 'originele-bron');
  write(path.join(data, 'streamable', `${id}.mp4`), 'gedrukte-editie-video');
  write(path.join(data, 'thumbnails', `${id}.jpg`), 'startbeeld');
  await freezeAlbum(folder);

  const directory = loadArchive(data).albums[folder].directory;
  const manifestFile = path.join(directory, 'manifest.json');
  const manifest = JSON.parse(read(manifestFile));
  write(path.join(directory, `${id}.html`), printedPage);
  manifest.sha256[`${id}.html`] = sha256(path.join(directory, `${id}.html`));
  json(manifestFile, manifest);
});

test('verversen houdt de gedrukte links heel, vernieuwt de pagina en bewaart de oude editie', async () => {
  const before = loadArchive(data).albums[folder];
  const refreshed = await refreshAlbum(folder);
  const after = loadArchive(data).albums[folder];

  assert.deepEqual(Object.keys(after.videos), Object.keys(before.videos)); // Gedrukte QR-codes blijven wijzen.
  assert.equal(after.frozenAt, before.frozenAt);
  assert.ok(refreshed.refreshedAt);
  assert.equal(after.directory, before.directory);

  // De pagina is opnieuw vastgelegd: vooruit bufferen en kijkcijfers.
  const page = read(path.join(after.directory, `${id}.html`));
  assert.match(page, /preload="auto"/);
  assert.match(page, /stats\/view/);
  assert.match(page, new RegExp(`/video/${id}\\.mp4\\?v=[a-f0-9]{10}`));
  assert.match(read(path.join(after.directory, 'gallery.html')), /Gedrukt album/);

  // Elke hash in het manifest klopt weer met wat er op schijf staat.
  for (const [file, hash] of Object.entries(JSON.parse(read(path.join(after.directory, 'manifest.json'))).sha256)) {
    assert.equal(sha256(path.join(after.directory, file)), hash);
  }

  // De gedrukte editie staat compleet in de back-up.
  const backup = backupDirectory(folder);
  assert.equal(read(path.join(backup, `${id}.mp4`)), 'gedrukte-editie-video');
  assert.equal(read(path.join(backup, `${id}.html`)), printedPage);

  // Een tweede verversing laat die eerste, gedrukte editie met rust.
  await refreshAlbum(folder);
  assert.equal(read(path.join(backupDirectory(folder), `${id}.html`)), printedPage);
});

test('een tweede verversing zet niets opnieuw om, maar vernieuwt alleen de pagina', () => {
  // Een omgezette film meet zelf vaak nét boven de bitrategrens, dus op de
  // bitrate afgaan zou elke verversing opnieuw coderen — kwaliteitsverlies en
  // uren rekentijd voor niets.
  const fresh = { relativePath: 'a.mp4', streamVersion: STREAM_VERSION, streamMode: 'transcode' };
  assert.equal(alreadyRefreshed({ refreshedAt: '2026-09-18T00:00:00Z' }, fresh), true);
  // Edities uit de eerste versie van deze verversing noteerden nog niets per video.
  assert.equal(alreadyRefreshed({ refreshedAt: '2026-09-18T00:00:00Z' }, { relativePath: 'a.mp4' }), true);
  // Een album dat nog nooit ververst is, wordt wél beoordeeld.
  assert.equal(alreadyRefreshed({}, { relativePath: 'a.mp4' }), false);
  // Andere grenzen (hoger versienummer) laten alles opnieuw beoordelen.
  assert.equal(alreadyRefreshed({ refreshedAt: '2026-09-18T00:00:00Z' }, { ...fresh, streamVersion: STREAM_VERSION - 1 }), false);

  const stored = JSON.parse(read(path.join(loadArchive(data).albums[folder].directory, 'manifest.json')));
  assert.equal(stored.videos[id].streamVersion, STREAM_VERSION); // Verversen legt dit nu vast.
});

test('de bewaarde editie gaat terug zoals ze was, en een beschadigde back-up wordt geweigerd', async () => {
  const directory = loadArchive(data).albums[folder].directory;
  const backup = backupDirectory(folder);
  const refreshedPage = read(path.join(directory, `${id}.html`));

  write(path.join(backup, `${id}.mp4`), 'beschadigd');
  await assert.rejects(restoreAlbum(folder), /komt niet overeen/);
  assert.equal(read(path.join(directory, `${id}.html`)), refreshedPage); // Draaiende editie blijft staan.

  write(path.join(backup, `${id}.mp4`), 'gedrukte-editie-video');
  const restored = await restoreAlbum(folder);
  assert.equal(restored.folder, folder);
  assert.equal(read(path.join(directory, `${id}.html`)), printedPage);
  assert.equal(read(path.join(directory, `${id}.mp4`)), 'gedrukte-editie-video');
  assert.equal(fs.existsSync(backup), false); // De editie staat weer live; er valt niets meer terug te zetten.

  await assert.rejects(restoreAlbum(folder), /geen bewaarde editie/);
  await assert.rejects(refreshAlbum('Niet bevroren'), /niet bevroren/);
});

test('de beheerpagina en de gedrukte link werken na terugzetten gewoon door', async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal(await (await fetch(base + `/v?id=${id}`)).text(), printedPage);
    assert.equal(await (await fetch(base + `/video/${id}`)).text(), 'gedrukte-editie-video');
    const admin = await (await fetch(base + '/admin', { headers: { authorization: auth } })).text();
    assert.match(admin, /Bevroren editie verversen/);
    assert.doesNotMatch(admin, /Bewaarde editie terugzetten/); // Back-up is opgebruikt.
    const post = (route, values) => fetch(base + route, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: auth },
      body: new URLSearchParams(values),
    });
    assert.equal((await post('/admin/refresh-frozen', { folder })).status, 400); // Zonder vinkje niet.
    assert.equal((await post('/admin/restore-frozen', { folder })).status, 400); // Zonder back-up niet.
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
