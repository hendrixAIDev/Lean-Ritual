'use strict';
const fail=(status,code,message)=>Object.assign(new Error(message),{status,code});
function createDocQuota(db,{userBytes=50*1024*1024,userCount=20000,writePerMin=240}={}){
 for(const n of [userBytes,userCount,writePerMin])if(!Number.isSafeInteger(n)||n<1)throw new Error('Document quotas must be positive integers');
 db.exec('CREATE INDEX IF NOT EXISTS docs_uid ON docs(uid)');
 const windows=new Map();
 function throttle(uid,res){
  const now=Date.now();
  for(const [key,value] of windows)if(now>=value.until)windows.delete(key);
  let slot=windows.get(uid);if(!slot){slot={until:now+60000,n:0};windows.set(uid,slot);}
  if(slot.n>=writePerMin){res.setHeader('Retry-After',String(Math.max(1,Math.ceil((slot.until-now)/1000))));throw fail(429,'doc_rate_limited','保存过于频繁，请稍后重试');}slot.n++;
 }
 function write(uid,p,data,save){
  const serialized=JSON.stringify(data);
  db.exec('BEGIN IMMEDIATE');
  try{
   const used=db.prepare('SELECT COALESCE(SUM(length(CAST(data AS BLOB))),0) bytes, COUNT(*) n FROM docs WHERE uid=?').get(uid);
   const old=db.prepare('SELECT length(CAST(data AS BLOB)) bytes FROM docs WHERE path=? AND uid=?').get(p,uid);
   const shrinking=old && Buffer.byteLength(serialized)<=old.bytes;
   if(!shrinking && (used.bytes-(old?.bytes||0)+Buffer.byteLength(serialized)>userBytes||used.n+(old?0:1)>userCount))throw fail(413,'doc_quota','文档存储已达上限，请删除不需要的记录或联系管理员');
   save();db.exec('COMMIT');
  }catch(e){db.exec('ROLLBACK');throw e;}
 }
 return {throttle,write};
}
function docQuotaOptions(env=process.env){
 const read=(name,fallback)=>{const raw=env[name];const n=raw==null||raw.trim()===''?fallback:Number(raw);if(!Number.isSafeInteger(n)||n<1)throw new Error(name+' must be a positive integer');return n;};
 return {userBytes:read('DOC_USER_BYTES',52428800),userCount:read('DOC_USER_COUNT',20000),writePerMin:read('DOC_WRITE_PER_MIN',240)};
}
module.exports={createDocQuota,docQuotaOptions};
