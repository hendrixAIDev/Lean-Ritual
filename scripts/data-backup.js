#!/usr/bin/env node
'use strict';
const path=require('node:path'),fs=require('node:fs');const {createSnapshot,verifySnapshot,restoreSnapshot}=require('../lib/snapshots');
const {readLedger}=require('../lib/deletion-ledger');
(async()=>{const [command,source,target,ledgerFlag,ledgerFile]=process.argv.slice(2),dataDir=path.resolve(process.env.DATA_DIR||'data');
 if(command==='backup'&&source)await createSnapshot(dataDir,source);
 else if(command==='verify'&&source)verifySnapshot(source);
 else if(command==='restore'&&source&&target&&ledgerFlag==='--deletions'&&ledgerFile)restoreSnapshot(source,target,JSON.parse(fs.readFileSync(ledgerFile,'utf8')));
 else if(command==='ledger'&&source){const release=require('../lib/data-access').shared(dataDir);try{fs.writeFileSync(source,JSON.stringify(readLedger(dataDir),null,2),{flag:'wx',mode:0o600});}finally{release();}}
 else throw new Error('Usage: data-backup.js backup NEW_DIRECTORY | verify SNAPSHOT | ledger NEW_FILE | restore SNAPSHOT EMPTY_DIRECTORY --deletions LATEST_LEDGER');
 console.log(command+' complete');
})().catch(e=>{console.error(e.message);process.exitCode=1});
