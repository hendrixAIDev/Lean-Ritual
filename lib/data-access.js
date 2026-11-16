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
const readOwner=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
// Returns the number of crash leftovers removed, so callers can log it.
function reapReaders(p){
 let removed=0;
 for(const name of fs.readdirSync(p.readers)){const file=path.join(p.readers,name);if(reapable(file)){fs.rmSync(file,{force:true});removed++;}}
 return removed;
}
// Atomic publication means malformed metadata cannot belong to a supported live
// lease. Allow ten minutes for legacy interrupted writes before recovering them.
function reapable(file){
 const owner=readOwner(file);
 if(owner!==null)return provablyDead(owner);
 try{return Date.now()-fs.statSync(file).mtimeMs>600000;}catch(e){return false;}
}
function publish(file){
 let fd;
 try{fd=fs.openSync(file,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(identity()));fs.fsyncSync(fd);}
 finally{if(fd!==undefined)fs.closeSync(fd);}
}
function reapWriter(p){
 const owner=path.join(p.writer,'owner.json');
 if(!reapable(owner))return false;
 let before;
 try{before=fs.statSync(p.writer);}catch{return false;}
 const moved=path.join(p.root,'.reap-'+crypto.randomUUID());
 try{fs.renameSync(p.writer,moved);}catch(e){if(e.code==='ENOENT')return false;throw e;}
 const after=fs.statSync(moved);
 if(before.ino!==after.ino||before.dev!==after.dev||!reapable(path.join(moved,'owner.json'))){
  // A competing reaper replaced the directory. Restore only if the name is free.
  try{fs.renameSync(moved,p.writer);}catch{}
  return false;
 }
 fs.rmSync(moved,{recursive:true,force:true});return true;
}
function shared(dataDir){
 const p=paths(dataDir),file=path.join(p.readers,crypto.randomUUID());
 if(reapWriter(p))console.error('Removed a maintenance lock left by a crashed process');
 if(fs.existsSync(p.writer))throw new Error('Data maintenance in progress; retry after it finishes');
 const temp=path.join(p.root,'.reader-'+crypto.randomUUID());
 try{publish(temp);fs.renameSync(temp,file);}finally{fs.rmSync(temp,{force:true});}
 if(fs.existsSync(p.writer)){fs.rmSync(file);throw new Error('Data maintenance in progress; retry after it finishes');}
 let released=false;return ()=>{if(!released){released=true;fs.rmSync(file,{force:true});}};
}
function exclusive(dataDir){
 const p=paths(dataDir);
 reapWriter(p);
 const temp=path.join(p.root,'.writer-'+crypto.randomUUID());
 try{
  fs.mkdirSync(temp,{mode:0o700});publish(path.join(temp,'owner.json'));
  fs.renameSync(temp,p.writer);
 }catch(e){if(['EEXIST','ENOTEMPTY'].includes(e.code))throw new Error('Another data maintenance operation holds the lock');throw e;}
 finally{fs.rmSync(temp,{recursive:true,force:true});}
 const owner=path.join(p.writer,'owner.json');
 const removed=reapReaders(p);
 if(removed)console.error(`Removed ${removed} data lease(s) left by crashed processes`);
 const release=()=>{fs.rmSync(owner,{force:true});fs.rmdirSync(p.writer);};
 if(fs.readdirSync(p.readers).length){release();throw new Error('Stop the server and all data-writing admin commands before maintenance (reader leases exist)');}
 let released=false;return ()=>{if(!released){released=true;release();}};
}
module.exports={shared,exclusive,provablyDead};
