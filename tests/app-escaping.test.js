const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app/index.html'), 'utf8');
const helpers = ['esc','num','safeLink','safeImage'].map(name => {
 const line = source.split('\n').find(line => line.startsWith('const '+name+' = '));
 assert.ok(line);
 return line;
}).join('\n');
const ctx = vm.createContext({});
vm.runInContext(helpers+'\nthis.helpers = {esc,num,safeLink,safeImage}',ctx);
test('HTML and attributes escape hostile values', () => {
 assert.equal(ctx.helpers.esc('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
 assert.equal(ctx.helpers.num('Infinity'), '');
 assert.equal(ctx.helpers.num('<img>'), '');
 assert.equal(ctx.helpers.num('12'),12);
});
test('URLs use explicit protocol allowlists', () => {
 for(const url of ['javascript:alert(1)','data:text/html,test','//evil.test']) assert.equal(ctx.helpers.safeLink(url),'');
 assert.equal(ctx.helpers.safeLink('https://example.com'),'https://example.com');
 for(const url of ['https://evil.test/x','javascript:alert(1)','/api/\\evil']) assert.equal(ctx.helpers.safeImage(url),'');
 for(const url of ['blob:example','data:image/png;base64,a','/api/photo/1']) assert.equal(ctx.helpers.safeImage(url),url);
});
test('AI action renderer escapes labels', () => {
 const start=source.indexOf('function actionBtn('), end=source.indexOf('\nfunction fbCard(',start);
 vm.runInContext('const S={feedback:[]};\n'+source.slice(start,end)+'\nthis.actionBtn=actionBtn;',ctx);
 const html=ctx.actionBtn({kind:'swap',from:'test',to:'<img src=x onerror=alert(1)>'});
 assert.ok(!html.includes('<img'));
 assert.ok(html.includes('&lt;img'));
});

test('invalid actions and unsafe image URLs are rejected', () => {
 assert.equal(ctx.actionBtn({kind:'kcal',delta:'oops'}), '');
 assert.equal(ctx.actionBtn({kind:'edit',sets:2,lo:'',hi:12}), '');
 for (const url of ['data:image/svg+xml,test','/api/../account','/api/%2e%2e/account','https://a.test/ x']) assert.equal(ctx.helpers.safeImage(url), '');
 assert.equal(ctx.helpers.safeLink('https://a.test/ x'), '');
});
function page() {
 const c=vm.createContext({window:{},document:{addEventListener(){},querySelector(){return {innerHTML:''};}},localStorage:{getItem(){return null;},setItem(){}},console,URL,Date,setTimeout,clearTimeout});
 vm.runInContext(source.match(/<script>([\s\S]*?)<\/script>/)[1].split('/* ============ 启动 ============ */')[0],c);
 vm.runInContext(`S.profile={sex:"m",age:28,height:175,weight:72.5,trainDays:[1,3,5],slot:"pm",stage:"maintain",exp:"new",equipment:"gym",startDate:"2026-11-01",injuries:[],supps:[]};`,c);
 return c;
}
test('real views render stored HTML safely and ordinary text exactly once', () => {
 const c=page();
 vm.runInContext(`S.profile.injNote='中文 & "备注" <img src=x onerror=alert(1)>'; S.profile.exEdits={}; S.days[S.date]={date:S.date,checkin:{sleep:'<img src=x>',weight:'<img src=x>'},meals:[]};`,c);
 for(const name of ['viewToday','viewFood','viewLog','viewFeedback','viewMe']) {
  const html=vm.runInContext(name+'()',c);
  assert.doesNotMatch(html,/<img src=x|&amp;amp;|&amp;quot;/);
 }
 const meal=vm.runInContext(`mealCard({id:'" onmouseover="alert(1)',type:'中文 & "餐"',text:'中文 & "餐"',photo:'../api/account/export',thumb:'data:image/svg+xml,test'})`,c);
 assert.doesNotMatch(meal,/src="| onmouseover="|&amp;amp;/);
 assert.match(meal,/中文 &amp; &quot;餐&quot;/);
 assert.match(vm.runInContext('viewMe()',c),/72.5/);
 assert.doesNotMatch(vm.runInContext('macroBars({kcal:"<img src=x>",protein:Infinity,carbs:0,fat:1},{kcal:12,protein:1,carbs:1,fat:1})',c),/<img|NaN|Infinity/);
 vm.runInContext('S.mealMode=\'" onclick="alert(1)\'',c);
 assert.equal(vm.runInContext('mealMode()',c),'manual');
});
test('action payload round trips and applyAction validates before writes', async () => {
 const c=page();
 const html=vm.runInContext(`actionBtn({kind:"edit",from:'中文 & "动作"',to:'中文 & "新"',sets:"3",lo:"8",hi:"12"})`,c);
 const encoded=html.match(/data-v='([^']+)'/)[1];
 const payload=JSON.parse(encoded.replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&'));
 assert.equal(payload.a.from,'中文 & "动作"');
 c.payload=payload;
 vm.runInContext('updateProfile=async fn=>fn(S.profile); toast=()=>{};',c);
 await vm.runInContext('applyAction(payload)',c);
 assert.equal(vm.runInContext('S.profile.exEdits[payload.a.from].sets',c),3);
 assert.doesNotMatch(vm.runInContext('S.profile.adjustLog[0].text',c),/&amp;|&quot;/);
 const before=vm.runInContext('JSON.stringify(S.profile)',c);
 await vm.runInContext('applyAction({a:{kind:"kcal",delta:"bad"}})',c);
 assert.equal(vm.runInContext('JSON.stringify(S.profile)',c),before);
});
test('photo loaders reject traversal and unsafe fallback fetches', async () => {
 const c=page(), calls=[];
 c.fetch=async url=>{calls.push(url);return {ok:true,blob:async()=>({size:1,type:'image/png'})};};
 for(const bad of ['../api/account/export','%2e%2e%2fapi','x'.repeat(129)]) {
  c.bad=bad;
  assert.equal(await vm.runInContext('loadPhoto({id:"m",photo:bad,thumb:"data:image/svg+xml,test"})',c),null);
  assert.equal(await vm.runInContext('loadMore({id:"m",more:[{id:bad,thumb:"https://evil.test/x"}]},0)',c),null);
 }
 assert.equal(calls.length,0);
 await vm.runInContext('loadPhoto({id:"m",photo:"valid_-123"})',c);
 await vm.runInContext('loadMore({id:"m",more:[{thumb:"/api/photo/1"}]},0)',c);
 assert.deepEqual(calls,['/_blob/valid_-123','/api/photo/1']);
 const html=vm.runInContext('mealCard({id:"m",type:"午餐",photo:"valid",thumb:"https://evil.test/x"})',c);
 assert.match(html,/data-photo-fallback="primary"/);
 assert.doesNotMatch(html,/onerror=/);
 assert.doesNotMatch(html,/this.src=this.dataset.fb/);
});
test('pain insights are assembled plain and escaped once by the feedback view', () => {
 const c=page();
 vm.runInContext(`S.days[S.date]={date:S.date,meals:[],workout:{done:true,key:"A",pain:"pain",painArea:'中文 & "肩膀"',exercises:[]}};`,c);
 const text=vm.runInContext('insights().find(x=>x.title==="最近有疼痛记录").text',c);
 assert.match(text,/中文 & "肩膀"/);
 const html=vm.runInContext('viewFeedback()',c);
 assert.match(html,/中文 &amp; &quot;肩膀&quot;/);
 assert.doesNotMatch(html,/&amp;amp;|&amp;quot;/);
});
