'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');const fs=require('node:fs'),os=require('node:os'),path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const {shared,exclusive}=require('../lib/data-access');const {createSnapshot,restoreSnapshot,verifySnapshot}=require('../lib/snapshots');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ritual-backup-')),data=path.join(root,'data');fs.mkdirSync(path.join(data,'blobs'),{recursive:true});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const db=new DatabaseSync(path.join(data,'bojin.db'));db.exec('PRAGMA journal_mode=WAL; CREATE TABLE blobs(id TEXT,size INTEGER); CREATE TABLE docs(path TEXT,data TEXT); CREATE TABLE users(id TEXT,pass TEXT)');
 const id='a'.repeat(32);fs.writeFileSync(path.join(data,'blobs',id),'photo');db.prepare('INSERT INTO blobs VALUES (?,?)').run(id,5);db.exec("INSERT INTO docs VALUES ('profile','original'); INSERT INTO users VALUES ('u_existing','original-legacy-hash')");db.close();return {root,data};}
test('maintenance excludes running app/admin writers, and prevents new writers',t=>{const {data}=fixture(t);const release=shared(data);assert.throws(()=>exclusive(data),/Stop the server/);release();const end=exclusive(data);assert.throws(()=>shared(data),/maintenance/);end();shared(data)();});
test('snapshot/restore preserves both databases and photos; refuses active writers and overwrites',async t=>{const {data,root}=fixture(t),target=path.join(root,'snapshot');const auth=new DatabaseSync(path.join(data,'auth.sqlite'));auth.exec("CREATE TABLE user(id TEXT); INSERT INTO user VALUES('u_existing')");auth.close();
 const active=shared(data);await assert.rejects(createSnapshot(data,target),/Stop the server/);active();await createSnapshot(data,target);assert.equal(verifySnapshot(target).files.length,3);
 const restored=path.join(root,'restored');restoreSnapshot(target,restored,{version:1,users:[]});const db=new DatabaseSync(path.join(restored,'bojin.db'));assert.equal(db.prepare('SELECT data FROM docs').get().data,'original');db.close();assert.equal(fs.readFileSync(path.join(restored,'blobs','a'.repeat(32)),'utf8'),'photo');assert.throws(()=>restoreSnapshot(target,restored,{version:1,users:[]}),/empty destination/);assert.throws(()=>restoreSnapshot(target,path.join(root,'missing-ledger')),/deletion ledger/);
 fs.appendFileSync(path.join(target,'blobs','a'.repeat(32)),'corrupt');assert.throws(()=>verifySnapshot(target),/checksum/);
});
test('pre-auth migration rollback restores legacy identity and excludes new auth state',async t=>{const {root,data}=fixture(t),snapshot=path.join(root,'before-migration');await createSnapshot(data,snapshot);
 const {createAuth}=require('../lib/auth');const mails=[];const auth=await createAuth({dataDir:data,baseURL:'http://localhost:8080',secret:'migration-test-secret-at-least-32-characters',cookieSecure:false,sendEmail:async m=>mails.push(m)});
 const invitation=auth.invites.issue('existing@example.com',{userId:'u_existing'});
 const request=new Request('http://localhost:8080/api/auth/sign-up/email',{method:'POST',headers:{origin:'http://localhost:8080','content-type':'application/json'},body:JSON.stringify({email:invitation.email,name:'Existing',password:'migration test password',invitation:invitation.token,consentTerms:true,consentSensitiveCrossBorder:true,agreedConsentVersion:'2026-11-25'})});
 const response=await auth.auth.handler(request);assert.equal(response.status,200);assert.equal((await response.json()).user.id,'u_existing');await auth.auth.handler(new Request(mails[0].url));auth.close();
 const db=new DatabaseSync(path.join(data,'bojin.db'));assert.equal(db.prepare('SELECT data FROM docs').get().data,'original');db.exec("UPDATE docs SET data='changed after migration'");db.close();
 const restored=path.join(root,'rollback');restoreSnapshot(snapshot,restored,{version:1,users:[]});const old=new DatabaseSync(path.join(restored,'bojin.db'));assert.equal(old.prepare('SELECT data FROM docs').get().data,'original');assert.equal(old.prepare('SELECT pass FROM users').get().pass,'original-legacy-hash');old.close();assert.equal(fs.existsSync(path.join(restored,'auth.sqlite')),false);
});

