import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import ts from 'typescript';
import { appNavigationFixture, findElement, navigationModel } from './helpers/mobile-navigation-fixture.mjs';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-model-'));
test.after(() => fs.rm(dir, { recursive: true, force: true }));
await build({ stdin: { contents: "export * from './apps/mobile/src/features/feedback/model'; export * from './apps/mobile/src/features/feedback/lastError'; export * from './apps/mobile/src/features/feedback/queue';", resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'esm', outfile: path.join(dir,'model.mjs'), nodePaths: [path.resolve('apps/mobile/node_modules')], define: { 'import.meta.env': '{}' } });
const model = await import(pathToFileURL(path.join(dir,'model.mjs')).href);
const { collectFeedbackContext, parseFeedbackUserAgent, feedbackStatusText, redactFeedbackError, recordFeedbackError, lastFeedbackError, observeFeedbackErrors, createFeedbackSender, assertFeedbackQueueCapacity, feedbackScreenshot, validateFeedbackInput, openFeedback } = model;
const context = collectFeedbackContext({ version: '0.3.1', versionCode: 42, page: '会话', agentId: 'ccdesk', sessionId: 'synthetic-session', lastError: '请求超时' }, 'Android 16; TestPhone Build/TEST; wv)');
const input = (extra = {}) => ({ clientId: randomUUID(), text: '返回后看不到会话', context, ...extra });
function memoryQueue() {
  const entries = new Map();
  return { entries, async list(scope) { return [...entries.values()].filter(record => record.scope === scope).map(record => structuredClone(record)); },
    async add(record) { const list = await this.list(record.scope); assertFeedbackQueueCapacity(list, record); validateFeedbackInput(record.input); const key = JSON.stringify([record.scope,record.input.clientId]); if (!entries.has(key)) entries.set(key, structuredClone(record)); },
    async remove(scope,id) { entries.delete(JSON.stringify([scope,id])); } };
}
const queue = (storage, scope, payload) => storage.add({ scope, input: payload, createdAt: '2026-11-17T00:00:00.000Z' });
const receipt = payload => ({ ...payload, id: 'synthetic-receipt', createdAt: '2026-11-17T00:00:00.000Z', status: { state: 'received' } });
test('context whitelist, per-field bounds and userAgent model/OS parsing', () => {
  assert.deepEqual(parseFeedbackUserAgent('Mozilla/5.0 (Linux; Android 16; zh-CN; TestPhone Build/TEST; wv) AppleWebKit/537.36'), { model: 'TestPhone', os: 'Android 16' });
  assert.deepEqual(parseFeedbackUserAgent('Mozilla/5.0 (Linux; Android 15; wv)'), { model: '未知机型', os: 'Android 15' });
  assert.deepEqual(parseFeedbackUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X)'), { model: 'iPhone', os: 'iOS 18.2' });
  assert.deepEqual(parseFeedbackUserAgent('unknown'), { model: '浏览器（机型未知）', os: '未知系统' });
  const fields = { version: 80, page: 80, agentId: 64, sessionId: 160, lastError: 200, model: 120, os: 120 };
  for (const [key,max] of Object.entries(fields)) assert.equal(collectFeedbackContext({ ...context, [key]: '字'.repeat(300) }, '')[key].length, max);
  const result = collectFeedbackContext({ ...context, token: 'not collected', message: 'not collected', versionCode: NaN }, '');
  assert.equal(result.versionCode, 0); assert.equal('token' in result, false); assert.equal('message' in result, false);
  assert.equal(result.agentId, 'ccdesk'); assert.equal(result.sessionId, 'synthetic-session');
});
test('last displayed error is memory-only, redacted before truncation, and isolated by connection scope', () => {
  const key = 'k'.repeat(48), file = path.join(path.sep, 'private', 'synthetic', 'image.png');
  const safe = redactFeedbackError(`读取失败 ${file} token=${key} Bearer ${key} ${'字'.repeat(300)}`);
  assert.ok(!safe.includes(file)); assert.ok(!safe.includes(key)); assert.ok(safe.length <= 200);
  recordFeedbackError('scope-a', '最初错误'); recordFeedbackError('scope-a', '最近错误');
  assert.equal(lastFeedbackError('scope-a'), '最近错误'); assert.equal(lastFeedbackError('scope-b'), '');
});
test('one visible-error recorder ignores hidden alerts and remembers only changed displayed text', t => {
  const old = { MutationObserver: globalThis.MutationObserver, getComputedStyle: globalThis.getComputedStyle };
  t.after(() => { for (const [key,value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  let scan, disconnected = false;
  globalThis.MutationObserver = class { constructor(callback) { scan = callback; } observe() {} disconnect() { disconnected = true; } };
  globalThis.getComputedStyle = node => ({ visibility: node.hidden ? 'hidden' : 'visible' });
  const visible = { textContent: '会话读取失败', getClientRects: () => [1] }, hidden = { textContent: '隐藏的旧错误', hidden: true, getClientRects: () => [1] };
  const stop = observeFeedbackErrors('visible-scope', { querySelectorAll: () => [visible,hidden] });
  assert.equal(lastFeedbackError('visible-scope'), visible.textContent);
  visible.textContent = '重连超时'; scan(); assert.equal(lastFeedbackError('visible-scope'), '重连超时');
  recordFeedbackError('visible-scope','另一个新错误'); scan(); assert.equal(lastFeedbackError('visible-scope'),'另一个新错误');
  stop(); assert.equal(disconnected,true);
});
test('lost submit response retains exactly the same clientId for recovery; confirmed receipt alone removes it', async () => {
  const storage = memoryQueue(), payload = input(), calls = []; await queue(storage,'scope-a',payload);
  let attempt = 0;
  let sender = createFeedbackSender({ scope:'scope-a',storage, active:()=>true, changed:()=>{}, post:async value=>{ calls.push(value); if (++attempt === 1) throw new Error('lost response'); return receipt(value); } });
  await assert.rejects(sender.flush(), /lost response/); assert.equal((await storage.list('scope-a')).length,1);
  // Recreate the runtime against the saved queue, as after a process restart.
  sender = createFeedbackSender({ scope:'scope-a',storage, active:()=>true, changed:()=>{}, post:async value=>{ calls.push(value); return receipt(value); } });
  await sender.flush(); assert.deepEqual(calls.map(value=>value.clientId),[payload.clientId,payload.clientId]); assert.equal((await storage.list('scope-a')).length,0);
});
test('concurrent retry is single flight; duplicate enqueues never rewrite the payload', async () => {
  const storage = memoryQueue(), payload = input(); await queue(storage,'scope-a',payload); await queue(storage,'scope-a',{ ...payload,text:'must not replace persisted content' });
  let calls=0, release; const blocked=new Promise(resolve=>{release=resolve;});
  const sender=createFeedbackSender({scope:'scope-a',storage,active:()=>true,changed:()=>{},post:async value=>{calls++;await blocked;return receipt(value);}});
  const first=sender.flush(),second=sender.flush();assert.equal(first,second);release();await first;
  assert.equal(calls,1);assert.equal((await storage.list('scope-a')).length,0);
});
test('scope switches, offline state, mismatched receipts and 401/429 leave pending feedback intact', async () => {
  const storage=memoryQueue(),a=input(),b=input();await queue(storage,'scope-a',a);await queue(storage,'scope-b',b);
  let active=false,calls=0;
  const sender=createFeedbackSender({scope:'scope-a',storage,active:()=>active,changed:()=>{},post:async value=>{calls++;active=false;return receipt(value);}});
  await sender.flush();assert.equal(calls,0);active=true;await sender.flush();assert.equal((await storage.list('scope-a')).length,1);assert.equal((await storage.list('scope-b')).length,1);
  for(const status of [401,429,503]) {
    const fail=createFeedbackSender({scope:'scope-a',storage,active:()=>true,changed:()=>{},post:async()=>{throw Object.assign(new Error('not accepted'),{status});}});
    await assert.rejects(fail.flush());assert.equal((await storage.list('scope-a')).length,1);
  }
  const mismatch=createFeedbackSender({scope:'scope-a',storage,active:()=>true,changed:()=>{},post:async()=>receipt(input())});
  await assert.rejects(mismatch.flush(),/回执不匹配/);assert.equal((await storage.list('scope-a')).length,1);
});
test('queue is bounded and a full queue rejects the new item without deleting previous entries',async()=>{
  const storage=memoryQueue();for(let i=0;i<20;i++)await queue(storage,'scope-a',input());
  await assert.rejects(queue(storage,'scope-a',input()),/已满/);assert.equal((await storage.list('scope-a')).length,20);
  await queue(storage,'scope-b',input());assert.equal((await storage.list('scope-b')).length,1);
});
test('feedback status labels reflect human triage without losing issue/version/reason',()=>{
  assert.equal(feedbackStatusText({state:'received'}),'已收到');assert.equal(feedbackStatusText({state:'filed',issue:12}),'已提交 #12');
  assert.equal(feedbackStatusText({state:'fixed',version:'0.3.2'}),'已修复，在 0.3.2');assert.equal(feedbackStatusText({state:'dismissed',reason:'已有相同反馈'}),'未采纳：已有相同反馈');
});
test('screenshot MIME comes from the header, not the chosen name/type, with a 5MiB ceiling',async t=>{
  const old=globalThis.FileReader;t.after(()=>{if(old===undefined)delete globalThis.FileReader;else globalThis.FileReader=old;});
  globalThis.FileReader=class{async readAsDataURL(file){this.result=`data:application/octet-stream;base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`;this.onload();}};
  const png=new File([new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0])],'misleading.txt',{type:'text/plain'});
  assert.equal((await feedbackScreenshot(png)).mimeType,'image/png');
  await assert.rejects(feedbackScreenshot(new File(['<svg/>'],'fake.png',{type:'image/png'})),/有效/);
  await assert.rejects(feedbackScreenshot({size:5*1024*1024+1}),/5MiB/);
});

const uiSource=await fs.readFile('apps/mobile/src/features/feedback/FeedbackHost.tsx','utf8');
const ast=ts.createSourceFile('feedback.tsx',uiSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const body=ast.statements.filter(node=>!ts.isImportDeclaration(node)).map(node=>node.getText(ast)).join('\n').replaceAll('export function','function');
const ui=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React,jsxFactory:'h'}}).outputText;
function uiDriver(name,props,overrides={}) {
  const slots=[],effects=[],events=new EventTarget();let cursor=0,dirty=true,tree;const layers=[],timers=new Map();let nextTimer=0;
  const deps={...model,crypto:globalThis.crypto,window:Object.assign(events,{setInterval:fn=>{timers.set(++nextTimer,fn);return nextTimer;}}),clearInterval:id=>timers.delete(id),
    document:{hidden:false,activeElement:null,addEventListener(){},removeEventListener(){}},navigator:{onLine:true,userAgent:'Android 16; TestPhone Build/TEST; wv)'},HTMLElement:class{},
    appVersionName:'0.3.1',appVersionCode:42,isKelivoHost:false,productVersionLabel:'v0.1.11',productVersionCode:13,
    observeFeedbackErrors:()=>()=>{},relayAuthorization:()=>({isRevoked:()=>false,subscribe:()=>()=>{}}),buildUrl:(_endpoint,route)=>route,
    useCaptureVoice:()=>({}),VoiceInput:'VoiceInput',X:'X',createPortal:child=>child,useBackLayer:(open,close,priority)=>{layers.push({open,close,priority});},
    useState(value){const i=cursor++;slots[i]??={value:typeof value==='function'?value():value};return[slots[i].value,next=>{const value=typeof next==='function'?next(slots[i].value):next;dirty||=value!==slots[i].value;slots[i].value=value;}];},
    useRef(value){return slots[cursor++]??={current:value};},useMemo(action,dependencies){const i=cursor++,old=slots[i];if(!old||dependencies.some((value,j)=>value!==old.dependencies[j]))slots[i]={value:action(),dependencies};return slots[i].value;},
    useEffect(setup,dependencies){const i=cursor++,old=slots[i];if(!old||dependencies.some((value,j)=>value!==old.dependencies[j]))effects.push(()=>{old?.cleanup?.();slots[i]={dependencies,cleanup:setup()};});},
    apiGet:async()=>({items:[]}),apiPost:async(_url,_token,value)=>receipt(value),...overrides};
  const h=(type,props,...children)=>({type,props:{...props,children}});deps.h=h;
  const Component=new Function(...Object.keys(deps),ui+`; return ${name};`)(...Object.values(deps));
  function render(){let attempts=0;do{if(++attempts>20)throw new Error('feedback UI did not settle');dirty=false;cursor=0;tree=Component(props);for(const run of effects.splice(0))run();}while(dirty);return tree;}
  const nodes=node=>Array.isArray(node)?node.flatMap(nodes):node&&typeof node==='object'?[node,...nodes(node.props?.children)]:[];
  const text=node=>Array.isArray(node)?node.map(text).join(''):node&&typeof node==='object'?text(node.props?.children):node??'';
  const find=predicate=>nodes(render()).find(predicate);
  render();return{deps,events,layers,timers,render,find,text:()=>text(render()),async settle(){for(let i=0;i<6;i++){await new Promise(resolve=>setImmediate(resolve));render();}return tree;},stop(){for(const slot of slots)slot?.cleanup?.();},button(label){return find(node=>node.type==='button'&&(text(node)===label||node.props['aria-label']===label));}};
}
test('settings exposes a reusable openFeedback and the App mounts it alongside the active workspace',async()=>{
  const f=appNavigationFixture(navigationModel.agentSession('ccdesk','synthetic-session'));
  try{const host=findElement(f.render(),'FeedbackHost');assert.equal(host.props.navigation.agentId,'ccdesk');assert.equal(host.props.navigation.sessionId,'synthetic-session');assert.equal(host.props.scope,f.scope);}finally{f.stop();}
  const settings=await fs.readFile('apps/mobile/src/app/GlobalSettings.tsx','utf8');assert.match(settings,/onClick={\(\) => openFeedback\(\)}>反馈问题/);
});
test('global opening freezes current context and optional text/screenshot without changing Agent navigation',async t=>{
  const storage=memoryQueue(),navigation=navigationModel.agentSession('ccdesk','synthetic-session');
  recordFeedbackError('scope-a','最近的会话错误');
  const f=uiDriver('FeedbackHost',{scope:'scope-a',endpoint:'',token:'',navigation,page:'设置'},{feedbackQueueStorage:()=>storage});t.after(()=>f.stop());
  const old=globalThis.window;globalThis.window=f.events;t.after(()=>{if(old===undefined)delete globalThis.window;else globalThis.window=old;});
  const screenshot=new File(['image'],'capture.png');openFeedback({text:'预填描述',screenshot});
  const sheet=f.render();assert.equal(sheet.props.options.text,'预填描述');assert.equal(sheet.props.options.screenshot,screenshot);assert.equal(sheet.props.context.agentId,'ccdesk');assert.equal(sheet.props.context.page,'设置');assert.equal(sheet.props.context.lastError,'最近的会话错误');
  assert.deepEqual(navigation,navigationModel.agentSession('ccdesk','synthetic-session'));await f.settle();
});
test('feedback sheet uses raw voice input, keeps form on persistence failure and single-flights submission',async t=>{
  let fail=true,calls=0,release;const blocked=new Promise(resolve=>{release=resolve;});const sent=[];
  const props={scope:'scope-a',endpoint:'',token:'',options:{text:'描述问题'},context,queued:[],revision:0,storageError:'',close(){},submit:async value=>{calls++;sent.push(value);await blocked;if(fail)throw new Error('storage full');}};
  const f=uiDriver('FeedbackSheet',props);t.after(()=>f.stop());
  const voice=f.find(node=>node.type==='VoiceInput');assert.equal(voice.props.capture,true);voice.props.onDraft('语音描述');
  f.button('提交反馈').props.onClick();f.button('正在保存…').props.onClick();assert.equal(calls,1);release();await f.settle();
  assert.match(f.text(),/storage full/);assert.equal(f.find(node=>node.type==='textarea').props.value,'语音描述');
  fail=false;f.button('提交反馈').props.onClick();await f.settle();assert.equal(calls,2);assert.equal(sent[0].clientId,sent[1].clientId);assert.equal(f.find(node=>node.type==='textarea').props.value,'');
  assert.equal(f.layers.at(-1).priority,215);assert.equal(f.timers.size,1);
});
test('offline feedback is persisted and retried on resume using the same UUID; cleanup removes listeners and timers',async t=>{
  const storage=memoryQueue(),payload=input();await queue(storage,'scope-a',payload);let calls=0;
  const f=uiDriver('FeedbackHost',{scope:'scope-a',endpoint:'synthetic',token:'synthetic',navigation:navigationModel.agentPicker(),page:'选择 Agent'},
    {feedbackQueueStorage:()=>storage,navigator:{onLine:false,userAgent:''},apiPost:async(_url,_token,value)=>{calls++;return receipt(value);}});t.after(()=>f.stop());
  await f.settle();assert.equal(calls,0);assert.equal((await storage.list('scope-a')).length,1);
  f.deps.navigator.onLine=true;f.events.dispatchEvent(new Event('online'));await f.settle();assert.equal(calls,1);assert.equal((await storage.list('scope-a')).length,0);
  f.stop();assert.equal(f.timers.size,0);f.events.dispatchEvent(new Event('online'));await f.settle();assert.equal(calls,1);
});

test('an invalid queued screenshot remains saved but does not block a later valid feedback',async()=>{
  const storage=memoryQueue(),bad=input(),good=input();await queue(storage,'scope-a',bad);await queue(storage,'scope-a',good);
  const sender=createFeedbackSender({scope:'scope-a',storage,active:()=>true,changed:()=>{},post:async value=>{if(value.clientId===bad.clientId)throw Object.assign(new Error('invalid image'),{status:422});return receipt(value);}});
  await assert.rejects(sender.flush(),/invalid image/);assert.deepEqual((await storage.list('scope-a')).map(entry=>entry.input.clientId),[bad.clientId]);
});
test('my feedback renders pending entries and actual received/filed/fixed/dismissed status from GET',async t=>{
  const statuses=[{state:'received'},{state:'filed',issue:12},{state:'fixed',version:'0.3.2'},{state:'dismissed',reason:'已有相同反馈'}];
  const items=statuses.map((status,i)=>({...receipt(input()),id:`receipt-${i}`,status}));
  const f=uiDriver('FeedbackSheet',{scope:'scope-a',endpoint:'synthetic',token:'synthetic',options:{},context,queued:[{scope:'scope-a',input:input({text:'离线时的描述'}),createdAt:'2026-11-17T00:00:00.000Z'}],revision:0,storageError:'',close(){},submit:async()=>{}},{apiGet:async()=>({items})});t.after(()=>f.stop());await f.settle();
  for(const label of ['已收到','已提交 #12','已修复，在 0.3.2','未采纳：已有相同反馈','离线时的描述','待发送（已保存在手机）'])assert.ok(f.text().includes(label),label);
});
