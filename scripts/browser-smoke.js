'use strict';
// Requires Playwright and a Chromium executable; uses only disposable local data.
const {chromium}=require('playwright'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const http=require('node:http');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ritual-browser-')),base='http://127.0.0.1:18083';
 const env={...process.env,DATA_DIR:dir,PORT:'18083',HOST:'127.0.0.1',AUTH_BASE_URL:base,AUTH_SECRET:'browser-test-only-secret-at-least-32-characters',COOKIE_SECURE:'0',TRUST_PROXY:'0',MAIL_MODE:'file',OPENROUTER_API_KEY:'local-test-provider-key',OPENROUTER_BASE:'http://127.0.0.1:18084/v1'};
 let server,browser,provider;const providerRequests=[];
 try {
  provider=http.createServer(async(req,res)=>{const parts=[];for await(const chunk of req)parts.push(chunk);providerRequests.push(JSON.parse(Buffer.concat(parts).toString()));res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({kcal:321,protein:20,carbs:40,fat:9,items:[],confidence:'中',tip:'test estimate'})}}]}));});
  await new Promise(r=>provider.listen(18084,'127.0.0.1',r));
  const issued=spawnSync(process.execPath,['scripts/auth-admin.js','invite','browser@example.com'],{env,encoding:'utf8',timeout:5000});if(issued.error)throw issued.error;assert.equal(issued.status,0,issued.stderr);const invite=JSON.parse(issued.stdout);
  server=spawn(process.execPath,['server.js'],{env,stdio:['ignore','pipe','pipe']});let errors='';server.stderr.on('data',d=>errors+=d);
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('startup timeout '+errors)),8000);server.stdout.once('data',()=>{clearTimeout(timer);resolve();});server.once('error',reject);server.once('exit',()=>{clearTimeout(timer);reject(new Error(errors));});});
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:390,height:844}}),failures=[],external=[];
  page.on('pageerror',e=>failures.push(e.message));
  page.on('request',r=>{if(/^https?:/.test(r.url())&&!r.url().startsWith(base))external.push(r.url());});
  page.setDefaultTimeout(15000);
  await page.goto(invite.url);
  await page.locator('#n').fill('Browser tester');await page.locator('#p').fill('browser strong password');await page.locator('#go').click();
  await page.getByText('请查收验证邮件，验证后再登录。',{exact:true}).waitFor();
  const mail=fs.readdirSync(path.join(dir,'mail')).map(f=>JSON.parse(fs.readFileSync(path.join(dir,'mail',f),'utf8'))).find(m=>m.kind==='verify');
  await page.goto(mail.url);await page.locator('#e').fill(invite.email);await page.locator('#p').fill('browser strong password');await page.locator('#go').click();
  await page.locator('#setup').waitFor();await page.locator('#f-age').fill('30');await page.locator('#f-height').fill('175');await page.locator('#f-weight').fill('70');await page.getByRole('button',{name:'生成我的计划',exact:true}).click();
  await page.locator('#tabs').waitFor({state:'visible'});await page.locator('#tabs [data-act="tab"][data-v="food"]').click();
  await page.locator('[data-act="mmode"][data-v="manual"]').click();
  await page.locator('#m-text').fill('Browser smoke test meal');await page.locator('#mf-kcal').fill('300');await page.locator('[data-act="add-meal"]').click();
  await page.getByText('Browser smoke test meal',{exact:true}).waitFor();await page.reload();await page.getByText('Browser smoke test meal',{exact:true}).waitFor();
  // A failed profile read must not look like a new account or allow overwrites.
  await page.route('**/api/doc?*', route => {
    const documentPath = new URL(route.request().url()).searchParams.get('path');
    return documentPath?.endsWith('/app/profile') ? route.abort() : route.continue();
  });
  await page.reload();
  await page.getByRole('button',{name:'重新加载',exact:true}).waitFor();
  assert.equal(await page.locator('#setup').count(),0);
  assert.equal(await page.locator('#tabs').isVisible(),false);
  await page.unroute('**/api/doc?*');
  await page.getByRole('button',{name:'重新加载',exact:true}).click();
  await page.getByText('Browser smoke test meal',{exact:true}).waitFor();
  assert.equal(await page.locator('#setup').count(),0);
  console.log('PASS: failed profile read blocks setup; retry restores existing profile and meal');
  console.log('PASS: signup, verification, login, profile and manual meal persistence');
  // Load OCR entirely from our origin and recognize a generated nutrition label.
  const ocr=await page.evaluate(async()=>{const canvas=document.createElement('canvas');canvas.width=900;canvas.height=200;const c=canvas.getContext('2d');c.fillStyle='white';c.fillRect(0,0,900,200);c.fillStyle='black';c.font='48px sans-serif';c.fillText('ENERGY 300 kcal',30,100);const blob=await new Promise(r=>canvas.toBlob(r));return Promise.race([ocrImage(blob),new Promise((_,reject)=>setTimeout(()=>reject(new Error("OCR timeout")),45000))]);});
  assert.match(ocr,/300/);
  await page.locator('[data-act="mmode"][data-v="ai"]').click();
  const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=20;c.height=20;c.getContext('2d').fillRect(0,0,20,20);return c.toDataURL().split(',')[1];});
  await page.locator('#m-photo').setInputFiles({name:'meal.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await page.locator('#m-text').fill('Mock AI photo meal');
  await page.locator('[data-act="add-meal"]').click();
  await page.waitForFunction(()=>Object.values(S.days).some(d=>d.meals?.some(m=>m.text==='Mock AI photo meal'&&m.est?.kcal===321)));
  assert.equal(providerRequests.length,1);
  assert.ok(providerRequests[0].messages.at(-1).content.some(c=>c.type==='image_url'));
  await page.reload();await page.getByText('Mock AI photo meal',{exact:true}).waitFor();

  if(process.env.HEIC_FIXTURE){
    const converted=await page.evaluate(async base64=>{const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));const result=await compress2(new File([bytes],'fixture.heic',{type:'image/heic'}));return {ok:result.ok,type:result.blob?.type,size:result.blob?.size};},fs.readFileSync(process.env.HEIC_FIXTURE).toString('base64'));
    assert.equal(converted.ok,true);assert.equal(converted.type,'image/jpeg');assert.ok(converted.size>0);console.log('PASS: real HEIC fixture converts to JPEG using the local library');
  }
  await page.locator('#tabs [data-act="tab"][data-v="me"]').click();await page.locator('[data-act="pw-edit"]').click();await page.locator('#pw-old').fill('browser strong password');await page.locator('#pw-new').fill('new browser strong password');await page.locator('#pw-new2').fill('new browser strong password');await page.locator('[data-act="pw-save"]').click();await page.getByText('密码已更新，其他设备需要重新登录',{exact:true}).waitFor();
  await page.locator('[data-act="logout"]').click();await page.waitForURL('**/login.html');
  await page.locator('#e').fill(invite.email);await page.locator('#p').fill('new browser strong password');await page.locator('#go').click();await page.locator('#tabs').waitFor({state:'visible'});
  await page.locator('#tabs [data-act="tab"][data-v="me"]').click();
  const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('link',{name:'导出我的记录和照片'}).click()]);
  const exported=fs.readFileSync(await download.path(),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(exported.some(x=>x.kind==='photo'));assert.ok(exported.some(x=>x.kind==='document'));
  await page.getByText('删除账号',{exact:true}).click();await page.locator('#delete-password').fill('new browser strong password');await page.locator('#delete-confirm').check();await page.locator('[data-act="delete-account"]').click();await page.waitForURL('**/login.html?deleted=1');
  assert.equal(await page.evaluate(()=>Object.keys(localStorage).some(k=>k.startsWith('bj-user:'))),false);
  assert.deepEqual(failures,[]);assert.deepEqual(external,[]);
  console.log('PASS: mobile Chromium invitation, verification, login, setup, manual meal persistence, local OCR, backend photo AI mock, password change, logout/login; export and deletion; no external browser requests or page errors');
 } finally {if(browser)await browser.close();if(server&&server.exitCode===null){const stopped=new Promise(r=>server.once('exit',r));server.kill();await stopped;}if(provider)await new Promise(r=>provider.close(r));fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