test('backup containment check resolves symlinked parent paths',async t=>{const {root,data}=fixture(t),alias=path.join(root,'alias');fs.symlinkSync(data,alias,'dir');await assert.rejects(createSnapshot(data,path.join(alias,'backup')),/outside DATA_DIR/);assert.equal(fs.existsSync(path.join(data,'backup')),false);});
test('WAL backups are normalized and verification never adds sidecars',async t=>{
 const {root,data}=fixture(t),snapshot=path.join(root,'snapshot');await createSnapshot(data,snapshot);
 const file=path.join(snapshot,'bojin.db'),db=new DatabaseSync(file);
 assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'delete');db.close();
 const before=fs.readdirSync(snapshot);verifySnapshot(snapshot);assert.deepEqual(fs.readdirSync(snapshot),before);
});
for(const legacy of [false,true])test('read-only snapshot verifies and restores (legacy='+legacy+')',{skip:process.getuid?.()===0},async t=>{
 const {root,data}=fixture(t),snapshot=path.join(root,'snapshot');await createSnapshot(data,snapshot);
 if(legacy){const file=path.join(snapshot,'bojin.db'),db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL');db.close();const manifest=JSON.parse(fs.readFileSync(path.join(snapshot,'manifest.json')));const item=manifest.files.find(f=>f.name==='bojin.db');item.sha256=require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');item.size=fs.statSync(file).size;fs.writeFileSync(path.join(snapshot,'manifest.json'),JSON.stringify(manifest));}
 const before=fs.readdirSync(snapshot);
 for(const name of before)if(name!=='blobs')fs.chmodSync(path.join(snapshot,name),0o444);
 fs.chmodSync(path.join(snapshot,'blobs','a'.repeat(32)),0o444);fs.chmodSync(path.join(snapshot,'blobs'),0o555);fs.chmodSync(snapshot,0o555);

 try{verifySnapshot(snapshot);restoreSnapshot(snapshot,path.join(root,'restore'),{version:1,users:[]});assert.deepEqual(fs.readdirSync(snapshot),before);}
 finally{fs.chmodSync(snapshot,0o755);fs.chmodSync(path.join(snapshot,'blobs'),0o755);}
});
test('failed replay rolls back rows and restore can retry',async t=>{
 const {root,data}=fixture(t);const db=new DatabaseSync(path.join(data,'bojin.db'));db.exec("ALTER TABLE docs ADD COLUMN uid TEXT; ALTER TABLE blobs ADD COLUMN uid TEXT; UPDATE docs SET uid='u_existing'; CREATE TRIGGER fail_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT,'injected'); END");db.close();
 const ledger={version:1,users:[{uid:'u_existing',requested:'today'}]};
 const {applyLedger}=require('../lib/deletion-ledger');assert.throws(()=>applyLedger(data,ledger),/injected/);
 const check=new DatabaseSync(path.join(data,'bojin.db'));assert.equal(check.prepare('SELECT count(*) n FROM docs').get().n,1);check.close();
 const snapshot=path.join(root,'snapshot');await createSnapshot(data,snapshot);const target=path.join(root,'restore');
 assert.throws(()=>restoreSnapshot(snapshot,target,ledger),/injected/);assert.deepEqual(fs.readdirSync(target),[]);
 restoreSnapshot(snapshot,target,{version:1,users:[]});
});
test('partial database copy is cleaned before retry',async t=>{
 const {root,data}=fixture(t),snapshot=path.join(root,'snapshot'),target=path.join(root,'restore');await createSnapshot(data,snapshot);
 const copy=fs.copyFileSync;
 try{fs.copyFileSync=(source,destination,...args)=>{if(destination===path.join(target,'bojin.db')){fs.writeFileSync(destination,'partial');throw Object.assign(new Error('disk full'),{code:'ENOSPC'});}return copy(source,destination,...args);};
 assert.throws(()=>restoreSnapshot(snapshot,target,{version:1,users:[]}),/disk full/);assert.deepEqual(fs.readdirSync(target),[]);
 }finally{fs.copyFileSync=copy;}
 restoreSnapshot(snapshot,target,{version:1,users:[]});
});
test('later auth error preserves both databases and blob files',t=>{
 const {data}=fixture(t),app=new DatabaseSync(path.join(data,'bojin.db'));
 app.exec("ALTER TABLE docs ADD COLUMN uid TEXT; ALTER TABLE blobs ADD COLUMN uid TEXT; UPDATE blobs SET uid='u_existing'; UPDATE docs SET uid='u_existing';");app.close();
 const auth=new DatabaseSync(path.join(data,'auth.sqlite'));auth.exec("CREATE TABLE user(id TEXT); INSERT INTO user VALUES('u_existing'),('u_later'); CREATE TRIGGER fail_delete BEFORE DELETE ON user WHEN OLD.id='u_later' BEGIN SELECT RAISE(ABORT,'auth failure'); END");auth.close();
 assert.throws(()=>require('../lib/deletion-ledger').applyLedger(data,{version:1,users:[{uid:'u_existing',requested:'today'},{uid:'u_later',requested:'today'}]}),/auth failure/);
 for(const [name,sql,count] of [['bojin.db','SELECT count(*) n FROM docs',1],['auth.sqlite','SELECT count(*) n FROM user',2]]){const db=new DatabaseSync(path.join(data,name));assert.equal(db.prepare(sql).get().n,count);db.close();}
 assert.equal(fs.readFileSync(path.join(data,'blobs','a'.repeat(32)),'utf8'),'photo');
});

