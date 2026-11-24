'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
const {DatabaseSync,backup}=require('node:sqlite');
const {exclusive}=require('./data-access');
const databaseNames=['bojin.db','auth.sqlite'];
const blobIdRe=/^[0-9a-f]{32}$/;
const blobPathRe=/^blobs\/[0-9a-f]{32}$/;
const sha256Re=/^[0-9a-f]{64}$/;
function digest(file){const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024),fd=fs.openSync(file,'r');try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,n));return hash.digest('hex');}finally{fs.closeSync(fd);}}
function fsyncFile(file){const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
function fsyncDir(dir){let fd;try{fd=fs.openSync(dir,'r');}catch{return;}try{fs.fsyncSync(fd);}catch(e){if(e.code!=='EINVAL'&&e.code!=='EBADF'&&e.code!=='EROFS')throw e;}finally{fs.closeSync(fd);}}
const validFile=name=>databaseNames.includes(name)||blobPathRe.test(name);
function regular(file){const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw new Error('Snapshot files must be regular files');return st;}
function checkDatabase(file){const db=new DatabaseSync(file,{readOnly:true});try{if(db.prepare('PRAGMA quick_check').get().quick_check!=='ok')throw new Error('Database integrity check failed');}finally{db.close();}}
function verifySnapshot(directory,options){
 // Inspect private copies so legacy WAL headers cannot write into the archive.
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'ritual-verify-'));
 try{return verifySnapshotCopy(directory,temporary,options);}finally{fs.rmSync(temporary,{recursive:true,force:true});}
}
function verifySnapshotCopy(directory,temporary,options){
 const allowDeferred=options&&options.allowDeferred instanceof Set?options.allowDeferred:null;
 if(fs.lstatSync(path.join(directory,'blobs')).isSymbolicLink())throw new Error('Snapshot photo directory must not be a symlink');
 regular(path.join(directory,'manifest.json'));
 const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
 if(manifest.version!==1||!Array.isArray(manifest.files))throw new Error('Unsupported snapshot manifest');
 const names=new Set(),manifestSizes=new Map();
 for(const item of manifest.files){
  if(!validFile(item.name)||names.has(item.name))throw new Error('Unsafe or duplicate snapshot path');names.add(item.name);
  if(!Number.isSafeInteger(item.size)||item.size<0||typeof item.sha256!=='string'||!sha256Re.test(item.sha256))throw new Error('Unsupported snapshot manifest');
  manifestSizes.set(item.name,item.size);
  if(allowDeferred&&blobPathRe.test(item.name)&&allowDeferred.has(item.name)){
   let exists=true;try{fs.lstatSync(path.join(directory,item.name));}catch(e){if(e.code==='ENOENT')exists=false;else throw e;}
   if(exists)throw new Error('Unexpected file for deferred snapshot blob: '+item.name);
   continue;
  }
  let file=path.join(directory,item.name);regular(file);
  if(databaseNames.includes(item.name)){
   if(fs.existsSync(file+'-wal'))throw new Error('Snapshot contains a WAL sidecar');
   const copy=path.join(temporary,item.name);fs.copyFileSync(file,copy);fs.chmodSync(copy,0o600);file=copy;
  }
  if(fs.statSync(file).size!==item.size||digest(file)!==item.sha256)throw new Error('Snapshot checksum mismatch: '+item.name);
 }
 if(!names.has('bojin.db'))throw new Error('Snapshot has no application database');
 for(const name of databaseNames)if(names.has(name))checkDatabase(path.join(temporary,name));
 const db=new DatabaseSync(path.join(temporary,'bojin.db'),{readOnly:true});
 try{for(const blob of db.prepare('SELECT id,size FROM blobs').iterate()){
   const rel='blobs/'+blob.id;
   if(!blobIdRe.test(blob.id)||!names.has(rel))throw new Error('Snapshot is missing a referenced photo');
   const actualSize=allowDeferred&&allowDeferred.has(rel)?manifestSizes.get(rel):fs.statSync(path.join(directory,'blobs',blob.id)).size;
   if(actualSize!==blob.size)throw new Error('Snapshot is missing a referenced photo');
 }}finally{db.close();}
 return manifest;
}
function indexLinkSources(linkFrom,dataDir){
 const index=new Map();
 const rawList=Array.isArray(linkFrom)?linkFrom:(linkFrom?[linkFrom]:[]);
 const seenInodes=new Map();
 for(const raw of rawList){
  if(typeof raw!=='string'||!raw)continue;
  const resolved=path.resolve(raw);
  let dirStat;
  try{dirStat=fs.lstatSync(resolved);}catch{continue;}
  if(!dirStat.isDirectory()||dirStat.isSymbolicLink())continue;
  let realDir;
  try{realDir=fs.realpathSync(resolved);}catch{continue;}
  if(realDir===dataDir||realDir.startsWith(dataDir+path.sep))continue;
  let blobsStat,manifest;
  try{
   blobsStat=fs.lstatSync(path.join(realDir,'blobs'));
   if(!blobsStat.isDirectory()||blobsStat.isSymbolicLink())continue;
   regular(path.join(realDir,'manifest.json'));
   manifest=JSON.parse(fs.readFileSync(path.join(realDir,'manifest.json'),'utf8'));
  }catch{continue;}
  if(!manifest||manifest.version!==1||!Array.isArray(manifest.files))continue;
  for(const item of manifest.files){
   if(!item||!blobPathRe.test(item.name)||!Number.isSafeInteger(item.size)||item.size<0||typeof item.sha256!=='string'||!sha256Re.test(item.sha256))continue;
   const candidate=path.join(realDir,item.name);
   let st;
   try{st=fs.lstatSync(candidate);}catch{continue;}
   if(!st.isFile()||st.isSymbolicLink()||st.size!==item.size||(st.mode&0o077)!==0)continue;
   const inodeKey=`${st.dev}:${st.ino}`;
   let seen=seenInodes.get(item.sha256);
   if(!seen){seen=new Set();seenInodes.set(item.sha256,seen);}
   if(seen.has(inodeKey))continue;
   seen.add(inodeKey);
   let list=index.get(item.sha256);
   if(!list){list=[];index.set(item.sha256,list);}
   list.push({path:candidate,size:st.size,dev:st.dev,ino:st.ino});
  }
 }
 return index;
}
function loadDeferIndex(deferBlobs){
 if(typeof deferBlobs!=='string'||!deferBlobs)throw new Error('Invalid defer-blobs index path');
 regular(deferBlobs);
 const parsed=JSON.parse(fs.readFileSync(deferBlobs,'utf8'));
 if(!parsed||parsed.version!==1||!parsed.sha256||typeof parsed.sha256!=='object'||Array.isArray(parsed.sha256))throw new Error('Unsupported defer-blobs index');
 const map=new Map();
 for(const [hash,size] of Object.entries(parsed.sha256)){
  if(sha256Re.test(hash)&&Number.isSafeInteger(size)&&size>=0)map.set(hash,size);
 }
 return map;
}
async function createSnapshot(dataDir,target,options={}){
 if(options&&options.linkFrom&&options.deferBlobs)throw new Error('Cannot combine linkFrom and deferBlobs');
 dataDir=fs.realpathSync(dataDir);target=path.resolve(target);
 // Resolve existing ancestors before checking containment, including symlink aliases.
 let ancestor=path.dirname(target);const suffix=[path.basename(target)];
 while(!fs.existsSync(ancestor)){suffix.unshift(path.basename(ancestor));ancestor=path.dirname(ancestor);}
 target=path.join(fs.realpathSync(ancestor),...suffix);
 if(target===dataDir||target.startsWith(dataDir+path.sep))throw new Error('Backup must be outside DATA_DIR');
 const linkIndex=options&&options.linkFrom?indexLinkSources(options.linkFrom,dataDir):new Map();
 const deferMap=options&&options.deferBlobs?loadDeferIndex(options.deferBlobs):null;
 const release=exclusive(dataDir);let temporary;
 try{
  if(fs.existsSync(target))throw new Error('Backup destination already exists');
  fs.mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
  temporary=fs.mkdtempSync(path.join(path.dirname(target),'.snapshot-'));fs.mkdirSync(path.join(temporary,'blobs'),{mode:0o700});
  for(const name of databaseNames){
   const source=path.join(dataDir,name);if(!fs.existsSync(source)){if(name==='auth.sqlite')continue;throw new Error('Missing application database');}
   regular(source);const db=new DatabaseSync(source,{readOnly:true});try{await backup(db,path.join(temporary,name));}finally{db.close();}fs.chmodSync(path.join(temporary,name),0o600);
   const copy=new DatabaseSync(path.join(temporary,name));try{copy.exec('PRAGMA journal_mode=DELETE');}finally{copy.close();}
   fsyncFile(path.join(temporary,name));
  }
  const tempBlobsDir=path.join(temporary,'blobs');
  const tempDev=fs.statSync(tempBlobsDir).dev;
  const blobFiles=[],deferredNames=new Set();
  let linkedBlobs=0,copiedBlobs=0;
  const db=new DatabaseSync(path.join(temporary,'bojin.db'),{readOnly:true});
  try{for(const row of db.prepare('SELECT id FROM blobs').iterate()){
   if(!blobIdRe.test(row.id))throw new Error('Invalid photo ID');
   const source=path.join(dataDir,'blobs',row.id);
   const sourceStat=regular(source);
   const sourceSha=digest(source);
   const rel='blobs/'+row.id,dest=path.join(tempBlobsDir,row.id);
   if(deferMap&&deferMap.get(sourceSha)===sourceStat.size){
    deferredNames.add(rel);
    blobFiles.push({name:rel,size:sourceStat.size,sha256:sourceSha});
    continue;
   }
   let linked=false;
   const candidates=linkIndex.get(sourceSha);
   if(candidates){
    for(const cand of candidates){
     if(cand.size!==sourceStat.size||cand.dev!==tempDev)continue;
     if(cand.dev===sourceStat.dev&&cand.ino===sourceStat.ino)continue;
     try{fs.linkSync(cand.path,dest);}catch{continue;}
     let ok=false;
     try{const dstStat=fs.lstatSync(dest);ok=dstStat.isFile()&&!dstStat.isSymbolicLink()&&dstStat.size===sourceStat.size&&digest(dest)===sourceSha;}catch{ok=false;}
     if(ok){linked=true;linkedBlobs++;break;}
     fs.rmSync(dest,{force:true});
    }
   }
   if(!linked){
    fs.copyFileSync(source,dest);fs.chmodSync(dest,0o600);fsyncFile(dest);copiedBlobs++;
   }
   blobFiles.push({name:rel,size:sourceStat.size,sha256:sourceSha});
  }}finally{db.close();}
  blobFiles.sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  const dbFiles=databaseNames.filter(n=>fs.existsSync(path.join(temporary,n))).map(name=>({name,size:fs.statSync(path.join(temporary,name)).size,sha256:digest(path.join(temporary,name))}));
  const files=[...dbFiles,...blobFiles];
  const manifestPath=path.join(temporary,'manifest.json');
  fs.writeFileSync(manifestPath,JSON.stringify({version:1,created:new Date().toISOString(),files},null,2),{mode:0o600});
  fsyncFile(manifestPath);
  verifySnapshot(temporary,deferredNames.size?{allowDeferred:deferredNames}:undefined);
  fsyncDir(tempBlobsDir);
  fsyncDir(temporary);
  fs.renameSync(temporary,target);temporary=null;
  fsyncDir(path.dirname(target));
  return {files:files.length,linkedBlobs,copiedBlobs,deferredBlobs:deferredNames.size};
 }finally{if(temporary)fs.rmSync(temporary,{recursive:true,force:true});release();}
}
function restoreSnapshot(snapshot,target,ledger){
 const {validateLedger,applyLedger}=require('./deletion-ledger');validateLedger(ledger);
 const manifest=verifySnapshot(snapshot);target=path.resolve(target);
 const hadAccess=fs.existsSync(path.join(target,'.access'));
 const release=exclusive(target),created=[];let failed=false;
 try{
  if(fs.readdirSync(target).some(n=>n!=='.access'))throw new Error('Restore requires an empty destination; never overwrite live data');
  fs.mkdirSync(path.join(target,'blobs'),{mode:0o700});created.push(path.join(target,'blobs'));
  for(const file of manifest.files){
   const destination=path.join(target,file.name);created.push(destination);
   try{fs.copyFileSync(path.join(snapshot,file.name),destination,fs.constants.COPYFILE_EXCL);}
   catch(error){if(error.code==='EEXIST')created.pop();throw error;}
   fs.chmodSync(destination,0o600);
  }
  applyLedger(target,ledger);
 }catch(e){failed=true;for(const name of databaseNames)if(created.includes(path.join(target,name)))for(const suffix of ['-wal','-shm','-journal'])fs.rmSync(path.join(target,name+suffix),{force:true});for(const file of created)fs.rmSync(file,{recursive:true,force:true});throw e;}finally{release();if(failed&&!hadAccess)fs.rmSync(path.join(target,'.access'),{recursive:true,force:true});}
}
module.exports={createSnapshot,verifySnapshot,restoreSnapshot};
