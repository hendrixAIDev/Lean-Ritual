#!/usr/bin/env node
'use strict';
const path=require('node:path'),fs=require('node:fs');const {createSnapshot,verifySnapshot,restoreSnapshot}=require('../lib/snapshots');
const {readLedger}=require('../lib/deletion-ledger');
const USAGE='Usage: data-backup.js backup NEW_DIRECTORY [--link-dest PREV_SNAPSHOT]... [--defer-blobs INDEX_JSON] | verify SNAPSHOT | ledger NEW_FILE | restore SNAPSHOT EMPTY_DIRECTORY --deletions LATEST_LEDGER';
function parseBackupOptions(rest){
 const linkFrom=[];let deferBlobs=null;
 for(let i=0;i<rest.length;i++){
  if(rest[i]==='--link-dest'&&i+1<rest.length){linkFrom.push(rest[++i]);}
  else if(rest[i]==='--defer-blobs'&&i+1<rest.length&&!deferBlobs){deferBlobs=rest[++i];}
  else throw new Error(USAGE);
 }
 const options={};
 if(linkFrom.length)options.linkFrom=linkFrom;
 if(deferBlobs)options.deferBlobs=deferBlobs;
 return options;
}
(async()=>{const args=process.argv.slice(2),[command,source,target,ledgerFlag,ledgerFile]=args,dataDir=path.resolve(process.env.DATA_DIR||'data');
 if(command==='backup'&&source)await createSnapshot(dataDir,source,parseBackupOptions(args.slice(2)));
 else if(command==='verify'&&source&&args.length===2)verifySnapshot(source);
 else if(command==='restore'&&source&&target&&ledgerFlag==='--deletions'&&ledgerFile&&args.length===5)restoreSnapshot(source,target,JSON.parse(fs.readFileSync(ledgerFile,'utf8')));
 else if(command==='ledger'&&source&&args.length===2){
  const release=require('../lib/data-access').shared(dataDir);
  try{
   const fd=fs.openSync(source,'wx',0o600);
   try{fs.writeFileSync(fd,JSON.stringify(readLedger(dataDir),null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   let dfd;try{dfd=fs.openSync(path.dirname(path.resolve(source)),'r');try{fs.fsyncSync(dfd);}catch(e){if(e.code!=='EINVAL'&&e.code!=='EBADF'&&e.code!=='EROFS')throw e;}finally{fs.closeSync(dfd);}}catch{}
  }finally{release();}
 }
 else throw new Error(USAGE);
 console.log(command+' complete');
})().catch(e=>{console.error(e.message);process.exitCode=1});