test('deduplicated snapshots hardlink unchanged photos and restore cleanly after older snapshots are pruned',async t=>{
 const {root,data}=fixture(t);
 const idA='a'.repeat(32),idB='b'.repeat(32),idC='c'.repeat(32);
 fs.writeFileSync(path.join(data,'blobs',idB),'second-photo-bytes');
 const db1=new DatabaseSync(path.join(data,'bojin.db'));
 db1.prepare('INSERT INTO blobs VALUES (?,?)').run(idB,18);
 db1.close();

 const snap1=path.join(root,'snapshot-1');
 const r1=await createSnapshot(data,snap1);
 assert.equal(r1.linkedBlobs,0);
 assert.equal(r1.copiedBlobs,2);

 // Modify docs, add photo C, keep photo A unchanged, remove photo B.
 fs.writeFileSync(path.join(data,'blobs',idC),'third-photo-content');
 fs.rmSync(path.join(data,'blobs',idB));
 const db2=new DatabaseSync(path.join(data,'bojin.db'));
 db2.exec("UPDATE docs SET data='updated-v2'");
 db2.prepare('DELETE FROM blobs WHERE id=?').run(idB);
 db2.prepare('INSERT INTO blobs VALUES (?,?)').run(idC,19);
 db2.close();

 const snap2=path.join(root,'snapshot-2');
 const r2=await createSnapshot(data,snap2,{linkFrom:[snap1]});
 assert.equal(r2.linkedBlobs,1);
 assert.equal(r2.copiedBlobs,1);

 const liveA=fs.lstatSync(path.join(data,'blobs',idA));
 const s1A=fs.lstatSync(path.join(snap1,'blobs',idA));
 const s2A=fs.lstatSync(path.join(snap2,'blobs',idA));
 const s2C=fs.lstatSync(path.join(snap2,'blobs',idC));
 assert.equal(s2A.dev,s1A.dev);
 assert.equal(s2A.ino,s1A.ino);
 assert.equal(s2A.nlink,2);
 assert.notEqual(s2A.ino,liveA.ino);
 assert.equal(s2C.nlink,1);
 assert.notEqual(fs.lstatSync(path.join(snap2,'bojin.db')).ino,fs.lstatSync(path.join(snap1,'bojin.db')).ino);

 const snap3=path.join(root,'snapshot-3');
 const r3=await createSnapshot(data,snap3,{linkFrom:[snap2,snap1]});
 assert.equal(r3.linkedBlobs,2);
 assert.equal(r3.copiedBlobs,0);
 assert.equal(fs.lstatSync(path.join(snap3,'blobs',idA)).nlink,3);
 assert.equal(fs.lstatSync(path.join(snap3,'blobs',idC)).nlink,2);

 // Prune ALL older snapshots; snap3 must remain self-contained, verifiable, and restorable.
 fs.rmSync(snap1,{recursive:true,force:true});
 fs.rmSync(snap2,{recursive:true,force:true});
 assert.equal(fs.lstatSync(path.join(snap3,'blobs',idA)).nlink,1);
 assert.equal(fs.lstatSync(path.join(snap3,'blobs',idC)).nlink,1);
 verifySnapshot(snap3);

 const restored=path.join(root,'restored-after-prune');
 restoreSnapshot(snap3,restored,{version:1,users:[]});
 const rdb=new DatabaseSync(path.join(restored,'bojin.db'),{readOnly:true});
 assert.equal(rdb.prepare('SELECT data FROM docs').get().data,'updated-v2');
 rdb.close();
 assert.equal(fs.readFileSync(path.join(restored,'blobs',idA),'utf8'),'photo');
 assert.equal(fs.readFileSync(path.join(restored,'blobs',idC),'utf8'),'third-photo-content');
 // Restored files must be independent copies, never hardlinked back to the snapshot archive.
 assert.notEqual(fs.lstatSync(path.join(restored,'blobs',idA)).ino,fs.lstatSync(path.join(snap3,'blobs',idA)).ino);
 assert.equal(fs.lstatSync(path.join(restored,'blobs',idA)).mode&0o777,0o600);
});

