'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),sharp=require('sharp');const {DatabaseSync}=require('node:sqlite');const {createUploads}=require('../lib/uploads');
function fixture(t,options){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ritual-uploads-'));fs.mkdirSync(path.join(dir,'blobs'));const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE blobs(id TEXT,uid TEXT,type TEXT,size INTEGER,created TEXT)');t.after(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});});return{db,dir,uploads:createUploads(db,dir,options)};}
test('uploaded bytes must decode as an image and are normalized before storage',async t=>{const {uploads}=fixture(t);await assert.rejects(uploads.normalize(Buffer.from('<script>alert(1)</script>')),e=>e.status===415);const png=await sharp({create:{width:10,height:10,channels:3,background:'red'}}).png().toBuffer();const output=await uploads.normalize(png);assert.equal((await sharp(output).metadata()).format,'webp');assert.equal((await sharp(output).metadata()).exif,undefined);});
test('storage quotas and daily/concurrent limits reject excess work without orphan files',t=>{const {uploads,dir,db}=fixture(t,{userBytes:5,totalBytes:8,daily:2});const release=uploads.begin('one');assert.throws(()=>uploads.begin('one'),e=>e.status===429);release();uploads.begin('one')();assert.throws(()=>uploads.begin('one'),e=>e.status===429);uploads.save('one',Buffer.alloc(4));assert.throws(()=>uploads.save('one',Buffer.alloc(2)),e=>e.code==='storage_quota');uploads.save('two',Buffer.alloc(4));assert.throws(()=>uploads.save('three',Buffer.alloc(1)),e=>e.code==='storage_quota');assert.equal(fs.readdirSync(path.join(dir,'blobs')).length,2);assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs').get().n,2);});

test('a partial write failure removes the owned file and rolls back quota metadata',t=>{
 const {uploads,dir,db}=fixture(t),original=fs.writeFileSync;
 t.mock.method(fs,'writeFileSync',(target,data,...rest)=>{if(typeof target==='number'){original(target,Buffer.from('partial'));throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}return original(target,data,...rest);});
 assert.throws(()=>uploads.save('one',Buffer.from('private photo')),e=>e.code==='ENOSPC');
 assert.equal(fs.readdirSync(path.join(dir,'blobs')).length,0);assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs').get().n,0);
});

test('idempotency keys deduplicate committed uploads across restarts, isolate users, and expire cleanly',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ritual-uploads-idem-'));
 fs.mkdirSync(path.join(dir,'blobs'));
 const dbPath=path.join(dir,'bojin.db');
 let db=new DatabaseSync(dbPath);
 db.exec('CREATE TABLE blobs(id TEXT PRIMARY KEY,uid TEXT,type TEXT,size INTEGER,created TEXT)');
 t.after(()=>{try{db.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});});

 const payload=Buffer.from('normalized-webp-bytes');
 // Tight quotas (daily=1, userBytes=payload.length) prove retry does not double-count daily or byte quota.
 let uploads=createUploads(db,dir,{userBytes:payload.length,totalBytes:payload.length*2,daily:1,keyTtlMs:60000});
 const key='idem_commit_lost_key_0001';
 assert.equal(uploads.lookup('u_alice',key),null);
 uploads.begin('u_alice')();
 const first=uploads.save('u_alice',payload,key);
 assert.equal(fs.readdirSync(path.join(dir,'blobs')).length,1);

 // Simulate server restart by closing SQLite and creating a brand-new uploads instance on bojin.db.
 db.close();
 db=new DatabaseSync(dbPath);
 uploads=createUploads(db,dir,{userBytes:payload.length,totalBytes:payload.length*2,daily:1,keyTtlMs:60000});

 // Retry after response loss finds committed blob before begin(), so daily=1 and userBytes=payload.length are not exceeded.
 const hit=uploads.lookup('u_alice',key);
 assert.deepEqual(hit,first);
 const savedAgain=uploads.save('u_alice',payload,key);
 assert.deepEqual(savedAgain,first);
 assert.equal(fs.readdirSync(path.join(dir,'blobs')).length,1);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs WHERE uid=?').get('u_alice').n,1);
 assert.equal(db.prepare('SELECT n FROM upload_usage WHERE uid=?').get('u_alice').n,1);

 // Another user reusing the exact same Idempotency-Key never receives u_alice's blob and stores their own isolated blob.
 assert.equal(uploads.lookup('u_bob',key),null);
 uploads.begin('u_bob')();
 const bobBlob=uploads.save('u_bob',payload,key);
 assert.notEqual(bobBlob.id,first.id);
 assert.equal(fs.readdirSync(path.join(dir,'blobs')).length,2);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM blobs WHERE uid=?').get('u_bob').n,1);

 // Expired keys are pruned and invalid keys are rejected.
 assert.equal(uploads.lookup('u_alice',key,Date.now()+60001),null);
 for(const bad of ['','short','bad space','x'.repeat(129)]){
  assert.throws(()=>uploads.parseKey(bad),e=>e.status===400&&e.code==='bad_idempotency_key');
 }
});

