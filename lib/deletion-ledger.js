'use strict';
const fs=require('node:fs'),path=require('node:path');const {DatabaseSync}=require('node:sqlite');
const exists=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const hasCol=(db,table,col)=>exists(db,table)&&db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name===col);
function readLedger(dataDir){const db=new DatabaseSync(path.join(dataDir,'bojin.db'),{readOnly:true});try{return {version:1,exportedAt:new Date().toISOString(),users:exists(db,'deletion_jobs')?db.prepare('SELECT uid,requested FROM deletion_jobs').all():[]};}finally{db.close();}}
function validateLedger(ledger){if(ledger?.version!==1||!Array.isArray(ledger.users)||!ledger.users.every(u=>/^u_[A-Za-z0-9_-]+$/.test(u.uid)&&typeof u.requested==='string'))throw new Error('Invalid deletion ledger');return ledger;}
// Only run on an offline restored copy. Replay the latest ledger before serving it.
function applyLedger(dataDir,ledger){validateLedger(ledger);const app=new DatabaseSync(path.join(dataDir,'bojin.db'));let auth;const photos=new Set();
 try{
  if(fs.existsSync(path.join(dataDir,'auth.sqlite')))auth=new DatabaseSync(path.join(dataDir,'auth.sqlite'));
  app.exec('BEGIN IMMEDIATE');auth?.exec('BEGIN IMMEDIATE');
  const inviteHasPhone=auth?hasCol(auth,'launch_invites','phone'):false;
  const userHasPhone=auth?hasCol(auth,'user','phoneNumber'):false;
  for(const {uid,requested} of ledger.users){
   if(exists(app,'blobs'))for(const {id} of app.prepare('SELECT id FROM blobs WHERE uid=?').all(uid)){if(!/^[0-9a-f]{32}$/.test(id))throw new Error('Invalid stored photo ID');photos.add(path.join(dataDir,'blobs',id));}
   for(const table of ['docs','blobs','ai_usage','ai_monthly_usage','ai_user_caps','upload_usage','upload_keys','feedback','feedback_usage','sessions'])if(exists(app,table))app.prepare(`DELETE FROM ${table} WHERE uid=?`).run(uid);
   if(exists(app,'ai_budget_reservations'))app.prepare('UPDATE ai_budget_reservations SET uid=NULL WHERE uid=?').run(uid);
   if(exists(app,'users'))app.prepare('DELETE FROM users WHERE id=?').run(uid);
   app.exec('CREATE TABLE IF NOT EXISTS deletion_jobs(uid TEXT PRIMARY KEY,requested TEXT NOT NULL,completed TEXT,photos TEXT NOT NULL)');
   app.prepare("INSERT OR REPLACE INTO deletion_jobs(uid,requested,completed,photos) VALUES(?,?,?,'[]')").run(uid,requested,new Date().toISOString());
   if(auth){
    for(const table of ['session','account'])if(exists(auth,table))auth.prepare(`DELETE FROM ${table} WHERE userId=?`).run(uid);
    if(exists(auth,'verification'))auth.prepare('DELETE FROM verification WHERE value=?').run(uid);
    if(exists(auth,'launch_invites')){
     if(inviteHasPhone){
      if(userHasPhone){
       auth.prepare("DELETE FROM launch_invites WHERE phone IS NOT NULL AND phone IN (SELECT phoneNumber FROM user WHERE id=? AND phoneNumber IS NOT NULL)").run(uid);
      }
      auth.prepare(`DELETE FROM launch_invites WHERE userId=?
       OR (email != '' AND email IN (SELECT email FROM launch_invites WHERE userId=? AND email != ''))
       OR (phone IS NOT NULL AND phone IN (SELECT phone FROM launch_invites WHERE userId=? AND phone IS NOT NULL))`).run(uid,uid,uid);
     }else{
      auth.prepare("DELETE FROM launch_invites WHERE userId=? OR (email != '' AND email IN (SELECT email FROM launch_invites WHERE userId=? AND email != ''))").run(uid,uid);
     }
    }
    if(exists(auth,'user'))auth.prepare('DELETE FROM user WHERE id=?').run(uid);
   }
  }
  auth?.exec('COMMIT');app.exec('COMMIT');
  for(const photo of photos)fs.rmSync(photo,{force:true});
 }catch(error){for(const db of [auth,app])if(db?.isTransaction){try{db.exec('ROLLBACK');}catch{/* Preserve the original replay error. */}}throw error;}finally{auth?.close();app.close();}
}
module.exports={readLedger,validateLedger,applyLedger};