test('corrupt or non-private previous snapshot blobs fall back to fresh copy without poisoning new snapshots',async t=>{
 const {root,data}=fixture(t);
 const idA='a'.repeat(32);
 const snap1=path.join(root,'snap1');
 await createSnapshot(data,snap1);

 // Corrupt snap1 blob in place keeping exact same byte length (5 bytes).
 fs.writeFileSync(path.join(snap1,'blobs',idA),'XXXXX');
 const snap2=path.join(root,'snap2');
 const r2=await createSnapshot(data,snap2,{linkFrom:[snap1]});
 assert.equal(r2.linkedBlobs,0);
 assert.equal(r2.copiedBlobs,1);
 assert.notEqual(fs.lstatSync(path.join(snap2,'blobs',idA)).ino,fs.lstatSync(path.join(snap1,'blobs',idA)).ino);
 assert.equal(fs.readFileSync(path.join(snap2,'blobs',idA),'utf8'),'photo');
 verifySnapshot(snap2);

 // World-readable candidate blob in snap2 must not be hardlinked into snap3.
 fs.chmodSync(path.join(snap2,'blobs',idA),0o644);
 const snap3=path.join(root,'snap3');
 const r3=await createSnapshot(data,snap3,{linkFrom:[snap2]});
 assert.equal(r3.linkedBlobs,0);
 assert.equal(r3.copiedBlobs,1);
 assert.equal(fs.lstatSync(path.join(snap3,'blobs',idA)).mode&0o777,0o600);
 assert.notEqual(fs.lstatSync(path.join(snap3,'blobs',idA)).ino,fs.lstatSync(path.join(snap2,'blobs',idA)).ino);

 // linkFrom pointing at DATA_DIR must never hardlink live files.
 const snap4=path.join(root,'snap4');
 await createSnapshot(data,snap4,{linkFrom:[data]});
 assert.notEqual(fs.lstatSync(path.join(snap4,'blobs',idA)).ino,fs.lstatSync(path.join(data,'blobs',idA)).ino);
});

test('data-backup.js CLI supports --link-dest and --defer-blobs safely',async t=>{
 const {spawnSync}=require('node:child_process');
 const cli=path.join(__dirname,'../scripts/data-backup.js');
 const {root,data}=fixture(t);
 const idA='a'.repeat(32),idB='b'.repeat(32);
 const snap1=path.join(root,'cli-snap1'),snap2=path.join(root,'cli-snap2'),snap3=path.join(root,'cli-snap3');
 const env={...process.env,DATA_DIR:data};

 assert.equal(spawnSync(process.execPath,[cli,'backup',snap1],{env,encoding:'utf8'}).status,0);
 assert.equal(spawnSync(process.execPath,[cli,'backup',snap2,'--link-dest',snap1],{env,encoding:'utf8'}).status,0);
 assert.equal(fs.lstatSync(path.join(snap2,'blobs',idA)).ino,fs.lstatSync(path.join(snap1,'blobs',idA)).ino);

 // Add new blob B, defer blob A via index file.
 fs.writeFileSync(path.join(data,'blobs',idB),'new-blob');
 const db=new DatabaseSync(path.join(data,'bojin.db'));
 db.prepare('INSERT INTO blobs VALUES (?,?)').run(idB,8);
 db.close();
 const m1=JSON.parse(fs.readFileSync(path.join(snap1,'manifest.json'),'utf8'));
 const entryA=m1.files.find(f=>f.name==='blobs/'+idA);
 const deferIndex=path.join(root,'defer.json');
 fs.writeFileSync(deferIndex,JSON.stringify({version:1,sha256:{[entryA.sha256]:entryA.size}}),{mode:0o600});

 const res3=spawnSync(process.execPath,[cli,'backup',snap3,'--defer-blobs',deferIndex],{env,encoding:'utf8'});
 assert.equal(res3.status,0,res3.stderr);
 assert.equal(fs.existsSync(path.join(snap3,'blobs',idA)),false);
 assert.equal(fs.existsSync(path.join(snap3,'blobs',idB)),true);
 // Normal verifySnapshot MUST reject un-materialized deferred snapshot.
 assert.throws(()=>verifySnapshot(snap3));
 // After privileged caller hardlinks deferred blob and prunes snap1/snap2, verify & restore succeed.
 fs.linkSync(path.join(snap1,'blobs',idA),path.join(snap3,'blobs',idA));
 fs.rmSync(snap1,{recursive:true,force:true});
 fs.rmSync(snap2,{recursive:true,force:true});
 assert.equal(spawnSync(process.execPath,[cli,'verify',snap3],{env,encoding:'utf8'}).status,0);
 const ledger=path.join(root,'deletions.json');
 assert.equal(spawnSync(process.execPath,[cli,'ledger',ledger],{env,encoding:'utf8'}).status,0);
 const restored=path.join(root,'cli-restored');
 assert.equal(spawnSync(process.execPath,[cli,'restore',snap3,restored,'--deletions',ledger],{env,encoding:'utf8'}).status,0);
 assert.equal(fs.readFileSync(path.join(restored,'blobs',idA),'utf8'),'photo');
 assert.equal(fs.readFileSync(path.join(restored,'blobs',idB),'utf8'),'new-blob');
});

