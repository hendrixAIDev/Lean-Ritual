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
 const request=new Request('http://localhost:8080/api/auth/sign-up/email',{method:'POST',headers:{origin:'http://localhost:8080','content-type':'application/json'},body:JSON.stringify({email:invitation.email,name:'Existing',password:'migration test password',invitation:invitation.token})});
 const response=await auth.auth.handler(request);assert.equal(response.status,200);assert.equal((await response.json()).user.id,'u_existing');await auth.auth.handler(new Request(mails[0].url));auth.close();
 const db=new DatabaseSync(path.join(data,'bojin.db'));assert.equal(db.prepare('SELECT data FROM docs').get().data,'original');db.exec("UPDATE docs SET data='changed after migration'");db.close();
 const restored=path.join(root,'rollback');restoreSnapshot(snapshot,restored,{version:1,users:[]});const old=new DatabaseSync(path.join(restored,'bojin.db'));assert.equal(old.prepare('SELECT data FROM docs').get().data,'original');assert.equal(old.prepare('SELECT pass FROM users').get().pass,'original-legacy-hash');old.close();assert.equal(fs.existsSync(path.join(restored,'auth.sqlite')),false);
});

test('backup containment check resolves symlinked parent paths',async t=>{const {root,data}=fixture(t),alias=path.join(root,'alias');fs.symlinkSync(data,alias,'dir');await assert.rejects(createSnapshot(data,path.join(alias,'backup')),/outside DATA_DIR/);assert.equal(fs.existsSync(path.join(data,'backup')),false);});
test('WAL backups are normalized and verification never adds sidecars',async t=>{
 const {root,data}=fixture(t),snapshot=path.join(root,'snapshot');await createSnapshot(data,snapshot);
 const file=path.join(snapshot,'bojin.db'),db=new DatabaseSync(file);
 assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'delete');db.close();
 const before=fs.readdirSync(snapshot);verifySnapshot(snapshot);assert.deepEqual(fs.readdirSync(snapshot),before);fs.chmodSync(snapshot,0o755);fs.chmodSync(path.join(snapshot,'blobs'),0o755);
});
for(const legacy of [false,true])test('read-only snapshot verifies and restores (legacy='+legacy+')',{skip:process.getuid?.()===0},async t=>{
 const {root,data}=fixture(t),snapshot=path.join(root,'snapshot');await createSnapshot(data,snapshot);
 if(legacy){const file=path.join(snapshot,'bojin.db'),db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL');db.close();const manifest=JSON.parse(fs.readFileSync(path.join(snapshot,'manifest.json')));const item=manifest.files.find(f=>f.name==='bojin.db');item.sha256=require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');item.size=fs.statSync(file).size;fs.writeFileSync(path.join(snapshot,'manifest.json'),JSON.stringify(manifest));}
 const before=fs.readdirSync(snapshot);
 for(const name of before)if(name!=='blobs')fs.chmodSync(path.join(snapshot,name),0o444);
 fs.chmodSync(path.join(snapshot,'blobs','a'.repeat(32)),0o444);fs.chmodSync(path.join(snapshot,'blobs'),0o555);fs.chmodSync(snapshot,0o555);

 verifySnapshot(snapshot);restoreSnapshot(snapshot,path.join(root,'restore'),{version:1,users:[]});assert.deepEqual(fs.readdirSync(snapshot),before);fs.chmodSync(snapshot,0o755);fs.chmodSync(path.join(snapshot,'blobs'),0o755);
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
