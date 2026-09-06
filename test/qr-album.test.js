const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { parseVideoLabel, adminPage } = require('../server');

test('extracts step, multi-word place and activity from delimited filenames', () => {
  assert.deepEqual(parseVideoLabel('Thailand/01 - Chiang Mai - Tempelbezoek.mp4'),
    { step: '01', city: 'Chiang Mai', activity: 'Tempelbezoek' });
  assert.deepEqual(parseVideoLabel('Thailand/Step 02_Bangkok_Fietsen.mp4'),
    { step: '02', city: 'Bangkok', activity: 'Fietsen' });
  assert.deepEqual(parseVideoLabel('Thailand/Stap nr. 03 - Pai - Wandelen compleet 9x16 (2).MOV'),
    { step: '03', city: 'Pai', activity: 'Wandelen' });
  assert.deepEqual(parseVideoLabel('reis/4 - Chiang_Mai - Night_market.mp4'),
    { step: '4', city: 'Chiang Mai', activity: 'Night market' });
});

test('keeps ambiguous places empty and does not mistake an activity number for a step', () => {
  assert.deepEqual(parseVideoLabel('Thailand/River Kwai 2.mp4'),
    { step: '', city: '', activity: 'The River Kwai' });
  assert.deepEqual(parseVideoLabel('Thailand/12 Fietsen in Bangkok.mp4'),
    { step: '12', city: '', activity: 'Fietsen in Bangkok' });
});

test('generated admin browser script parses', () => {
  const html = adminPage();
  assert.match(html, /Vakantiealbum downloaden/);
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
});
