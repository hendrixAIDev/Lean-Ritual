'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync,backup}=require('node:sqlite');
const {exclusive}=require('./data-access');
const databaseNames=['bojin.db','auth.sqlite'];
function digest(file){const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024),fd=fs.openSync(file,'r');try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,n));return hash.digest('hex');}finally{fs.closeSync(fd);}}
const validFile=name=>databaseNames.includes(name)||/^blobs\/[0-9a-f]{32}$/.test(name);
function regular(file){if(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink())throw new Error('Snapshot files must be regular files');}
function checkDatabase(file){const db=new DatabaseSync(file,{readOnly:true});try{if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Database integrity check failed');}finally{db.close();}}
function verifySnapshot(directory){
 if(fs.lstatSync(path.join(directory,'blobs')).isSymbolicLink())throw new Error('Snapshot photo directory must not be a symlink');
 regular(path.join(directory,'manifest.json'));
 const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
 if(manifest.version!==1||!Array.isArray(manifest.files))throw new Error('Unsupported snapshot manifest');
 const names=new Set();
 for(const item of manifest.files){
  if(!validFile(item.name)||names.has(item.name))throw new Error('Unsafe or duplicate snapshot path');names.add(item.name);
  const file=path.join(directory,item.name);regular(file);
  if(fs.statSync(file).size!==item.size||digest(file)!==item.sha256)throw new Error('Snapshot checksum mismatch: '+item.name);
 }
 if(!names.has('bojin.db'))throw new Error('Snapshot has no application database');
 for(const name of databaseNames)if(names.has(name))checkDatabase(path.join(directory,name));
 const db=new DatabaseSync(path.join(directory,'bojin.db'),{readOnly:true});
 try{for(const blob of db.prepare('SELECT id,size FROM blobs').iterate()){
   if(!/^[0-9a-f]{32}$/.test(blob.id)||!names.has('blobs/'+blob.id)||fs.statSync(path.join(directory,'blobs',blob.id)).size!==blob.size)throw new Error('Snapshot is missing a referenced photo');
 }}finally{db.close();}
 return manifest;
}
async function createSnapshot(dataDir,target){
 dataDir=fs.realpathSync(dataDir);target=path.resolve(target);
 // Resolve existing ancestors before checking containment, including symlink aliases.
 let ancestor=path.dirname(target);const suffix=[path.basename(target)];
 while(!fs.existsSync(ancestor)){suffix.unshift(path.basename(ancestor));ancestor=path.dirname(ancestor);}
 target=path.join(fs.realpathSync(ancestor),...suffix);
 if(target===dataDir||target.startsWith(dataDir+path.sep))throw new Error('Backup must be outside DATA_DIR');
 const release=exclusive(dataDir);let temporary;
 try{
  if(fs.existsSync(target))throw new Error('Backup destination already exists');
  fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
  temporary=fs.mkdtempSync(path.join(path.dirname(target),'.snapshot-'));fs.mkdirSync(path.join(temporary,'blobs'),{mode:0o700});
  for(const name of databaseNames){
   const source=path.join(dataDir,name);if(!fs.existsSync(source)){if(name==='auth.sqlite')continue;throw new Error('Missing application database');}
   regular(source);const db=new DatabaseSync(source,{readOnly:true});try{await backup(db,path.join(temporary,name));}finally{db.close();}fs.chmodSync(path.join(temporary,name),0o600);
  }
  const db=new DatabaseSync(path.join(temporary,'bojin.db'),{readOnly:true});
  try{for(const row of db.prepare('SELECT id FROM blobs').iterate()){
   if(!/^[0-9a-f]{32}$/.test(row.id))throw new Error('Invalid photo ID');
   const source=path.join(dataDir,'blobs',row.id);regular(source);fs.copyFileSync(source,path.join(temporary,'blobs',row.id));fs.chmodSync(path.join(temporary,'blobs',row.id),0o600);
  }}finally{db.close();}
  const files=[...databaseNames.filter(n=>fs.existsSync(path.join(temporary,n))),...fs.readdirSync(path.join(temporary,'blobs')).map(n=>'blobs/'+n)].map(name=>({name,size:fs.statSync(path.join(temporary,name)).size,sha256:digest(path.join(temporary,name))}));
  fs.writeFileSync(path.join(temporary,'manifest.json'),JSON.stringify({version:1,created:new Date().toISOString(),files},null,2),{mode:0o600});
  verifySnapshot(temporary);fs.renameSync(temporary,target);temporary=null;
 }finally{if(temporary)fs.rmSync(temporary,{recursive:true,force:true});release();}
}
function restoreSnapshot(snapshot,target,ledger){
 const {validateLedger,applyLedger}=require('./deletion-ledger');validateLedger(ledger);
 const manifest=verifySnapshot(snapshot);target=path.resolve(target);
 const release=exclusive(target),created=[];
 try{
  if(fs.readdirSync(target).some(n=>n!=='.access'))throw new Error('Restore requires an empty destination; never overwrite live data');
  fs.mkdirSync(path.join(target,'blobs'),{mode:0o700});created.push(path.join(target,'blobs'));
  for(const file of manifest.files){const destination=path.join(target,file.name);fs.copyFileSync(path.join(snapshot,file.name),destination,fs.constants.COPYFILE_EXCL);fs.chmodSync(destination,0o600);if(!file.name.startsWith('blobs/'))created.push(destination);}
  applyLedger(target,ledger);
 }catch(e){for(const file of created)fs.rmSync(file,{recursive:true,force:true});throw e;}finally{release();}
}
module.exports={createSnapshot,verifySnapshot,restoreSnapshot};
