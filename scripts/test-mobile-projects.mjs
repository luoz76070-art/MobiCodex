import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import ts from 'typescript';

const bundle = await build({ stdin: { contents: `export * from './apps/mobile/src/features/chat/runtime.ts'; export * from './apps/mobile/src/features/threads/model.ts'; export { composeMessageWithAttachments } from './apps/mobile/src/features/chat/attachments.ts'; export { apiPost, buildUrl, toFriendlyFetchError } from './apps/mobile/src/features/connection/http.ts'; export { ProjectGroups } from './apps/mobile/src/features/threads/ProjectGroups.tsx'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, nodePaths: [path.resolve('apps/mobile/node_modules')], logLevel: 'error' });
const module = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(module, module.exports, createRequire(import.meta.url));
const m = module.exports;
const app = await fs.readFile('apps/mobile/src/app/App.tsx', 'utf8');
const ast = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const transpile = text => ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
function productionFunction(name) {
  let found;
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node.getText(ast); ts.forEachChild(node, visit); }
  visit(ast); assert.ok(found, `production handler ${name}`); return found;
}
let shortcut;
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes('consumedShortcut.current')) shortcut = node.arguments[0].getText(ast);
  ts.forEachChild(node, visit);
}
visit(ast);
const code = transpile(['chooseNewThreadProject', 'requestNewThreadProject', 'startNewThread', 'editDraft', 'openNewThreadVoice', 'openUploadFiles', 'sendMessage', 'submitMessage', 'resolveSendRoute', 'uploadFiles', 'chooseIntakeShare'].map(productionFunction).join('\n') + `\nconst runShortcut = ${shortcut};`);
const tick = () => new Promise(resolve => setImmediate(resolve));

// Run the actual Workspace handlers; only React setters and network/native ports are synthetic.
function workspace({ current = null, project, draft = '', reject = false } = {}) {
  const requests = [], statuses = [], uploads = [], done = [];
  const e = { ...m, selected: current, selectedRef: { current }, threadState: { __new_thread__: { ...m.defaultRuntime(), newThreadCwd: project, draft } },
    newThreadId: '__new_thread__', activeThreadKey: current?.id ?? '__new_thread__', newThreadProjectRef: { current: project },
    projectChoiceRef: { current: null }, scopeAbortRef: { current: new AbortController() }, sendLockRef: { current: false },
    forceBottomRef: { current: false }, uploadInputRef: { current: { click() { uploads.push('picker'); } } },
    voiceRequestSequence: { current: 0 }, consumedShortcut: { current: null }, intakeShortcut: null,
    sending: false, relayStatus: null, canSend: true, canSubmitMessage: true, endpoint: 'synthetic', token: 'synthetic', approvalPolicy: 'never', sandboxMode: 'workspace-write',
    crypto: { randomUUID }, AbortController,
    setProjectPicker(value) { e.picker = value; }, setVoiceOpenRequest(value) { e.voice = value; }, setSidebarOpen() {},
    setStatus(value) { statuses.push(value); }, setSubmittingMessage() {}, setUploading() {},
    onSelectSession(id) { e.selected = id === e.newThreadId ? null : e.created; e.selectedRef.current = e.selected; e.activeThreadKey = id; return true; },
    patchRuntime(id, patch) { e.threadState[id] = { ...(e.threadState[id] ?? m.defaultRuntime()), ...patch }; e.activeRuntime = e.threadState[e.activeThreadKey]; },
    updateRuntime(id, update) { e.threadState[id] = update(e.threadState[id] ?? m.defaultRuntime()); e.activeRuntime = e.threadState[e.activeThreadKey]; },
    removeRuntime(id) { delete e.threadState[id]; }, setSelectedDetails(value) { e.created = value; }, setThreads() {}, loadThreads: async () => {}, attentionAfterSend: async () => {},
    capMessages: messages => messages, mergeMessagesById: (a, b) => [...a, ...b], turnStatusText: value => value,
    attachmentSummaryText: () => 'synthetic attachment', resultStatus: () => null, readActivityEvidence: () => null,
    async apiPost(url, token, body) {
      requests.push({ url, body });
      if (typeof reject === 'function') await reject();
      if (reject) throw Object.assign(new Error('这个项目在电脑上找不到了，请重新选择'), { status: 400, code: 'unknown_project' });
      return { threadId: 'synthetic-created', turnId: 'synthetic-turn', status: 'inProgress', messages: [], approvals: [], eventCount: 0 };
    },
    async uploadAttachments(_endpoint, _token, files) { uploads.push('upload'); return files.map((file, i) => ({ id: `synthetic-attachment-${i}`, fileName: file.name })); },
    refreshRelayStatus: async () => {}, revokeAttachmentPreviews() {},
    shareFiles: async () => [], shareText: value => value.text, intakeShare: { id: 'synthetic-share', text: 'synthetic shared draft' },
    onShareDone(id) { done.push(id); }, onShortcutOpened(id) { done.push(id); }, onCaptureIntake() {},
  };
  e.activeRuntime = e.threadState[e.activeThreadKey] ?? m.defaultRuntime();
  vm.createContext(e); vm.runInContext(code, e);
  return { e, requests, statuses, uploads, done, get runtime() { return e.threadState.__new_thread__; },
    async choose(cwd = '/synthetic/project-a') { e.chooseNewThreadProject(cwd); await tick(); },
    async send() { await e.sendMessage(); },
  };
}

test('top-level new asks for a project, defaults to current session, and sends A after selected becomes null', async () => {
  const f = workspace({ current: { id: 'old', cwd: '/synthetic/project-a' } });
  const pending = f.e.startNewThread();
  assert.equal(f.e.picker, '/synthetic/project-a'); assert.equal(f.requests.length, 0);
  await f.choose(); assert.equal(await pending, true); assert.equal(f.e.selected, null);
  f.e.editDraft('synthetic task'); await f.send();
  assert.equal(f.requests[0].body.cwd, '/synthetic/project-a'); assert.equal(f.requests[0].body.threadId, undefined);
  assert.equal(f.e.created.cwd, '/synthetic/project-a');
});

test('a known project starts directly and keeps the draft; project groups have no new-session buttons of their own', async () => {
  const f = workspace({ draft: 'keep this draft' }); await f.e.startNewThread('/synthetic/project-a');
  assert.equal(f.e.picker, undefined); assert.equal(f.runtime.draft, 'keep this draft');
  await f.send(); assert.equal(f.requests[0].body.cwd, '/synthetic/project-a');
  const html = m.renderToStaticMarkup(m.createElement(m.ProjectGroups, { scope: 'synthetic', agentId: 'codex', search: '', groups: [{ key: '/synthetic/project-a', label: 'project-a', items: [], detail: '' }], children() {} }));
  assert.doesNotMatch(html, /新建/);
  assert.doesNotMatch(app, /onNewThread/);
});

test('blank text and voice transcription drafts require a project before sending', async () => {
  for (const draft of ['synthetic typed draft', 'synthetic voice transcript']) {
    const f = workspace(); f.e.editDraft(draft);
    assert.equal(f.e.picker, ''); assert.equal(f.runtime.draft, draft);
    await f.send(); assert.equal(f.requests.length, 0);
    await f.choose(); await f.send(); assert.equal(f.requests[0].body.cwd, '/synthetic/project-a');
  }
  assert.match(app, /onDraft=\{editDraft\}/);
});

test('voice and attachment buttons choose a project before opening native inputs', async () => {
  const voice = workspace(), pendingVoice = voice.e.openNewThreadVoice();
  assert.equal(voice.e.voice, undefined); await voice.choose(); await pendingVoice; assert.equal(voice.e.voice, 1);
  voice.e.editDraft('synthetic transcript'); await voice.send(); assert.equal(voice.requests[0].body.cwd, '/synthetic/project-a');
  const f = workspace(), pending = f.e.openUploadFiles(); assert.equal(f.uploads.length, 0);
  await f.choose(); await pending; assert.deepEqual(f.uploads, ['picker']);
  await f.e.uploadFiles([{ name: 'synthetic.txt' }]); await f.send(); assert.equal(f.requests[0].body.cwd, '/synthetic/project-a');
});

test('attachment-only intake cannot upload until selection, and cancelling leaves its draft untouched', async () => {
  const f = workspace({ draft: 'keep me' }), pending = f.e.uploadFiles([{ name: 'synthetic.txt' }]);
  assert.equal(f.e.picker, ''); assert.equal(f.uploads.length, 0);
  await f.choose(null); assert.equal(await pending, false); assert.equal(f.runtime.draft, 'keep me'); assert.equal(f.requests.length, 0);
});

test('new-task share waits for selection and sends its chosen cwd with the preserved share draft', async () => {
  const f = workspace(), pending = f.e.chooseIntakeShare('new-task', new AbortController().signal);
  await tick(); assert.equal(f.e.picker, ''); assert.equal(f.done.length, 0);
  await f.choose(); await pending; assert.equal(f.runtime.draft, 'synthetic shared draft');
  assert.equal(f.requests.length, 0); await f.send(); assert.equal(f.requests[0].body.cwd, '/synthetic/project-a');
});

test('new-task and voice shortcuts wait for selection, run once, and send the chosen project', async () => {
  for (const target of ['new-task', 'voice']) {
    const f = workspace(); f.e.intakeShortcut = { id: 1, payload: { target } };
    vm.runInContext('runShortcut()', f.e); assert.equal(f.e.picker, ''); assert.equal(f.done.length, 0);
    vm.runInContext('runShortcut()', f.e); await f.choose(); assert.deepEqual(f.done, [1]);
    assert.equal(f.e.voice, target === 'voice' ? 1 : 0);
    f.e.editDraft('synthetic shortcut draft'); await f.send(); assert.equal(f.requests[0].body.cwd, '/synthetic/project-a');
  }
});

test('unknown_project reopens selection, keeps text and attachments and resets the rejected submission identity', async () => {
  const f = workspace({ project: '/synthetic/project-a', draft: 'preserve this task', reject: true });
  f.runtime.attachments = [{ id: 'synthetic-attachment', fileName: 'synthetic.txt', path: '/synthetic/file' }];
  await f.send();
  assert.equal(f.runtime.draft, 'preserve this task'); assert.equal(f.runtime.attachments.length, 1);
  assert.equal(f.runtime.newThreadCwd, undefined); assert.equal(f.runtime.pendingMessageId, undefined);
  assert.equal(f.runtime.messages.length, 0); assert.equal(f.e.picker, '');
  assert.equal(f.runtime.lastTurnError, '这个项目在电脑上找不到了，请重新选择');
});

test('unknown_project preserves edits and attachments added while the request is pending', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const f = workspace({ project: '/synthetic/project-a', draft: '  original draft  ', reject: () => pending });
  f.runtime.attachments = [{ id: 'first', fileName: 'first.txt' }];
  const sending = f.send(); await tick();
  f.e.editDraft('new draft'); f.runtime.attachments = [{ id: 'second', fileName: 'second.txt' }];
  release(); await sending;
  assert.equal(f.runtime.draft, '  original draft  \n\nnew draft');
  assert.deepEqual(Array.from(f.runtime.attachments, item => item.id), ['first', 'second']);
  assert.equal(f.runtime.messages.length, 0);
});

test('project selection survives scoped draft cache reload, even before text is entered', () => {
  const values = new Map(), previous = globalThis.localStorage;
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  try {
    assert.equal(m.saveThreadRuntimeCache({ __new_thread__: { ...m.defaultRuntime(), newThreadCwd: '/synthetic/project-a' } }, 'synthetic').status, 'saved');
    assert.equal(m.loadThreadRuntimeCache('synthetic').__new_thread__.newThreadCwd, '/synthetic/project-a');
    assert.equal(m.loadThreadRuntimeCache('other').__new_thread__, undefined);
  } finally { globalThis.localStorage = previous; }
});

test('HTTP unknown_project has the exact friendly message and machine-readable code', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: 'unknown_project' }), { status: 400, headers: { 'Content-Type': 'application/json' } }));
  await assert.rejects(m.apiPost('https://synthetic.invalid/api/live/turns', 'synthetic', {}), error => error.code === 'unknown_project' && error.message === '这个项目在电脑上找不到了，请重新选择');
});

test('new-thread header and voice context use the persisted project', () => {
  assert.match(app, /const workspaceCwd = selected\?\.cwd \|\| \(isNewThread \? activeRuntime.newThreadCwd/);
  assert.match(app, /project=\{workspaceProject\}/);
  assert.match(app, /context=\{\{ cwd: workspaceCwd/);
  assert.match(app, /onUpload=\{\(\) => void openUploadFiles\(\)\}/);
  assert.match(app, /onClick=\{\(\) => void openNewThreadVoice\(\)\}/);
});

// Execute the real picker with hook/UI ports; requests and lifecycle remain observable.
const pickerSource = await fs.readFile('apps/mobile/src/features/threads/NewThreadProjectPicker.tsx', 'utf8');
const pickerAst = ts.createSourceFile('Picker.tsx', pickerSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const pickerBody = pickerAst.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(pickerAst)).join('\n').replace('export function NewThreadProjectPicker', 'function NewThreadProjectPicker').replace(/^export type /gm, 'type ');
const pickerCode = ts.transpileModule(pickerBody, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText;
function pickerFixture(initialCwd = '', response = async () => ({ projects: [{ name: 'project-a', cwd: '/synthetic/project-a' }] })) {
  const slots = [], effects = [], calls = [], chosen = [];
  let cursor = 0, tree, dirty, cancelled = 0;
  const props = { endpoint: 'https://synthetic.invalid', token: 'synthetic', initialCwd, onChoose: cwd => chosen.push(cwd), onCancel: () => cancelled++ };
  const useRef = value => slots[cursor++] ??= { current: value };
  const useState = value => {
    const i = cursor++; slots[i] ??= { value };
    return [slots[i].value, update => { const next = typeof update === 'function' ? update(slots[i].value) : update; dirty ||= slots[i].value !== next; slots[i].value = next; }];
  };
  const useEffect = (setup, deps) => {
    const i = cursor++, previous = slots[i];
    if (!previous || deps.some((value, j) => value !== previous.deps[j])) effects.push(() => { previous?.cleanup?.(); slots[i] = { deps, cleanup: setup() }; });
  };
  const apiGet = async (url, token, signal) => { calls.push({ url, token, signal }); return response(); };
  const h = (type, props, ...children) => ({ type, props: { ...props, children } });
  const Component = new Function('useRef', 'useState', 'useEffect', 'useBackLayer', 'apiGet', 'buildUrl', 'toFriendlyFetchError', 'document', 'HTMLElement', 'h', `${pickerCode}; return NewThreadProjectPicker;`)(useRef, useState, useEffect, () => {}, apiGet, m.buildUrl, String, { activeElement: null }, class {}, h);
  function render() {
    do { dirty = false; cursor = 0; tree = Component(props); for (const setup of effects.splice(0)) setup(); } while (dirty);
    return tree;
  }
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props.children)] : [];
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : node ?? '';
  render();
  return { calls, chosen, get cancelled() { return cancelled; },
    async settle() { render(); await tick(); render(); },
    projects() { return nodes(render()).filter(node => node.type === 'button' && node.props['data-cwd']); },
    button(label) { return nodes(render()).find(node => node.type === 'button' && text(node) === label); },
    text: () => text(render()), stop() { for (const slot of slots) slot?.cleanup?.(); },
    escape() { render().props.onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation() {} }); },
  };
}

test('picker lists the authenticated catalog with the current project first and chooses only on tap', async () => {
  const catalog = async () => ({ projects: [{ name: 'project-b', cwd: '/synthetic/project-b' }, { name: 'project-a', cwd: '/synthetic/project-a' }] });
  for (const initial of ['/synthetic/project-a', '/synthetic/missing', '']) {
    const f = pickerFixture(initial, catalog); await f.settle();
    assert.equal(f.calls[0].url, 'https://synthetic.invalid/api/projects'); assert.equal(f.calls[0].token, 'synthetic');
    const rows = f.projects();
    assert.deepEqual(rows.map(row => row.props['data-cwd']), initial === '/synthetic/project-a' ? ['/synthetic/project-a', '/synthetic/project-b'] : ['/synthetic/project-b', '/synthetic/project-a']);
    assert.deepEqual(rows.map(row => row.props['aria-current']), initial === '/synthetic/project-a' ? ['true', undefined] : [undefined, undefined]);
    assert.equal(f.chosen.length, 0, 'nothing is chosen before a tap');
    rows.find(row => row.props['data-cwd'] === '/synthetic/project-a').props.onClick();
    assert.deepEqual(f.chosen, ['/synthetic/project-a']); f.stop();
  }
});

test('picker retries failures and empty catalogs; cancellation and unmount abort stale loads', async () => {
  let attempts = 0;
  const f = pickerFixture('', async () => { if (++attempts === 1) throw new Error('synthetic unavailable'); return { projects: attempts === 2 ? [] : [{ name: 'project-a', cwd: '/synthetic/project-a' }] }; });
  await f.settle(); assert.match(f.text(), /synthetic unavailable/); assert.equal(f.projects().length, 0);
  f.button('重新读取项目').props.onClick(); await f.settle();
  assert.match(f.text(), /电脑上没有可用项目/); assert.equal(f.projects().length, 0);
  f.button('重新读取项目').props.onClick(); await f.settle(); assert.equal(f.projects().length, 1); assert.equal(f.chosen.length, 0);
  f.escape(); assert.equal(f.cancelled, 1); f.stop(); assert.ok(f.calls.every(call => call.signal.aborted));
  let finish;
  const late = pickerFixture('', () => new Promise(resolve => { finish = resolve; }));
  late.stop(); finish({ projects: [{ name: 'late', cwd: '/synthetic/late' }] }); await late.settle();
  assert.equal(late.chosen.length, 0); assert.ok(late.calls[0].signal.aborted);
});
