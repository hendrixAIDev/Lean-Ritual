'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const leases=require('../lib/data-access');
test('old partial reader and writer metadata self heals',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'leases-'));
 try{
 const release=leases.shared(dir);release();
 const root=path.join(dir,'.access'),reader=path.join(root,'readers','broken'),writer=path.join(root,'writer');
 fs.writeFileSync(reader,'');fs.mkdirSync(writer);fs.writeFileSync(path.join(writer,'owner.json'),'');
 const old=new Date(Date.now()-660000);for(const f of [reader,writer,path.join(writer,'owner.json')])fs.utimesSync(f,old,old);
 const unlock=leases.exclusive(dir);unlock();
 assert.equal(fs.existsSync(reader),false);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('partial write failure leaves no published lease',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'leases-')),original=fs.writeFileSync;
 try{
 fs.writeFileSync=(file,...args)=>{original(file,'');throw Object.assign(new Error('full'),{code:'ENOSPC'});};
 for(const acquire of [leases.shared,leases.exclusive]){
 assert.throws(()=>acquire(dir),{code:'ENOSPC'});
 assert.deepEqual(fs.readdirSync(path.join(dir,'.access')).sort(),['readers']);
 assert.deepEqual(fs.readdirSync(path.join(dir,'.access','readers')),[]);
 }
 }finally{fs.writeFileSync=original;fs.rmSync(dir,{recursive:true,force:true});}
});
test('fresh empty writer blocks both modes; old empty writer heals shared',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'leases-'));
 try{leases.shared(dir)();const w=path.join(dir,'.access','writer');fs.mkdirSync(w);
 assert.throws(()=>leases.shared(dir));assert.throws(()=>leases.exclusive(dir));
 const old=new Date(Date.now()-660000);fs.utimesSync(w,old,old);leases.shared(dir)();
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('read errors on old leases fail closed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'leases-')),read=fs.readFileSync;
 try{const release=leases.shared(dir),root=path.join(dir,'.access','readers'),file=path.join(root,fs.readdirSync(root)[0]);
 const old=new Date(Date.now()-660000);fs.utimesSync(file,old,old);
 fs.readFileSync=(f,...args)=>{if(typeof f==='string'&&path.basename(f)===path.basename(file))throw Object.assign(new Error('fds'),{code:'EMFILE'});return read(f,...args);};
 assert.throws(()=>leases.exclusive(dir));assert.equal(fs.existsSync(file),true);release();
 }finally{fs.readFileSync=read;fs.rmSync(dir,{recursive:true,force:true});}
});
test('fsync ENOSPC leaves no published leases',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'leases-')),sync=fs.fsyncSync;
 try{fs.fsyncSync=()=>{throw Object.assign(new Error('full'),{code:'ENOSPC'});};
 for(const acquire of [leases.shared,leases.exclusive]){assert.throws(()=>acquire(dir),{code:'ENOSPC'});assert.deepEqual(fs.readdirSync(path.join(dir,'.access')),['readers']);}
 }finally{fs.fsyncSync=sync;fs.rmSync(dir,{recursive:true,force:true});}
});
test('fresh partial metadata fails closed',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'leases-'));
 try{leases.shared(dir)();const w=path.join(dir,'.access','writer');fs.mkdirSync(w);fs.writeFileSync(path.join(w,'owner.json'),'{');
 assert.throws(()=>leases.shared(dir));assert.throws(()=>leases.exclusive(dir));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('delayed stale reaper cannot hide or delete a replacement live writer',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'leases-')),rm=fs.rmSync;let unlock,intercept=false;
 try{leases.shared(dir)();const w=path.join(dir,'.access','writer'),oldFile=path.join(w,'old.json');fs.mkdirSync(w);fs.writeFileSync(oldFile,'');
 const old=new Date(Date.now()-660000);fs.utimesSync(oldFile,old,old);
 fs.rmSync=(file,...args)=>{
 if(path.basename(file)==='old.json'&&!intercept){intercept=true;rm(oldFile);fs.rmdirSync(w);unlock=leases.exclusive(dir);assert.throws(()=>leases.shared(dir));}
 return rm(file,...args);
 };
 assert.throws(()=>leases.shared(dir));assert.ok(unlock);assert.equal(fs.readdirSync(w).length,1);unlock();
 leases.shared(dir)();
 }finally{fs.rmSync=rm;fs.rmSync(dir,{recursive:true,force:true});}
});
test('shutdown preserves graceful and fatal codes and closes both databases',()=>{
 const vm=require('node:vm'),source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 const snippet=source.slice(source.indexOf('  let stopping = false'),source.indexOf('  for (const signal'));
 for(const forced of [false,true])for(const fatal of [false,true]){
 const calls=[];let drained,timed;
 const context={authentication:{close(){calls.push('auth');throw new Error('close');}},db:{close(){calls.push('db');}},server:{close(fn){drained=fn;},closeIdleConnections(){},closeAllConnections(){calls.push('connections');}},process:{exit(code){calls.push(code);}},setTimeout(fn){timed=fn;return {unref(){}};}};
 vm.runInNewContext(snippet+';globalThis.stop=shutdown;',context);
 context.stop(0);if(fatal)context.stop(1);(forced?timed:drained)();
 assert.deepEqual(calls,forced?['connections','auth','db',fatal?1:0]:['auth','db',fatal?1:0]);
 }
});
test('old staging entries are swept, fresh entries retained',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'leases-')),now=Date.now;
 try{leases.shared(dir)();const root=path.join(dir,'.access');
 for(const prefix of ['reader','writer','release']){const entry=path.join(root,'.'+prefix+'-old');fs.mkdirSync(entry);}
 Date.now=()=>now()+660000;leases.shared(dir)();Date.now=now;
 for(const prefix of ['reader','writer','release'])assert.equal(fs.existsSync(path.join(root,'.'+prefix+'-old')),false);
 const fresh=path.join(root,'.reader-fresh');fs.writeFileSync(fresh,'');leases.shared(dir)();assert.ok(fs.existsSync(fresh));
 }finally{Date.now=now;fs.rmSync(dir,{recursive:true,force:true});}
});
