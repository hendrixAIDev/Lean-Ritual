'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),vm=require('node:vm');
const {spawnSync}=require('node:child_process');
const {shared,exclusive,provablyDead}=require('../lib/data-access');
const linux=fs.existsSync('/proc/self/ns/pid')&&fs.existsSync('/proc/sys/kernel/random/boot_id');
function dataDir(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ritual-lease-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
// A child process takes a lease and dies without releasing it (like SIGKILL/OOM).
function crashHolding(dir,kind){
 const r=spawnSync(process.execPath,['-e',`require(${JSON.stringify(path.join(__dirname,'../lib/data-access'))}).${kind}(${JSON.stringify(dir)});process.kill(process.pid,'SIGKILL')`],{encoding:'utf8',timeout:5000});
 assert.equal(r.signal,'SIGKILL',r.stderr);
}

test('a reader lease left by a crashed app no longer blocks backups',{skip:!linux},t=>{
 const dir=dataDir(t);crashHolding(dir,'shared');
 assert.equal(fs.readdirSync(path.join(dir,'.access/readers')).length,1);
 const release=exclusive(dir);release();
 assert.equal(fs.readdirSync(path.join(dir,'.access/readers')).length,0);
});

test('a maintenance lock left by a crashed backup no longer blocks app start',{skip:!linux},t=>{
 const dir=dataDir(t);crashHolding(dir,'exclusive');
 assert.ok(fs.existsSync(path.join(dir,'.access/writer')));
 shared(dir)();exclusive(dir)();
});

test('leases that cannot be proven dead still fail closed',t=>{
 const dir=dataDir(t),readers=path.join(dir,'.access/readers');
 const live=shared(dir);assert.throws(()=>exclusive(dir),/Stop the server/);live();
 // Older lease format (no boot/namespace evidence), another host, a live process.
 fs.writeFileSync(path.join(readers,'old'),JSON.stringify({pid:999999,started:'2026-01-01T00:00:00Z'}));
 assert.throws(()=>exclusive(dir),/Stop the server/);fs.rmSync(path.join(readers,'old'));
 fs.writeFileSync(path.join(readers,'remote'),JSON.stringify({pid:999999,host:'another-host',bootId:'x',pidNs:'y',start:'1'}));
 assert.throws(()=>exclusive(dir),/Stop the server/);fs.rmSync(path.join(readers,'remote'));
 assert.equal(provablyDead(null),false);
 // An empty writer directory (older format or unknown owner) keeps blocking writers.
 fs.mkdirSync(path.join(dir,'.access/writer'));
 assert.throws(()=>shared(dir),/maintenance/);
});

test('shim retries safe requests through a restart but never repeats POSTs',async()=>{
 const shim=fs.readFileSync(path.join(__dirname,'../public/shim.js'),'utf8');
 let calls=[],plan=[];
 const fetch=async(url,options)=>{calls.push(options.method);const next=plan.shift();
  if(next==='down')throw new TypeError('fetch failed');
  if(next===502)return {ok:false,status:502,json:async()=>{throw new Error('no body');}};
  return {ok:true,status:200,json:async()=>url==='/api/me'?{id:'alice',ai:false}:{exists:true,data:{a:1},ok:true}};};
 const ctx=vm.createContext({window:{},location:{},URLSearchParams,fetch,setTimeout:f=>{f();return 0;},clearTimeout(){}});
 vm.runInContext(shim,ctx);
 const db=await ctx.window.ritual.use('db');
 calls=[];plan=['down',502,'ok'];
 assert.equal((await db.doc('data/users/alice/app/days/x').get()).data().a,1);
 assert.deepEqual(calls,['GET','GET','GET']);
 calls=[];plan=['down','ok'];
 await db.doc('data/users/alice/app/days/x').update({b:2});
 assert.deepEqual(calls,['PATCH','PATCH']);
 calls=[];plan=['down'];
 await assert.rejects(ctx.window.ritual.use('assets').then(a=>a.upload({type:'image/png'})),e=>e.code==='network');
 assert.deepEqual(calls,['POST']);
 calls=[];plan=Array(10).fill(502);
 await assert.rejects(db.doc('data/users/alice/app/days/x').get(),e=>e.code==='http_502');
 assert.equal(calls.length,6);
});
