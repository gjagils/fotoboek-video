const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'streaming-views-test-'));
process.env.DATA_DIR = path.join(temporary, 'data');
process.env.VIDEOS_DIR = path.join(temporary, 'videos');
process.env.ADMIN_PASSWORD = 'test-only';
const { app, views } = require('../server');
const { parseProbe, chooseStreamPlan, limitsFromEnv, transcodeArgs, remuxArgs } = require('../streaming');
const data = process.env.DATA_DIR;
const id = 'abcdef0123';
const auth = 'Basic ' + Buffer.from('admin:test-only').toString('base64');
function write(file, content) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
function json(file, value) { write(file, JSON.stringify(value)); }

const phoneRecording = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'IMG_1234.MOV':",
  '  Duration: 00:01:02.53, start: 0.000000, bitrate: 48120 kb/s',
  '  Stream #0:0[0x1](und): Video: hevc (Main) (hvc1 / 0x31637668), yuvj420p(pc, bt709), 3840x2160, 47816 kb/s, 29.98 fps, 30 tbr, 600 tbn (default)',
  '  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 158 kb/s (default)',
].join('\n');
const webReady = [
  "Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'staand.mp4':",
  '  Duration: 00:00:24.00, start: 0.000000, bitrate: 3200 kb/s',
  '  Stream #0:0(und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 1080x1920 [SAR 1:1 DAR 9:16], 3050 kb/s, 30 fps, 30 tbr, 15360 tbn',
  '  Stream #0:1(und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 128 kb/s',
].join('\n');

test('zware bronnen worden omgezet, webvriendelijke bronnen alleen geremuxt', () => {
  const limits = limitsFromEnv({});
  const heavy = parseProbe(phoneRecording, 391_000_000);
  assert.deepEqual(
    { codec: heavy.videoCodec, width: heavy.width, height: heavy.height, bitrate: heavy.bitrateKbps },
    { codec: 'hevc', width: 3840, height: 2160, bitrate: 47816 },
  );
  const heavyPlan = chooseStreamPlan(heavy, limits);
  assert.equal(heavyPlan.mode, 'transcode');
  assert.deepEqual(heavyPlan.reasons, ['codec hevc', '3840x2160', '47816 kb/s']);

  const light = parseProbe(webReady, 9_600_000);
  assert.equal(light.bitrateKbps, 3050);
  assert.equal(chooseStreamPlan(light, limits).mode, 'copy');

  // Een staande telefoonvideo houdt zijn breedte: de korte zijde is de grens.
  const portrait = chooseStreamPlan(parseProbe(webReady.replace('3050 kb/s', '9000 kb/s'), 0), limits);
  assert.equal(portrait.mode, 'transcode');
  assert.match(transcodeArgs('in.mp4', 'uit.mp4', limits).join(' '), /min\(iw,1080\)/);

  // Zonder leesbare bron of met de omzetting uit blijft de oude, veilige route staan.
  assert.equal(chooseStreamPlan(null, limits).mode, 'copy');
  assert.equal(chooseStreamPlan(heavy, limitsFromEnv({ STREAM_TRANSCODE: 'off' })).mode, 'copy');
  assert.equal(parseProbe('Duration: 00:00:01.00, bitrate: 100 kb/s\n  Stream #0:0: Audio: aac', 0), null);
  assert.ok(remuxArgs('in.mp4', 'uit.mp4').includes('copy'));
});

