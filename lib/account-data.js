'use strict';
const fs=require('node:fs'),path=require('node:path');
function createAccountData(db,dataDir){
 db.exec('CREATE TABLE IF NOT EXISTS deletion_jobs(uid TEXT PRIMARY KEY,requested TEXT NOT NULL,completed TEXT,photos TEXT NOT NULL)');
 function ensureActive(uid){if(db.prepare('SELECT 1 FROM deletion_jobs WHERE uid=?').get(uid))throw Object.assign(new Error('账号删除处理中，不能再写入或读取记录'),{status:423,code:'account_deleting'});}
 function requestDeletion(user){
  const photos=db.prepare('SELECT id FROM blobs WHERE uid=?').all(user.id).map(r=>r.id);
  db.prepare('INSERT OR IGNORE INTO deletion_jobs(uid,requested,photos) VALUES(?,?,?)').run(user.id,new Date().toISOString(),JSON.stringify(photos));
 }
 function completeDeletion(uid){
  const job=db.prepare('SELECT * FROM deletion_jobs WHERE uid=?').get(uid);if(!job||job.completed)return;
  for(const id of JSON.parse(job.photos)){if(!/^[0-9a-f]{32}$/.test(id))throw new Error('Invalid stored photo ID');fs.rmSync(path.join(dataDir,'blobs',id),{force:true});}
  db.exec('BEGIN IMMEDIATE');
  try{
   for(const table of ['docs','blobs','ai_usage','upload_usage'])if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))db.prepare(`DELETE FROM ${table} WHERE uid=?`).run(uid);
   db.prepare('DELETE FROM sessions WHERE uid=?').run(uid);db.prepare('DELETE FROM users WHERE id=?').run(uid);
   // Retain only a random user ID + timestamp to prevent resurrection on restore.
   db.prepare("UPDATE deletion_jobs SET completed=?,photos='[]' WHERE uid=?").run(new Date().toISOString(),uid);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 async function* exportChunks(user){
  ensureActive(user.id);
  yield JSON.stringify({kind:'account',version:1,exportedAt:new Date().toISOString(),user})+'\n';
  for(const row of db.prepare('SELECT path,data,updated FROM docs WHERE uid=? ORDER BY path').iterate(user.id)){
   ensureActive(user.id);yield JSON.stringify({kind:'document',path:row.path,data:JSON.parse(row.data),updated:row.updated})+'\n';
  }
  for(const photo of db.prepare('SELECT id,type,size,created FROM blobs WHERE uid=? ORDER BY id').iterate(user.id)){
   ensureActive(user.id);if(!/^[0-9a-f]{32}$/.test(photo.id))throw new Error('Invalid photo ID');
   yield JSON.stringify({kind:'photo',...photo}).slice(0,-1)+',"dataBase64":"';
   let carry=Buffer.alloc(0);
   for await(const chunk of fs.createReadStream(path.join(dataDir,'blobs',photo.id))){ensureActive(user.id);const bytes=Buffer.concat([carry,chunk]),n=bytes.length-bytes.length%3;yield bytes.subarray(0,n).toString('base64');carry=bytes.subarray(n);}
   if(carry.length)yield carry.toString('base64');yield '"}\n';
  }
 }
 return {ensureActive,requestDeletion,completeDeletion,exportChunks,pending:()=>db.prepare('SELECT uid FROM deletion_jobs WHERE completed IS NULL').all(),ledger:()=>db.prepare('SELECT uid,requested,completed FROM deletion_jobs ORDER BY requested').all()};
}
module.exports={createAccountData};
