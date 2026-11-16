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
