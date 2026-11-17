import test from 'node:test';
import { messageInteractionDriver } from './helpers/message-interaction-driver.mjs';
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
await build({ stdin: { contents: "export * from './apps/mobile/src/features/feedback/model'; export * from './apps/mobile/src/features/feedback/lastError'; export * from './apps/mobile/src/features/feedback/queue'; export * from './apps/mobile/src/features/intake/feedback'; export { shareText } from './apps/mobile/src/features/intake/plugin'; export { Capacitor } from '@capacitor/core';", resolveDir: process.cwd(), loader: 'ts' },
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
async function componentSource(file) {
  const source = await fs.readFile(file, 'utf8');
  const ast = ts.createSourceFile('component.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replaceAll('export function', 'function').replaceAll('export type', 'type');
  return ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText;
}
function uiDriver(name,props,overrides={},source=ui) {
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
  const Component=new Function(...Object.keys(deps),source+`; return ${name};`)(...Object.values(deps));
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

test('copy returning false retains the existing failure message', async () => {
  const f = messageInteractionDriver(() => false);
  await f.render().copy(); assert.equal(f.render().feedback, '复制失败，请重试'); f.unmount();
});

test('message keyboard entry opens actions without copying and closing restores the originating message', () => {
  for (const keys of [{ key: 'Enter' }, { key: ' ' }, { key: 'ContextMenu' }, { key: 'F10', shiftKey: true }]) {
    let copied = 0;
    const f = messageInteractionDriver(() => copied++);
    assert.equal(f.event('onKeyDown', keys).prevented, true);
    assert.equal(f.render().menuOpen, true); assert.equal(copied, 0);
    f.render().closeMenu(); assert.equal(f.render().menuOpen, false); assert.equal(f.focused(), 1); f.unmount();
  }
  const f = messageInteractionDriver(() => assert.fail('holding must not copy'));
  f.event('onPointerDown'); f.hold(); assert.equal(f.render().menuOpen, true);
  f.render().closeMenu(); assert.equal(f.focused(), 1); f.unmount();
});

test('message menu announces three items, focuses copy, navigates keys, dismisses outside/Escape and dispatches one action', async t => {
  const source = await componentSource('apps/mobile/src/features/chat/MessageActionsMenu.tsx');
  const buttons = [0,1,2].map(index => ({ focus() { documentPort.activeElement = buttons[index]; } }));
  const menu = { querySelector: () => buttons[0], querySelectorAll: () => buttons };
  const documentPort = { body: {}, activeElement: null };
  let closed = 0, copies = 0, feedbacks = 0;
  const f = uiDriver('MessageActionsMenu', { onClose: () => closed++, onCopy: () => copies++, onFeedback: () => feedbacks++ },
    { document: documentPort, useRef: () => ({ current: menu }) }, source); t.after(() => f.stop());
  assert.equal(documentPort.activeElement, buttons[0]);
  const element = f.find(node => node.props.role === 'menu'); assert.equal(element.props['aria-label'], '消息操作');
  for (const label of ['复制', '反馈这条', '取消']) assert.equal(f.button(label).props.role, 'menuitem');
  const key = (key, shiftKey = false) => { let prevented = false; element.props.onKeyDown({ key, shiftKey, currentTarget: menu, preventDefault() { prevented = true; }, stopPropagation() {} }); return prevented; };
  for (const [value, expected] of [['ArrowDown',1],['End',2],['ArrowDown',0],['ArrowUp',2],['Home',0],['Tab',1]]) {
    assert.equal(key(value), true); assert.equal(documentPort.activeElement, buttons[expected]);
  }
  key('Tab', true); assert.equal(documentPort.activeElement, buttons[0]);
  key('Escape'); assert.equal(closed, 1); assert.equal(copies + feedbacks, 0);
  f.render().props.onClick({ target: menu, currentTarget: menu, stopPropagation() {} }); assert.equal(closed, 2);
  f.render().props.onClick({ target: {}, currentTarget: menu, stopPropagation() {} }); assert.equal(closed, 2);
  f.button('取消').props.onClick(); assert.equal(closed, 3);
  f.button('复制').props.onClick(); assert.equal(copies, 1); assert.equal(feedbacks, 0);
  f.button('反馈这条').props.onClick(); assert.equal(feedbacks, 1); assert.equal(closed, 5);
  assert.equal(f.layers.at(-1).priority, 212);
});

test('the shared message component redacts before the 200-character prefill, and Host freezes every Agent context without submitting', async t => {
  const source = await componentSource('apps/mobile/src/features/chat/components.tsx');
  const credential = 'k'.repeat(48), privatePath = ['','synthetic','draft.txt'].join('/');
  const sensitive = `错误 ${privatePath} token=${credential} ${'字'.repeat(240)}`;
  for (const agentId of ['codex','deepseek','claude','opencode','future-agent']) for (const role of ['assistant','user','tool']) {
    let options, submits = 0;
    const interaction = messageInteractionDriver(() => {}); interaction.event('onPointerDown'); interaction.hold();
    const bubble = uiDriver('MessageBubble', { message: { id: 'synthetic-message', text: sensitive, role }, onCopy() {} }, {
      useMessageInteraction: () => interaction.render(), MessageActionsMenu: 'MessageActionsMenu', openFeedback: value => { options = value; },
      isToolMessage: message => message.role === 'tool', parseMessageAttachments: message => ({ text: message.text, attachments: [] }),
      roleClass: () => '', roleLabel: () => '', Bot: 'Bot', UserRound: 'UserRound', Info: 'Info', Copy: 'Copy', formatMessageTime: () => '',
    }, source);
    t.after(() => { bubble.stop(); interaction.unmount(); });
    bubble.find(node => node.type === 'MessageActionsMenu').props.onFeedback();
    assert.equal(options.text, `关于这条消息：${redactFeedbackError(sensitive)}`);
    assert.equal(options.text.length, '关于这条消息：'.length + 200);
    assert.ok(!options.text.includes(credential)); assert.ok(!options.text.includes(privatePath));
    const navigation = navigationModel.agentSession(agentId, 'synthetic-session');
    const host = uiDriver('FeedbackHost', { scope: 'entry-scope', endpoint: '', token: '', navigation, page: '会话' }, { feedbackQueueStorage: memoryQueue });
    t.after(() => host.stop());
    const event = new Event(model.feedbackOpenEvent); event.detail = options; host.events.dispatchEvent(event);
    const sheetProps = host.render().props;
    assert.equal(sheetProps.context.agentId, agentId); assert.equal(sheetProps.context.sessionId, 'synthetic-session'); assert.equal(sheetProps.context.page, '会话');
    const sheet = uiDriver('FeedbackSheet', { ...sheetProps, submit: async () => submits++ }); t.after(() => sheet.stop());
    assert.equal(sheet.find(node => node.type === 'textarea').props.value, options.text);
    sheet.find(node => node.type === 'textarea').props.onChange({ target: { value: '用户修改后的描述' } });
    assert.equal(sheet.find(node => node.type === 'textarea').props.value, '用户修改后的描述'); assert.equal(submits, 0);
  }
});

const sharePayload = extra => ({ id: 'synthetic-share', text: '分享正文', subject: '分享标题', images: [], skipped: 0, ...extra });
const shareImage = extra => ({ path: 'synthetic-image', name: 'capture.png', mimeType: 'image/png', size: 12, ...extra });
function shareFilePorts(t, bytes) {
  const old = { fetch: globalThis.fetch, FileReader: globalThis.FileReader };
  t.after(() => { for (const [key, value] of Object.entries(old)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const requests = [];
  globalThis.fetch = async (_url, init) => { requests.push(init); return new Response(bytes); };
  globalThis.FileReader = class { async readAsDataURL(file) { this.result = `data:application/octet-stream;base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`; this.onload(); } };
  return requests;
}
const pngBytes = new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]);

test('share text includes subject once, stays editable and reserves room for the multi-image count within 2000 characters', async () => {
  const signal = new AbortController().signal;
  const textOnly = await model.shareFeedbackOptions(sharePayload({ text: '字'.repeat(2100), subject: null }), signal);
  assert.equal(textOnly.text.length, 2000); assert.equal(textOnly.screenshot, undefined);
  const short = await model.shareFeedbackOptions(sharePayload(), signal); assert.equal(short.text, '分享标题\n分享正文');
  const invalid = shareImage({ mimeType: 'image/gif' });
  const many = await model.shareFeedbackOptions(sharePayload({ text: '字'.repeat(2100), images: [invalid,invalid,invalid] }), signal);
  assert.equal(many.text.length, 2000); assert.ok(many.text.endsWith('另有 3 张图未附上')); assert.match(many.notice, /仅支持/);
});

test('share accepts one PNG/JPEG/WebP, reads only the first image, reports omitted images and checks actual file bytes', async t => {
  const requests = shareFilePorts(t, pngBytes), signal = new AbortController().signal;
  for (const [mimeType, bytes] of [['image/png',pngBytes],['image/jpeg',new Uint8Array([255,216,255,0])],['image/webp',new TextEncoder().encode('RIFF0000WEBP')]]) {
    globalThis.fetch = async (_url, init) => { requests.push(init); return new Response(bytes); };
    const options = await model.shareFeedbackOptions(sharePayload({ images: [shareImage({ mimeType })] }), signal);
    assert.ok(options.screenshot instanceof File); assert.equal(options.notice, undefined); assert.equal(options.text, '分享标题\n分享正文');
    assert.equal((await feedbackScreenshot(options.screenshot)).mimeType, mimeType);
  }
  const before = requests.length;
  const options = await model.shareFeedbackOptions(sharePayload({ text: '字'.repeat(2200), images: [shareImage(),shareImage(),shareImage()] }), signal);
  assert.equal(requests.length - before, 1); assert.equal(requests.at(-1).signal, signal);
  assert.equal(options.text.length, 2000); assert.ok(options.text.endsWith('另有 2 张图未附上'));
  const boundary = new Uint8Array(5*1024*1024); boundary.set(pngBytes);
  globalThis.fetch = async () => new Response(boundary);
  const exact = await model.shareFeedbackOptions(sharePayload({ images: [shareImage({ size: boundary.length })] }), signal);
  assert.equal(exact.screenshot.size, 5*1024*1024); assert.equal(exact.notice, undefined);
});

test('share rejects unsupported, oversized, empty, corrupt and unreadable screenshots with a visible sheet explanation', async t => {
  const requests = shareFilePorts(t, pngBytes), signal = new AbortController().signal;
  for (const [image, reason] of [[shareImage({ mimeType: 'image/gif' }), /仅支持/], [shareImage({ size: 5*1024*1024+1 }), /5MiB/]]) {
    const before = requests.length;
    const options = await model.shareFeedbackOptions(sharePayload({ images: [image] }), signal);
    assert.equal(options.screenshot, undefined); assert.match(options.notice, reason); assert.equal(requests.length, before);
    const f = uiDriver('FeedbackSheet', { scope: 'entry-scope', endpoint: '', token: '', options, context, queued: [], revision: 0, storageError: '', close() {}, submit: async () => assert.fail('must not submit') });
    t.after(() => f.stop()); assert.ok(f.text().includes(options.notice)); assert.equal(f.find(node => node.type === 'textarea').props.value, options.text);
  }
  for (const bytes of [new Uint8Array(0), new TextEncoder().encode('<svg/>'), new Uint8Array(5*1024*1024+1)]) {
    globalThis.fetch = async () => new Response(bytes);
    const options = await model.shareFeedbackOptions(sharePayload({ images: [shareImage()] }), signal);
    assert.equal(options.screenshot, undefined); assert.match(options.notice, /无法读取.*5MiB/);
  }
  globalThis.fetch = async () => new Response('', { status: 404 });
  const options = await model.shareFeedbackOptions(sharePayload({ images: [shareImage()] }), signal);
  assert.equal(options.screenshot, undefined); assert.match(options.notice, /无法读取/);
});

test('share sheet closes before opening feedback, never routes to chat and ignores cancelled preparation', async t => {
  const source = await componentSource('apps/mobile/src/features/intake/ShareSheet.tsx');
  let resolve, signal; const events = [], options = { text: '分享预填', notice: '分享图片未附上：截图最多 5MiB。' };
  const f = uiDriver('ShareSheet', { payload: sharePayload(), currentTitle: '当前', onCancel: () => events.push('closed'), onChoose: async () => assert.fail('no chat action') }, {
    shareText: model.shareText, Capacitor: model.Capacitor, shareFeedbackOptions: async (_payload, value) => { signal = value; return new Promise(done => { resolve = done; }); },
    openFeedback: value => events.push(value),
  }, source); t.after(() => f.stop());
  f.button('反馈问题').props.onClick(); assert.equal(f.button('反馈问题').props.disabled, true);
  resolve(options); await f.settle(); assert.deepEqual(events, ['closed', options]);
  events.length = 0; f.button('反馈问题').props.onClick();
  f.button('取消').props.onClick(); assert.equal(signal.aborted, true);
  resolve(options); await f.settle(); assert.deepEqual(events, ['closed']);
});
