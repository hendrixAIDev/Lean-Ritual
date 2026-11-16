const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
test('host audit is report-only and hides environment secrets',()=>{

 const root=fs.mkdtempSync(path.join(os.tmpdir(),'audit-'));
 try {
 for(const dir of ['etc/bojin','opt/bojin-releases/test','usr/bin','bin']) fs.mkdirSync(path.join(root,dir),{recursive:true});
 fs.writeFileSync(path.join(root,'etc/bojin/environment'),'AUTH_SECRET=PLANTED_SUPER_SECRET_VALUE_123456789\n');
 fs.writeFileSync(path.join(root,'opt/bojin-releases/test/.env'),'LEFTOVER_PLANTED_SECRET');
 fs.writeFileSync(path.join(root,'etc/bojin-backup.env'),'OFFSITE_DEST=https://user:BACKUP_PLANTED_SECRET@backup.example/private-path\n');
 fs.writeFileSync(path.join(root,'etc/bojin-alert.env'),'ALERT_URL=https://user:ALERT_PLANTED_SECRET@notify.example/TOPIC_PLANTED_SECRET\n');
 const stub='#!/bin/sh\ncase "$*" in *ExecStart*) echo "{ path=/missing/helper ; }";; *) printf "LoadState=loaded\\nActiveState=active\\nUser=bojin\\nEnvironmentFiles=/etc/bojin/environment\\n";; esac\n';
 for(const name of ['systemctl','df','du','stat','sha256sum','curl','journalctl','caddy','openssl','free','swapon','sysctl','timeout']) fs.writeFileSync(path.join(root,'bin',name),stub,{mode:0o755});
 fs.writeFileSync(path.join(root,'usr/bin/node'),'#!/bin/sh\necho v24.1.0\n',{mode:0o755});
 fs.writeFileSync(path.join(root,'bin/journalctl'),'#!/bin/sh\necho "normal journal diagnostic"\necho "Authorization: JOURNAL_PLANTED_SECRET"\necho "token=TOKEN_PLANTED_SECRET"\necho "https://u:URL_PLANTED_SECRET@example.test/path"\n',{mode:0o755});
 const r=spawnSync('bash',['scripts/host-audit.sh'],{encoding:'utf8',env:{...process.env,AUDIT_ROOT:root,AUDIT_TEST_MODE:'1',PATH:path.join(root,'bin')+':'+process.env.PATH}});
 assert.equal(r.status,0); assert(!r.stdout.includes('PLANTED_SUPER_SECRET')); assert.match(r.stdout,/FAIL ExecStart missing/); assert.match(r.stdout,/FAIL leftover environment/); assert.match(r.stdout,/Summary: FAIL=/);
 assert.match(r.stdout,/Runtime/);
 assert.match(r.stdout,/User=bojin/);
 assert.match(r.stdout,/EnvironmentFiles=\/etc\/bojin\/environment/);
 assert.match(r.stdout,/ExecStart=/);
 assert.match(r.stdout,/normal journal diagnostic/);
 assert.match(r.stdout,/OFFSITE_DEST endpoint https:\/\/backup.example/);
 assert.match(r.stdout,/ALERT_URL endpoint https:\/\/notify.example/);
 for(const secret of ['PLANTED_SUPER_SECRET','LEFTOVER_PLANTED_SECRET','BACKUP_PLANTED_SECRET','ALERT_PLANTED_SECRET','TOPIC_PLANTED_SECRET','JOURNAL_PLANTED_SECRET','TOKEN_PLANTED_SECRET','URL_PLANTED_SECRET','private-path']) assert(!r.stdout.includes(secret),secret);
 const summary=r.stdout.match(/Summary: FAIL=(\d+) WARN=(\d+)/);
 assert.equal(Number(summary[1]),r.stdout.split('\n').filter(l=>l.startsWith('FAIL ')).length);
 assert.equal(Number(summary[2]),r.stdout.split('\n').filter(l=>l.startsWith('WARN ')).length);
 console.log(r.stdout);
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
