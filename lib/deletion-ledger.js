'use strict';
const fs=require('node:fs'),path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const exists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
function readLedger(dataDir){const db=new DatabaseSync(path.join(dataDir,'bojin.db'),{readOnly:true});try{return {version:1,exportedAt:new Date().toISOString(),users:exists(db,'deletion_jobs')?db.prepare('SELECT uid,requested FROM deletion_jobs').all():[]};}finally{db.close();}}
function validateLedger(ledger){if(ledger?.version!==1||!Array.isArray(ledger.users)||!ledger.users.every(u=>/^u_[A-Za-z0-9_-]+$/.test(u.uid)&&typeof u.requested==='string'))throw new Error('Invalid deletion ledger');return ledger;}
// Only run on an offline restored copy. Replay the latest ledger before serving it.
function applyLedger(dataDir,ledger){validateLedger(ledger);const app=new DatabaseSync(path.join(dataDir,'bojin.db'));let auth;
 try{
  if(fs.existsSync(path.join(dataDir,'auth.sqlite')))auth=new DatabaseSync(path.join(dataDir,'auth.sqlite'));
  for(const {uid,requested} of ledger.users){
   if(exists(app,'blobs'))for(const {id} of app.prepare('SELECT id FROM blobs WHERE uid=?').all(uid)){if(!/^[0-9a-f]{32}$/.test(id))throw new Error('Invalid stored photo ID');fs.rmSync(path.join(dataDir,'blobs',id),{force:true});}
   for(const table of ['docs','blobs','ai_usage','upload_usage','sessions'])if(exists(app,table))app.prepare(`DELETE FROM ${table} WHERE uid=?`).run(uid);
   if(exists(app,'users'))app.prepare('DELETE FROM users WHERE id=?').run(uid);
   app.exec('CREATE TABLE IF NOT EXISTS deletion_jobs(uid TEXT PRIMARY KEY,requested TEXT NOT NULL,completed TEXT,photos TEXT NOT NULL)');
   app.prepare("INSERT OR REPLACE INTO deletion_jobs(uid,requested,completed,photos) VALUES(?,?,?,'[]')").run(uid,requested,new Date().toISOString());
   if(auth){
    for(const table of ['session','account'])if(exists(auth,table))auth.prepare(`DELETE FROM ${table} WHERE userId=?`).run(uid);
    if(exists(auth,'verification'))auth.prepare('DELETE FROM verification WHERE value=?').run(uid);
    if(exists(auth,'launch_invites'))auth.prepare('DELETE FROM launch_invites WHERE userId=?').run(uid);
    if(exists(auth,'user'))auth.prepare('DELETE FROM user WHERE id=?').run(uid);
   }
  }
 }finally{auth?.close();app.close();}
}
module.exports={readLedger,validateLedger,applyLedger};
