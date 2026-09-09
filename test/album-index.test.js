const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-index-'));
process.env.DATA_DIR = root;
process.env.ADMIN_PASSWORD = 'test-only';
const {app} = require('../server');
test('public index links albums, escapes titles, includes loose videos and leaves admin protected', async () => {
 fs.writeFileSync(path.join(root,'mapping.json'), JSON.stringify({a:'thailand/Film.mp4', b:'Los.mp4'}));
 fs.writeFileSync(path.join(root,'gallery-settings.json'), JSON.stringify({thailand:{title:'Reis <2026>',subtitle:'Samen & weg'}}));
 const server = app.listen(0,'127.0.0.1');
 await new Promise(resolve=>server.once('listening',resolve));
 const base = `http://127.0.0.1:${server.address().port}`;
 try {
  const response = await fetch(base+'/'); assert.equal(response.status,200);
  const html = await response.text();
  assert.match(html,/Reis &lt;2026&gt;/); assert.match(html,/Samen &amp; weg/);
  assert.match(html,/gallery\?folder=thailand/); assert.match(html,/gallery\?folder=zuid-afrika/);
  assert.match(html,/Overige herinneringen/); assert.doesNotMatch(html,/\/admin/);
  assert.equal(await(await fetch(base+'/gallery')).text(),html);
  for(const url of ['/gallery?folder=thailand','/gallery?folder=.','/assets/album-index.css']) assert.equal((await fetch(base+url)).status,200);
  assert.equal((await fetch(base+'/admin')).status,401);
  fs.writeFileSync(path.join(root,'mapping.json'),'{}');
  assert.match(await(await fetch(base+'/')).text(),/Binnenkort/);
 } finally { await new Promise(resolve=>server.close(resolve)); }
});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
