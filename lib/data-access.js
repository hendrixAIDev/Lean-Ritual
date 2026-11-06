'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
// Cooperative reader/writer leases across app processes. Every supported writer
// holds a reader lease; maintenance needs an exclusive lease and therefore downtime.
// Crash leftovers deliberately fail closed. Never infer liveness across containers.
function paths(dataDir){
 fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
 const root=path.join(fs.realpathSync(dataDir),'.access');
 for(const dir of [root,path.join(root,'readers')]){
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.lstatSync(dir).isSymbolicLink())throw new Error('Data lock directories must not be symlinks');
 }
 return {root,readers:path.join(root,'readers'),writer:path.join(root,'writer')};
}
function shared(dataDir){
 const p=paths(dataDir),file=path.join(p.readers,crypto.randomUUID());
 fs.writeFileSync(file,JSON.stringify({pid:process.pid,started:new Date().toISOString()}),{flag:'wx',mode:0o600});
 if(fs.existsSync(p.writer)){fs.rmSync(file);throw new Error('Data maintenance in progress; retry after it finishes');}
 let released=false;return ()=>{if(!released){released=true;fs.rmSync(file,{force:true});}};
}
function exclusive(dataDir){
 const p=paths(dataDir);
 try{fs.mkdirSync(p.writer,{mode:0o700});}catch(e){if(e.code==='EEXIST')throw new Error('Another data maintenance operation holds the lock');throw e;}
 if(fs.readdirSync(p.readers).length){fs.rmdirSync(p.writer);throw new Error('Stop the server and all data-writing admin commands before maintenance (reader leases exist)');}
 let released=false;return ()=>{if(!released){released=true;fs.rmdirSync(p.writer);}};
}
module.exports={shared,exclusive};
