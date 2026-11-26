'use strict';
const fs=require('node:fs'),path=require('node:path');
const {nanosToUsd,roundUsd}=require('./ai-pricing');
function hasTable(db,name){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);}
function hasCols(db,table,cols){if(!hasTable(db,table))return false;const present=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));return cols.every(c=>present.has(c));}
function createAccountData(db,dataDir){
 db.exec('CREATE TABLE IF NOT EXISTS deletion_jobs(uid TEXT PRIMARY KEY,requested TEXT NOT NULL,completed TEXT,photos TEXT NOT NULL)');
 const activeExports=new Map();
 function isExporting(uid){return (activeExports.get(uid)||0)>0;}
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
   for(const table of ['docs','blobs','ai_usage','ai_monthly_usage','ai_user_caps','upload_usage','upload_keys','feedback','feedback_usage'])if(hasTable(db,table))db.prepare(`DELETE FROM ${table} WHERE uid=?`).run(uid);
   // Anonymize any in-flight AI budget reservations instead of deleting them so global spend exposure
   // stays locked until the upstream provider call settles or expires, with zero personal ID retained.
   if(hasTable(db,'ai_budget_reservations'))db.prepare('UPDATE ai_budget_reservations SET uid=NULL WHERE uid=?').run(uid);
   db.prepare('DELETE FROM sessions WHERE uid=?').run(uid);db.prepare('DELETE FROM users WHERE id=?').run(uid);
   // Retain only a random user ID + timestamp to prevent resurrection on restore.
   db.prepare("UPDATE deletion_jobs SET completed=?,photos='[]' WHERE uid=?").run(new Date().toISOString(),uid);db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 async function* exportChunks(user){
  ensureActive(user.id);
  activeExports.set(user.id,(activeExports.get(user.id)||0)+1);
  try{
   yield JSON.stringify({kind:'account',version:1,exportedAt:new Date().toISOString(),user})+'\n';
   for(const row of db.prepare('SELECT path,data,updated FROM docs WHERE uid=? ORDER BY path').iterate(user.id)){
    ensureActive(user.id);yield JSON.stringify({kind:'document',path:row.path,data:JSON.parse(row.data),updated:row.updated})+'\n';
   }
   if(hasTable(db,'feedback')){
    for(const row of db.prepare('SELECT id,type,message,screenshot_blob_id,device_info,created FROM feedback WHERE uid=? ORDER BY created,id').iterate(user.id)){
     ensureActive(user.id);yield JSON.stringify({kind:'feedback',id:row.id,type:row.type,message:row.message,screenshotBlobId:row.screenshot_blob_id||null,deviceInfo:row.device_info?JSON.parse(row.device_info):null,created:row.created})+'\n';
    }
   }
   if(hasCols(db,'ai_usage',['uid','day','n'])){
    for(const row of db.prepare('SELECT day,n FROM ai_usage WHERE uid=? ORDER BY day').iterate(user.id)){
     ensureActive(user.id);yield JSON.stringify({kind:'ai_usage',day:row.day,calls:row.n})+'\n';
    }
   }
   if(hasTable(db,'ai_monthly_usage')){
    for(const row of db.prepare('SELECT month,calls,prompt_tokens,completion_tokens,reasoning_tokens,cost_nanos,updated FROM ai_monthly_usage WHERE uid=? ORDER BY month').iterate(user.id)){
     ensureActive(user.id);yield JSON.stringify({kind:'ai_monthly_usage',month:row.month,calls:row.calls,promptTokens:row.prompt_tokens,completionTokens:row.completion_tokens,reasoningTokens:row.reasoning_tokens,estimatedCostUsd:roundUsd(nanosToUsd(row.cost_nanos)),updated:row.updated})+'\n';
    }
   }
   if(hasTable(db,'ai_user_caps')){
    const cap=db.prepare('SELECT monthly_usd_nanos,updated FROM ai_user_caps WHERE uid=?').get(user.id);
    if(cap){ensureActive(user.id);yield JSON.stringify({kind:'ai_cap',monthlyUsd:roundUsd(nanosToUsd(cap.monthly_usd_nanos)),updated:cap.updated})+'\n';}
   }
   if(hasCols(db,'ai_budget_reservations',['id','uid','month','reserved_nanos','expires_at'])){
    const hasCreated=hasCols(db,'ai_budget_reservations',['created_at']);
    const sql=hasCreated
     ?'SELECT id,month,reserved_nanos,created_at,expires_at FROM ai_budget_reservations WHERE uid=? ORDER BY created_at,id'
     :'SELECT id,month,reserved_nanos,0 AS created_at,expires_at FROM ai_budget_reservations WHERE uid=? ORDER BY id';
    for(const row of db.prepare(sql).iterate(user.id)){
     ensureActive(user.id);
     yield JSON.stringify({kind:'ai_budget_reservation',id:row.id,month:row.month,reservedUsd:roundUsd(nanosToUsd(row.reserved_nanos)),createdAt:row.created_at?new Date(row.created_at).toISOString():null,expiresAt:new Date(row.expires_at).toISOString()})+'\n';
    }
   }
   for(const photo of db.prepare('SELECT id,type,size,created FROM blobs WHERE uid=? ORDER BY id').iterate(user.id)){
    ensureActive(user.id);if(!/^[0-9a-f]{32}$/.test(photo.id))throw new Error('Invalid photo ID');
    yield JSON.stringify({kind:'photo',...photo}).slice(0,-1)+',"dataBase64":"';
    let carry=Buffer.alloc(0);
    for await(const chunk of fs.createReadStream(path.join(dataDir,'blobs',photo.id))){ensureActive(user.id);const bytes=Buffer.concat([carry,chunk]),n=bytes.length-bytes.length%3;yield bytes.subarray(0,n).toString('base64');carry=bytes.subarray(n);}
    if(carry.length)yield carry.toString('base64');yield '"}\n';
   }
  }finally{
   const n=(activeExports.get(user.id)||0)-1;
   if(n>0)activeExports.set(user.id,n);else activeExports.delete(user.id);
  }
 }
 return {ensureActive,isExporting,requestDeletion,completeDeletion,exportChunks,pending:()=>db.prepare('SELECT uid FROM deletion_jobs WHERE completed IS NULL').all(),ledger:()=>db.prepare('SELECT uid,requested,completed FROM deletion_jobs ORDER BY requested').all()};
}
module.exports={createAccountData};
