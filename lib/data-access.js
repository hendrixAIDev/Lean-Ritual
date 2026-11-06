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
 for(const name of fs.readdirSync(p.readers)){const file=path.join(p.readers,name);if(provablyDead(readOwner(file))){fs.rmSync(file,{force:true});removed++;}}
 return removed;
}
function reapWriter(p){
 const owner=path.join(p.writer,'owner.json');
 if(!fs.existsSync(p.writer)||!provablyDead(readOwner(owner)))return false;
 fs.rmSync(owner,{force:true});
 try{fs.rmdirSync(p.writer);}catch(e){if(e.code!=='ENOENT')throw e;}
 return true;
}
function shared(dataDir){
 const p=paths(dataDir),file=path.join(p.readers,crypto.randomUUID());
 if(reapWriter(p))console.error('Removed a maintenance lock left by a crashed process');
 fs.writeFileSync(file,JSON.stringify(identity()),{flag:'wx',mode:0o600});
 if(fs.existsSync(p.writer)){fs.rmSync(file);throw new Error('Data maintenance in progress; retry after it finishes');}
 let released=false;return ()=>{if(!released){released=true;fs.rmSync(file,{force:true});}};
}
function exclusive(dataDir){
 const p=paths(dataDir);
 reapWriter(p);
 try{fs.mkdirSync(p.writer,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new Error('Another data maintenance operation holds the lock');throw e;}
 const owner=path.join(p.writer,'owner.json');
 try{fs.writeFileSync(owner,JSON.stringify(identity()),{flag:'wx',mode:0o600});}catch(e){fs.rmdirSync(p.writer);throw e;}
 const removed=reapReaders(p);
 if(removed)console.error(`Removed ${removed} data lease(s) left by crashed processes`);
 const release=()=>{fs.rmSync(owner,{force:true});fs.rmdirSync(p.writer);};
 if(fs.readdirSync(p.readers).length){release();throw new Error('Stop the server and all data-writing admin commands before maintenance (reader leases exist)');}
 let released=false;return ()=>{if(!released){released=true;release();}};
}
module.exports={shared,exclusive,provablyDead};
