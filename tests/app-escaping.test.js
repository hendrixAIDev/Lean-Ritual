import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source = fs.readFileSync(new URL('../app/index.html', import.meta.url), 'utf8');
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
