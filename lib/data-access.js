'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),os=require('node:os');
// Cooperative reader/writer leases across app processes. Every supported writer
// holds a reader lease; maintenance needs an exclusive lease and therefore downtime.
// Crash leftovers fail closed unless they provably belong to a dead process on
// THIS kernel: same hostname plus an older boot, or same boot and PID namespace
// with that PID gone/reused. Leases without that evidence (older format, other
// containers or hosts) are never removed automatically.
function paths(dataDir){
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 const root=path.join(fs.realpathSync(dataDir),'.access');
 for(const dir of [root,path.join(root,'readers')]){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.lstatSync(dir).isSymbolicLink())throw new Error('Data lock directories must not be symlinks');
 }
 return {root,readers:path.join(root,'readers'),writer:path.join(root,'writer')};
}
const readText=file=>{try{return fs.readFileSync(file,'utf8').trim();}catch{return null;}};
// Field 22 of /proc/<pid>/stat is the start time; it distinguishes PID reuse.
function startTicks(pid){const stat=readText(`/proc/${pid}/stat`);if(!stat)return null;const fields=stat.slice(stat.lastIndexOf(')')+2).split(' ');return fields[19]||null;}
function pidNamespace(){try{return fs.readlinkSync('/proc/self/ns/pid');}catch{return null;}}
function identity(){
 const bootId=readText('/proc/sys/kernel/random/boot_id'),pidNs=pidNamespace(),start=startTicks(process.pid);
 return {pid:process.pid,started:new Date().toISOString(),host:os.hostname(),...(bootId&&pidNs&&start?{bootId,pidNs,start}:{})};
}
function provablyDead(owner){
 if(!owner||typeof owner!=='object'||!Number.isSafeInteger(owner.pid)||!owner.bootId||!owner.pidNs||!owner.start)return false;
 const me=identity();
 if(!me.bootId||owner.host!==me.host)return false;
 if(owner.bootId!==me.bootId)return true;               // the kernel rebooted since; every process of that boot is gone
 if(owner.pidNs!==me.pidNs)return false;                // another container: cannot see its processes
 const current=startTicks(owner.pid);
 return current===null||current!==owner.start;          // PID gone, or reused by an unrelated process
}
// Malformed metadata is never published by supported live holders. Age recovery
// applies only after a successful read; IO failures must always fail closed.
function reapable(file){
 let raw;
 try{raw=fs.readFileSync(file,'utf8');}catch{return false;}
 let owner=null;
 try{owner=JSON.parse(raw);}catch{}
 if(owner!==null)return provablyDead(owner);
 try{return Date.now()-fs.statSync(file).mtimeMs>600000;}catch{return false;}
}
function syncDir(dir){
 let fd;
 try{fd=fs.openSync(dir,'r');fs.fsyncSync(fd);}catch(e){if(!['EINVAL','ENOTSUP','EISDIR'].includes(e.code))throw e;}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}
function publish(file){
 let fd;
 try{fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(identity()));fs.fsyncSync(fd);}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}
function sweepStaging(p){
 for(const name of fs.readdirSync(p.root)){
  if(!/^\.(reader|writer|release)-/.test(name))continue;
  const entry=path.join(p.root,name);
  try{if(Date.now()-Math.max(fs.statSync(entry).mtimeMs,fs.statSync(entry).ctimeMs)>600000)fs.rmSync(entry,{recursive:true,force:true});}catch{}
 }
}
// Returns the number of crash leftovers removed, so callers can log it.
function reapReaders(p){
 let removed=0;
 for(const name of fs.readdirSync(p.readers)){const file=path.join(p.readers,name);if(reapable(file)){fs.rmSync(file,{force:true});removed++;}}
 return removed;
}
function reapWriter(p){
 sweepStaging(p);
 let names;
 try{names=fs.readdirSync(p.writer);}catch(e){if(e.code==='ENOENT')return false;throw e;}
 if(!names.length){
  try{if(Date.now()-fs.statSync(p.writer).mtimeMs<=600000)return false;}catch{return false;}
  try{fs.rmdirSync(p.writer);return true;}catch(e){if(['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code))return false;throw e;}
 }
 for(const name of names)if(!reapable(path.join(p.writer,name)))return false;
 for(const name of names)fs.rmSync(path.join(p.writer,name),{force:true});
 try{fs.rmdirSync(p.writer);return true;}catch(e){if(['ENOENT','ENOTEMPTY','EEXIST'].includes(e.code))return false;throw e;}
}
function shared(dataDir){
 const p=paths(dataDir),id=crypto.randomUUID(),file=path.join(p.readers,id);
 if(reapWriter(p))console.error('Removed a maintenance lock left by a crashed process');
 if(fs.existsSync(p.writer))throw new Error('Data maintenance in progress; retry after it finishes');
 const temp=path.join(p.root,'.reader-'+id);
 try{publish(temp);syncDir(p.root);fs.renameSync(temp,file);syncDir(p.readers);syncDir(p.root);}catch(e){fs.rmSync(file,{force:true});throw e;}finally{fs.rmSync(temp,{force:true});}
 if(fs.existsSync(p.writer)){fs.rmSync(file,{force:true});throw new Error('Data maintenance in progress; retry after it finishes');}
 let released=false;return ()=>{if(!released){released=true;fs.rmSync(file,{force:true});}};
}
function exclusive(dataDir){
 const p=paths(dataDir),id=crypto.randomUUID(),temp=path.join(p.root,'.writer-'+id);
 reapWriter(p);
 let published=false;
 try{
  if(fs.existsSync(p.writer))throw Object.assign(new Error('exists'),{code:'EEXIST'});
  fs.mkdirSync(temp,{mode:0o700});publish(path.join(temp,id+'.json'));syncDir(temp);
  if(fs.existsSync(p.writer))throw Object.assign(new Error('exists'),{code:'EEXIST'});
  fs.renameSync(temp,p.writer);published=true;syncDir(p.root);
 }catch(e){if(published)fs.rmSync(p.writer,{recursive:true,force:true});if(['EEXIST','ENOTEMPTY'].includes(e.code))throw new Error('Another data maintenance operation holds the lock');throw e;}
 finally{fs.rmSync(temp,{recursive:true,force:true});}
 const owner=path.join(p.writer,id+'.json');
 const removed=reapReaders(p);
 if(removed)console.error(`Removed ${removed} data lease(s) left by crashed processes`);
 const release=()=>{
  if(!fs.existsSync(owner))return;
  const closing=path.join(p.root,'.release-'+id);
  try{fs.renameSync(p.writer,closing);syncDir(p.root);}catch(e){if(e.code==='ENOENT')return;throw e;}
  finally{try{fs.rmSync(closing,{recursive:true,force:true});}catch{}}
 };
 if(fs.readdirSync(p.readers).length){release();throw new Error('Stop the server and all data-writing admin commands before maintenance (reader leases exist)');}
 let released=false;return ()=>{if(!released){released=true;release();}};
}
module.exports={shared,exclusive,provablyDead};
