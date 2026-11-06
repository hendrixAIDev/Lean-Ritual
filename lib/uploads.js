'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');const sharp=require('sharp');
const fail=(status,code,message)=>Object.assign(new Error(message),{status,code});
function createUploads(db,dataDir,{userBytes=250*1024*1024,totalBytes=5*1024*1024*1024,daily=60}={}){
 for(const n of [userBytes,totalBytes,daily])if(!Number.isSafeInteger(n)||n<1)throw new Error('Upload quotas must be positive integers');
 db.exec('CREATE TABLE IF NOT EXISTS upload_usage(uid TEXT,day TEXT,n INTEGER,PRIMARY KEY(uid,day)); CREATE INDEX IF NOT EXISTS blobs_uid ON blobs(uid)');
 let active=0;const users=new Set();
 function begin(uid){
  if(active>=2||users.has(uid))throw fail(429,'rate_limited','照片处理中，请稍后重试');
  const day=new Date().toISOString().slice(0,10);
  db.exec('BEGIN IMMEDIATE');try{const used=db.prepare('SELECT n FROM upload_usage WHERE uid=? AND day=?').get(uid,day)?.n||0;if(used>=daily)throw fail(429,'rate_limited','今天的照片上传次数已达上限');db.prepare('INSERT INTO upload_usage VALUES(?,?,1) ON CONFLICT(uid,day) DO UPDATE SET n=n+1').run(uid,day);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}
  active++;users.add(uid);let released=false;return()=>{if(!released){released=true;active--;users.delete(uid);}};
 }
 async function normalize(buffer){
  try{
   const input=sharp(buffer,{limitInputPixels:40000000,failOn:'error'});const metadata=await input.metadata();
   if(!['jpeg','png','webp','gif'].includes(metadata.format))throw new Error('Unsupported image');
   // Decode/re-encode rather than trusting Content-Type. Strip metadata and
   // normalize orientation; never serve uploaded HTML or trailing payloads.
   return await input.rotate().resize({width:2560,height:2560,fit:'inside',withoutEnlargement:true}).webp({quality:85}).timeout({seconds:10}).toBuffer();
  }catch{throw fail(415,'bad_type','照片格式无效，请使用 JPG、PNG、WebP 或已转换的 HEIC 照片');}
 }
 function save(uid,buffer){
  const id=crypto.randomBytes(16).toString('hex'),file=path.join(dataDir,'blobs',id);let wrote=false;
  db.exec('BEGIN IMMEDIATE');try{
   const own=db.prepare('SELECT COALESCE(SUM(size),0) n FROM blobs WHERE uid=?').get(uid).n,total=db.prepare('SELECT COALESCE(SUM(size),0) n FROM blobs').get().n;
   if(own+buffer.length>userBytes||total+buffer.length>totalBytes)throw fail(413,'storage_quota','照片存储空间已达上限，请删除不需要的照片或联系管理员');
   const fd=fs.openSync(file,'wx',0o600);wrote=true;try{fs.writeFileSync(fd,buffer);}finally{fs.closeSync(fd);}db.prepare('INSERT INTO blobs(id,uid,type,size,created) VALUES(?,?,?,?,?)').run(id,uid,'image/webp',buffer.length,new Date().toISOString());db.exec('COMMIT');return{id,url:'/_blob/'+id,sizeBytes:buffer.length,contentType:'image/webp'};
  }catch(e){try{db.exec('ROLLBACK');}finally{if(wrote)fs.rmSync(file,{force:true});}throw e;}
 }
 return {begin,normalize,save};
}
module.exports={createUploads};