test('HTTP commit-then-response-loss retry returns same blob id with single disk file and single quota count', {timeout:30000}, async t=>{
 const http=require('node:http');
 const {spawn,spawnSync}=require('node:child_process');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ritual-http-idem-'));
 const png=await sharp({create:{width:24,height:24,channels:3,background:'teal'}}).png().toBuffer();
 const normalizedSize=(await sharp(png).rotate().resize({width:2560,height:2560,fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer()).length;

 // Start server on ephemeral port with PHOTO_DAILY_LIMIT=1 and PHOTO_USER_BYTES=normalizedSize
 // so any duplicate write or double-counted daily attempt would fail with 429 or 413.
 const baseEnv={...process.env,DATA_DIR:dir,PORT:'0',HOST:'127.0.0.1',AUTH_BASE_URL:'http://127.0.0.1:18099',AUTH_SECRET:'idem-http-test-secret-at-least-32-chars',COOKIE_SECURE:'0',TRUST_PROXY:'0',MAIL_MODE:'file',OPENROUTER_API_KEY:'',PHOTO_DAILY_LIMIT:'1',PHOTO_USER_BYTES:String(normalizedSize)};
 const issue=email=>JSON.parse(spawnSync(process.execPath,['scripts/auth-admin.js','invite',email],{env:baseEnv,encoding:'utf8',timeout:5000}).stdout);
 const alice=issue('alice-idem@example.com'),bob=issue('bob-idem@example.com');
 const child=spawn(process.execPath,['server.js'],{env:baseEnv,stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',d=>{stderr+=d;});
 const startup=await new Promise((resolve,reject)=>{child.stdout.once('data',d=>resolve(d.toString()));child.once('exit',()=>reject(new Error(stderr)));});
 const serverPort=+startup.match(/:(\d+)/)[1];
 const serverOrigin=`http://127.0.0.1:${serverPort}`;

 // Proxy drops the first POST /api/assets response AFTER server.js has committed the blob to disk.
 let dropNextAssetResponse=true,committedOnFirstAttempt=null;
 const proxy=http.createServer((clientReq,clientRes)=>{
  const upstream=http.request({hostname:'127.0.0.1',port:serverPort,path:clientReq.url,method:clientReq.method,headers:clientReq.headers},upRes=>{
   const chunks=[];
   upRes.on('data',c=>chunks.push(c));
   upRes.on('end',()=>{
    const body=Buffer.concat(chunks);
    if(dropNextAssetResponse&&clientReq.method==='POST'&&clientReq.url==='/api/assets'&&upRes.statusCode===200){
     dropNextAssetResponse=false;
     committedOnFirstAttempt=JSON.parse(body.toString('utf8'));
     clientRes.destroy();
     return;
    }
    clientRes.writeHead(upRes.statusCode,upRes.headers);
    clientRes.end(body);
   });
  });
  clientReq.pipe(upstream);
 });
 await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
 const proxyOrigin=`http://127.0.0.1:${proxy.address().port}`;
 t.after(async()=>{
  await new Promise(r=>proxy.close(r));
  if(child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}
  fs.rmSync(dir,{recursive:true,force:true});
 });

 const registerAndLogin=async inv=>{
  const password='strong-idempotency-password';
  const req=(route,body)=>fetch(serverOrigin+route,{method:'POST',headers:{origin:'http://127.0.0.1:18099','Content-Type':'application/json','X-Bojin':'1'},body:JSON.stringify(body)});
  assert.equal((await req('/api/auth/sign-up/email',{email:inv.email,name:'User',password,invitation:inv.token,callbackURL:'/login.html'})).status,200);
  const mail=fs.readdirSync(path.join(dir,'mail')).map(f=>JSON.parse(fs.readFileSync(path.join(dir,'mail',f),'utf8'))).find(m=>m.to===inv.email&&m.kind==='verify');
  const verifyUrl=new URL(mail.url);verifyUrl.host=`127.0.0.1:${serverPort}`;
  assert.equal((await fetch(verifyUrl,{redirect:'manual'})).status,302);
  const login=await req('/api/auth/sign-in/email',{email:inv.email,password});
  assert.equal(login.status,200);
  return login.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
 };
 const aliceCookie=await registerAndLogin(alice);
 const bobCookie=await registerAndLogin(bob);

 const sharedKey='client_upload_attempt_key_12345';
 // Attempt 1 commits on server, then connection drops before client receives response.
 await assert.rejects(fetch(proxyOrigin+'/api/assets',{method:'POST',headers:{cookie:aliceCookie,'X-Bojin':'1','Content-Type':'image/png','Idempotency-Key':sharedKey},body:png}));
 assert.ok(committedOnFirstAttempt?.id);
 assert.equal(fs.readdirSync(path.join(dir,'blobs')).length,1);

 // Attempt 2 (retry with same Idempotency-Key) returns 200 with exact same blob id, 1 file on disk, quota counted once.
 const retryRes=await fetch(proxyOrigin+'/api/assets',{method:'POST',headers:{cookie:aliceCookie,'X-Bojin':'1','Content-Type':'image/png','Idempotency-Key':sharedKey},body:png});
 assert.equal(retryRes.status,200);
 const retried=await retryRes.json();
 assert.equal(retried.id,committedOnFirstAttempt.id);
 assert.equal(fs.readdirSync(path.join(dir,'blobs')).length,1);

 // Bob using the exact same Idempotency-Key is isolated: gets a distinct blob id and cannot read Alice's blob.
 const bobRes=await fetch(proxyOrigin+'/api/assets',{method:'POST',headers:{cookie:bobCookie,'X-Bojin':'1','Content-Type':'image/png','Idempotency-Key':sharedKey},body:png});
 assert.equal(bobRes.status,200);
 const bobUploaded=await bobRes.json();
 assert.notEqual(bobUploaded.id,committedOnFirstAttempt.id);
 assert.equal((await fetch(serverOrigin+committedOnFirstAttempt.url,{headers:{cookie:bobCookie}})).status,404);
 assert.equal(fs.readdirSync(path.join(dir,'blobs')).length,2);

 const inspect=new DatabaseSync(path.join(dir,'bojin.db'),{readOnly:true});
 try{
  assert.equal(inspect.prepare('SELECT COUNT(*) n FROM blobs WHERE uid=?').get(alice.userId).n,1);
  assert.equal(inspect.prepare('SELECT n FROM upload_usage WHERE uid=?').get(alice.userId).n,1);
  assert.equal(inspect.prepare('SELECT COUNT(*) n FROM blobs WHERE uid=?').get(bob.userId).n,1);
 }finally{inspect.close();}
});
