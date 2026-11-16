const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
test('host audit is report-only and hides environment secrets',()=>{
 if(process.getuid?.()!==0) return;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'audit-'));
 try {
 for(const dir of ['etc/bojin','opt/bojin-releases/test','usr/bin','bin']) fs.mkdirSync(path.join(root,dir),{recursive:true});
 fs.writeFileSync(path.join(root,'etc/bojin/environment'),'AUTH_SECRET=PLANTED_SUPER_SECRET_VALUE_123456789\n');
 fs.writeFileSync(path.join(root,'opt/bojin-releases/test/.env'),'secret');
 const stub='#!/bin/sh\ncase "$*" in *ExecStart*) echo "{ path=/missing/helper ; }";; *) echo stub;; esac\n';
 for(const name of ['systemctl','df','du','stat','sha256sum','curl','journalctl','caddy','openssl','free','swapon','sysctl','timeout']) fs.writeFileSync(path.join(root,'bin',name),stub,{mode:0o755});
 fs.writeFileSync(path.join(root,'usr/bin/node'),'#!/bin/sh\necho v24.1.0\n',{mode:0o755});
 const r=spawnSync('bash',['scripts/host-audit.sh'],{encoding:'utf8',env:{...process.env,AUDIT_ROOT:root,PATH:path.join(root,'bin')+':'+process.env.PATH}});
 assert.equal(r.status,0); assert(!r.stdout.includes('PLANTED_SUPER_SECRET')); assert.match(r.stdout,/FAIL ExecStart missing/); assert.match(r.stdout,/FAIL leftover environment/); assert.match(r.stdout,/Summary: FAIL=/);
 console.log(r.stdout.slice(-700));
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
