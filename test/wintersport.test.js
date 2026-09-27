const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wintersport-'));
process.env.DATA_DIR = path.join(root,'data');
process.env.VIDEOS_DIR = path.join(root,'videos');
process.env.ADMIN_PASSWORD = 'test-only';
fs.mkdirSync(process.env.DATA_DIR,{recursive:true});
const {app} = require('../server');
test('winter theme can be selected, renders its videos and preserves artwork when frozen', async()=>{
 fs.writeFileSync(path.join(process.env.DATA_DIR,'mapping.json'), JSON.stringify({aabbccddee:'Ski/Film.mp4'}));
 fs.mkdirSync(path.join(process.env.VIDEOS_DIR,'Ski'),{recursive:true});
 fs.writeFileSync(path.join(process.env.VIDEOS_DIR,'Ski/Film.mp4'),'video');
 const server = app.listen(0,'127.0.0.1');
 await new Promise(r=>server.once('listening',r));
 const base = `http://127.0.0.1:${server.address().port}`;
 const authorization='Basic '+Buffer.from('admin:test-only').toString('base64');
 try {
  assert.match(await(await fetch(base+'/admin',{headers:{authorization}})).text(),/value="wintersport"/);
  const save=await fetch(base+'/admin/gallery-settings',{method:'POST',headers:{authorization,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({folder:'Ski',theme:'wintersport',title:'Squash <2026>',subtitle:'Dolomiti'})});
  assert.equal(save.status,200);
  const page=await(await fetch(base+'/gallery?folder=Ski')).text();
  assert.match(page,/Squash &lt;2026&gt;/);
  assert.match(page,/wintersport.css/);assert.match(page,/1 film/);assert.match(page,/\/v\?id=aabbccddee/);
  assert.equal((await fetch(base+'/assets/wintersport-header.png')).status,200);
  await require('../freeze').freezeAlbum('Ski');
  const frozen=await(await fetch(base+'/gallery?folder=Ski')).text();
  assert.match(frozen,/data:image\/png;base64/);assert.doesNotMatch(frozen,/href="\/assets\/wintersport.css"/);
 } finally {await new Promise(r=>server.close(r));}
});
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