test('de afspeelpagina buffert vooruit, cachet per versie en telt kijkcijfers', async () => {
  json(path.join(data, 'mapping.json'), { [id]: 'Reis/film.mp4' });
  write(path.join(data, 'streamable', `${id}.mp4`), 'webversie-bytes');
  write(path.join(data, 'thumbnails', `${id}.jpg`), 'startbeeld');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const beacon = (values) => fetch(base + '/stats/view', { method: 'POST', body: new URLSearchParams(values) });
  try {
    const player = await (await fetch(base + `/v?id=${id}`)).text();
    assert.match(player, /preload="auto"/);
    const source = player.match(/<source src="([^"]+)"/)[1];
    assert.match(source, new RegExp(`^/video/${id}\\.mp4\\?v=[a-f0-9]{10}$`));
    assert.match(player, new RegExp(`poster="/thumb/${id}\\.jpg\\?v=[a-f0-9]{10}"`));

    const versioned = await fetch(base + source);
    assert.equal(versioned.status, 200);
    assert.equal(await versioned.text(), 'webversie-bytes');
    assert.equal(versioned.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const ranged = await fetch(base + source, { headers: { range: 'bytes=0-2' } });
    assert.equal(ranged.status, 206);
    assert.equal(await ranged.text(), 'web');

    // Zonder versiesleutel blijft hervalideren de regel, zodat een vervangen
    // video meteen zichtbaar is.
    const plain = await fetch(base + `/video/${id}`);
    assert.equal(await plain.text(), 'webversie-bytes');
    assert.equal(plain.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
    assert.equal(await (await fetch(base + `/thumb/${id}.jpg?v=oud`)).text(), 'startbeeld');

    // Een vervangen bestand krijgt een andere sleutel, dus nooit een oude kopie uit de cache.
    write(path.join(data, 'streamable', `${id}.mp4`), 'nieuwe-webversie-bytes');
    const refreshed = (await (await fetch(base + `/v?id=${id}`)).text()).match(/<source src="([^"]+)"/)[1];
    assert.notEqual(refreshed, source);

    assert.equal((await beacon({ id, event: 'open' })).status, 204);
    assert.equal((await beacon({ id, event: 'play' })).status, 204);
    assert.equal((await beacon({ id, event: 'complete' })).status, 204);
    assert.equal((await beacon({ id, event: 'play' })).status, 204);
    assert.equal((await beacon({ id, event: 'verzonnen' })).status, 400);
    assert.equal((await beacon({ id: '../etc/passwd', event: 'play' })).status, 400);
    assert.equal((await beacon({ id: 'ffffffffff', event: 'play' })).status, 404);

    views.flush();
    const stored = JSON.parse(fs.readFileSync(path.join(data, 'views.json'), 'utf8')).videos[id];
    assert.deepEqual([stored.opens, stored.plays, stored.completions], [1, 2, 1]);
    assert.equal(Object.keys(stored.days).length, 1);
    assert.ok(stored.lastAt >= stored.firstAt);

    const admin = await (await fetch(base + '/admin', { headers: { authorization: auth } })).text();
    assert.match(admin, /Kijkcijfers/);
    assert.match(admin, /1× geopend · 2× gestart · 1× uitgekeken/);
    assert.match(admin, /2× gestart<\/p>/); // albumtotaal in de kop
    assert.equal((await fetch(base + '/admin/scan-status')).status, 401);
    assert.deepEqual(await (await fetch(base + '/admin/scan-status', { headers: { authorization: auth } })).json(), { running: false, log: '' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('een achtergebleven slot van een gestopt proces blokkeert een nieuwe scan niet', async () => {
  const { withDataLock } = require('../archive');
  const lockDir = path.join(temporary, 'slot');
  const lockFile = path.join(lockDir, 'update.lock');
  fs.mkdirSync(lockDir, { recursive: true });

  // Een container die tijdens een lange scan herstartte, laat zo'n slot achter.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483646, startedAt: new Date().toISOString() }));
  let ranAfterStaleLock = false;
  await withDataLock(lockDir, async () => { ranAfterStaleLock = true; });
  assert.ok(ranAfterStaleLock);
  assert.equal(fs.existsSync(lockFile), false);

  // Een slot van een draaiend proces blijft blokkeren.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await assert.rejects(withDataLock(lockDir, async () => {}), /Er draait al/);
  assert.ok(fs.existsSync(lockFile));
  fs.rmSync(lockFile);
});

test.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