test('createSnapshot fsyncs new files, snapshot directories, and parent directory',async t=>{
 const {root,data}=fixture(t);
 const idA='a'.repeat(32);
 const syncedInodes=[];
 const origFsync=fs.fsyncSync;
 fs.fsyncSync=fd=>{const st=fs.fstatSync(fd);syncedInodes.push(`${st.dev}:${st.ino}`);return origFsync(fd);};
 let snap;
 try{
  snap=path.join(root,'durable-snap');
  await createSnapshot(data,snap);
 }finally{fs.fsyncSync=origFsync;}
 for(const p of [path.join(snap,'bojin.db'),path.join(snap,'manifest.json'),path.join(snap,'blobs',idA),path.join(snap,'blobs'),snap,root]){
  const st=fs.lstatSync(p);
  assert.ok(syncedInodes.includes(`${st.dev}:${st.ino}`),`Expected fsyncSync on ${p}`);
 }
});

test('legacy server.js import uses exclusive blob creation and never overwrites orphaned files',t=>{
 const {spawnSync}=require('node:child_process');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ritual-legacy-import-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const data=path.join(root,'data'),src=path.join(root,'export');
 fs.mkdirSync(path.join(data,'blobs'),{recursive:true});
 fs.mkdirSync(path.join(src,'blobs'),{recursive:true});
 const db=new DatabaseSync(path.join(data,'bojin.db'));
 db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE,pass TEXT,created TEXT); CREATE TABLE docs(path TEXT PRIMARY KEY,uid TEXT,parent TEXT,data TEXT,updated TEXT); CREATE TABLE blobs(id TEXT PRIMARY KEY,uid TEXT,type TEXT,size INT,created TEXT); INSERT INTO users VALUES('u1','alice','h','2026-01-01');");
 db.close();
 const orphanId='d'.repeat(32),freshId='e'.repeat(32);
 // Plant an orphaned file on disk that is absent from the blobs table.
 fs.writeFileSync(path.join(data,'blobs',orphanId),'original-orphan-bytes',{mode:0o600});
 fs.writeFileSync(path.join(src,'blobs',orphanId+'.jpg'),'malicious-overwrite');
 fs.writeFileSync(path.join(src,'blobs',freshId+'.webp'),'fresh-import-bytes');
 const env={...process.env,DATA_DIR:data,AUTH_SECRET:'legacy-import-test-secret-at-least-32-chars',COOKIE_SECURE:'0',MAIL_MODE:'file',AUTH_BASE_URL:'http://127.0.0.1:18080'};
 const res=spawnSync(process.execPath,[path.join(__dirname,'../server.js'),'import','alice',src],{env,encoding:'utf8'});
 assert.equal(res.status,0,res.stderr);
 assert.equal(fs.readFileSync(path.join(data,'blobs',orphanId),'utf8'),'original-orphan-bytes');
 assert.equal(fs.readFileSync(path.join(data,'blobs',freshId),'utf8'),'fresh-import-bytes');
 assert.equal(fs.lstatSync(path.join(data,'blobs',freshId)).mode&0o777,0o600);
});
