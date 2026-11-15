import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import ts from 'typescript';
import { voiceInputDriver } from './helpers/voice-input-driver.mjs';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-intake-'));
test.after(() => fs.rm(dir, { recursive: true, force: true }));
await build({
  stdin: { contents: `export * from './apps/mobile/src/features/intake/plugin'; export { ShareSheet } from './apps/mobile/src/features/intake/ShareSheet'; export { Capacitor } from '@capacitor/core'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server';`, resolveDir: process.cwd(), loader: 'ts' },
  outfile: path.join(dir, 'intake.cjs'), bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', nodePaths: [path.resolve('apps/mobile/node_modules')], logLevel: 'error',
});
const m = createRequire(import.meta.url)(path.join(dir, 'intake.cjs'));
const app = await fs.readFile('apps/mobile/src/app/App.tsx', 'utf8');
const capture = await fs.readFile('apps/mobile/src/features/capture/CapturePanel.tsx', 'utf8');
const hook = await fs.readFile('apps/mobile/src/features/intake/useIntake.ts', 'utf8');
const ast = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const payload = (extra = {}) => ({ id: 'share-1', text: '正文 https://example.test/', subject: '标题', images: [], skipped: 0, ...extra });
const photo = { path: '/cache/share/photo.png', name: '截图.png', mimeType: 'image/png', size: 3 };
const tick = () => new Promise(resolve => setImmediate(resolve));
const transpile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText;
function findFunction(name) {
  let result;
  function visit(node) { if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(ast); ts.forEachChild(node, visit); }
  visit(ast); assert.ok(result, `production ${name}`); return result;
}

test('plugin contract and availability: native Intake only; subject is added once', () => {
  assert.equal(m.intakeAvailable(), false);
  assert.equal(m.shareText(payload()), '标题\n正文 https://example.test/');
  assert.equal(m.shareText(payload({ text: '  已有标题\n正文  ' })), '已有标题\n正文');
  assert.equal(m.shareText(payload({ text: null, subject: '  标题  ' })), '标题');
  assert.equal(m.shareText(payload({ text: ' 文本 ', subject: null })), '文本');
  assert.equal(m.shareText(payload({ text: null, subject: null })), '');
});

test('shareFiles converts the native path, preserving bytes, file name, MIME and image order', async t => {
  const previous = m.Capacitor.convertFileSrc;
  m.Capacitor.convertFileSrc = file => `http://localhost/_capacitor_file_${file}`;
  t.after(() => { m.Capacitor.convertFileSrc = previous; });
  const urls = [], files = await m.shareFiles(payload({ images: [photo, { ...photo, name: 'second.jpg', mimeType: 'image/jpeg' }] }), async url => {
    urls.push(url); return new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'application/octet-stream' } });
  });
  assert.deepEqual(urls, Array(2).fill('http://localhost/_capacitor_file_/cache/share/photo.png'));
  assert.deepEqual(files.map(file => [file.name, file.type, file.size]), [['截图.png', 'image/png', 3], ['second.jpg', 'image/jpeg', 3]]);
  assert.deepEqual([...new Uint8Array(await files[0].arrayBuffer())], [1, 2, 3]);
  await assert.rejects(m.shareFiles(payload({ images: [photo] }), async () => new Response('', { status: 404 })), /无法读取分享图片/);
});

test('ShareSheet renders the three destinations, disabled current thread, preview and skipped explanation', () => {
  const render = currentTitle => m.renderToStaticMarkup(m.createElement(m.ShareSheet, { payload: payload({ images: [photo], skipped: 2 }), currentTitle, onChoose() {}, onCancel() {} }));
  const html = render(null);
  assert.match(html, /分享到 MobiCodex/);
  assert.match(html, /disabled="">发给当前线程/);
  assert.match(html, /请先打开一个线程/);
  for (const text of ['开新任务', '存成事项卡', '取消', '另有 2 项没收下（只收 9 张以内的图片，单张不超过 25MB）', '由你确认后发送']) assert.ok(html.includes(text));
  assert.match(html, /alt="截图.png"/);
  assert.match(render('项目讨论'), /发给当前线程「项目讨论」/);
  assert.doesNotMatch(render('项目讨论'), /请先打开一个线程/);
});

// Execute actual App handler bodies with synthetic state and upload ports; no model or real threads.
function shareDriver(seed = payload(), upload = async () => []) {
  let intakeShare = seed;
  const states = { current: { draft: '已有草稿', attachments: [] }, new: { draft: '旧新任务草稿', attachments: [] } };
  const selected = { id: 'current' }, activeThreadKey = selected.id, newThreadId = 'new';
  const scopeAbortRef = { current: new AbortController() }, uploadInputRef = { current: null };
  const done = [], captured = [], statuses = [];
  const updateRuntime = (key, update) => { states[key] = update(states[key]); };
  const uploadAttachments = upload, endpoint = 'synthetic', token = 'synthetic';
  const setStatus = text => statuses.push(text), setUploading = () => {}, setSelected = () => {}, setIsNewThread = () => {};
  const refreshRelayStatus = async () => {}, revokeAttachmentPreviews = () => {}, toFriendlyFetchError = String;
  const shareFiles = async value => value.images.map(image => new File(['image'], image.name, { type: image.mimeType })), shareText = m.shareText;
  const startNewThread = () => { states.new = { draft: '', attachments: [] }; };
  const onCaptureIntake = draft => captured.push(draft), onShareDone = id => { done.push(id); intakeShare = null; };
  const create = new Function('ports', `with (ports) { ${transpile(findFunction('uploadFiles'))} ${transpile(findFunction('chooseIntakeShare'))} return chooseIntakeShare; }`);
  const choose = create({ get intakeShare() { return intakeShare; }, selected, activeThreadKey, newThreadId, scopeAbortRef, uploadInputRef, updateRuntime, uploadAttachments, endpoint, token, setStatus, setUploading, setSelected, setIsNewThread, refreshRelayStatus, revokeAttachmentPreviews, toFriendlyFetchError, shareFiles, shareText, startNewThread, onCaptureIntake, onShareDone });
  return { states, done, captured, statuses, choose: (action, signal = new AbortController().signal) => choose(action, signal), dispose: () => scopeAbortRef.current.abort() };
}

test('current/new shares only append drafts and attachments, with a blank line and no send', async () => {
  const attachment = { id: 'upload' }, driver = shareDriver(payload({ images: [photo] }), async () => [attachment]);
  await driver.choose('current');
  assert.equal(driver.states.current.draft, '已有草稿\n\n标题\n正文 https://example.test/');
  assert.deepEqual(driver.states.current.attachments, [attachment]);
  assert.deepEqual(driver.done, ['share-1']);
  const fresh = shareDriver(); await fresh.choose('new-task');
  assert.equal(fresh.states.new.draft, '标题\n正文 https://example.test/');
  assert.equal(fresh.states.current.draft, '已有草稿');
  assert.doesNotMatch(findFunction('chooseIntakeShare'), /sendMessage|sendDesktopMessage|apiPost|\/turns/);
});

test('capture destination hands local Files and text to initialDraft without upload or send', async () => {
  const driver = shareDriver(payload({ images: [photo] }), () => { assert.fail('no chat upload for capture'); });
  await driver.choose('capture');
  assert.equal(driver.captured[0].key, 'share-1');
  assert.equal(driver.captured[0].detail, '标题\n正文 https://example.test/');
  assert.equal(driver.captured[0].files[0].name, '截图.png');
  assert.deepEqual(driver.done, ['share-1']);
});

test('upload failure, cancellation and scope disposal keep drafts unchanged and do not finish/clear', async () => {
  const failed = shareDriver(payload({ images: [photo] }), async () => { throw new Error('offline'); });
  await assert.rejects(failed.choose('current'), /附件未能上传/);
  assert.equal(failed.states.current.draft, '已有草稿'); assert.deepEqual(failed.done, []);
  let release;
  const driver = shareDriver(payload({ images: [photo] }), () => new Promise(resolve => { release = resolve; }));
  const controller = new AbortController(), pending = driver.choose('current', controller.signal);
  await tick(); controller.abort(); release([]);
  await assert.rejects(pending, /附件未能上传|abort/i);
  assert.equal(driver.states.current.draft, '已有草稿'); assert.deepEqual(driver.done, []);
  const disposed = shareDriver(); disposed.dispose();
  await assert.rejects(disposed.choose('current'), /abort/i);
  assert.equal(disposed.states.current.draft, '已有草稿');
});

test('useIntake registers exact event names once, uses fresh callbacks and removes late listener handles', async () => {
  const hooks = [], effects = [], listeners = new Map(), events = [], cleared = [];
  let cursor = 0, registrations = 0, removed = 0, resolveLate;
  const useRef = value => hooks[cursor++] ??= { current: value };
  const useEffect = fn => { const i = cursor++; if (!hooks[i]) { hooks[i] = {}; effects.push(fn); } };
  const Intake = {
    addListener(name, callback) { registrations++; listeners.set(name, callback); return name === 'share' ? Promise.resolve({ remove() { removed++; } }) : new Promise(resolve => { resolveLate = resolve; }); },
    async clear(value) { cleared.push(value); },
  };
  const hookAst = ts.createSourceFile('useIntake.ts', hook, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const body = hookAst.statements.find(n => ts.isFunctionDeclaration(n)).getText(hookAst).replace(/^export /, '');
  const useIntake = new Function('useRef', 'useEffect', 'Intake', 'intakeAvailable', transpile(body) + ';return useIntake;')(useRef, useEffect, Intake, () => true);
  useIntake({ onShare: () => events.push('old'), onShortcut: () => {} });
  const cleanup = effects[0]();
  listeners.get('share')(payload());
  cursor = 0; useIntake({ onShare: value => events.push(value.id), onShortcut: value => events.push(value.target) });
  listeners.get('share')(payload({ id: 'new' })); listeners.get('shortcut')({ target: 'voice' });
  assert.deepEqual(events, ['old', 'new', 'voice']); assert.equal(registrations, 2); assert.deepEqual(cleared, [{}]);
  await tick(); cleanup(); resolveLate({ remove() { removed++; } }); await tick();
  assert.equal(removed, 2);
  listeners.get('share')(payload()); assert.equal(events.length, 3);
});

test('voice shortcut requests open the existing panel and can be repeated without starting recording', t => {
  const driver = voiceInputDriver({ api: {}, recovery: {}, findMissingVoiceDetails: () => [] }); t.after(() => driver.unmount());
  driver.render({ openRequest: 1 }); assert.ok(driver.button('开始录音'));
  driver.click('关闭语音输入'); assert.equal(driver.button('开始录音'), undefined);
  driver.render({ openRequest: 1 }); assert.equal(driver.button('开始录音'), undefined);
  driver.render({ openRequest: 2 }); assert.ok(driver.button('开始录音'));
});

test('App wiring: outer listener, exact cache cleanup, shared notification route, shortcut counter and deduplicated recent threads', () => {
  assert.match(app, /useIntake\(\{/);
  assert.match(app, /onShare: payload => \{\s*setAgentMode\(false\); setCaptureOpen\(false\); setItemsOpen\(false\)/);
  assert.match(app, /Intake\.clear\(\{ id \}\)/);
  assert.match(app, /<CapturePanel initialDraft=\{initialDraft\}/);
  assert.match(app, /parseAttentionKey\(payload\.key \?\? ""\)/);
  assert.match(app, /openFromNotification\(\{ \.\.\.target, title: payload\.title/);
  assert.match(app, /startNewThread\(\);\s*if \(intakeShortcut.target === "voice"\) setVoiceOpenRequest\(\+\+voiceRequestSequence.current\)/);
  assert.match(app, /<VoiceInput openRequest=\{voiceOpenRequest\}/);
  assert.match(app, /sort\(.*updatedAt.*\)\.slice\(0, 3\)/);
  assert.match(app, /key: codexAttentionKey\(thread.id, isDesktopSource\(thread\)\)/);
  assert.match(app, /if \(recentThreadsRef.current === serialized\) return/);
  assert.match(app, /Intake\.setRecentThreads\(\{ threads: recent \}\)/);
  assert.match(capture, /itemUid \|\| item \|\| tx.current/);
  assert.match(capture, /appliedInitialDrafts.current.has\(initialDraft.key\)/);
});

function componentDriver(source, name, ports, initialProps) {
  const treeAst = ts.createSourceFile(`${name}.tsx`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = treeAst.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(treeAst)).join('\n').replace(`export function ${name}`, `function ${name}`).replace(/^export type /gm, 'type ');
  const slots = [], effects = [], handlers = new Map();
  let cursor = 0, dirty = true, tree;
  const props = { ...initialProps };
  const useRef = value => slots[cursor++] ??= { current: value };
  const useState = initial => {
    const i = cursor++; slots[i] ??= { value: typeof initial === 'function' ? initial() : initial };
    return [slots[i].value, update => { const next = typeof update === 'function' ? update(slots[i].value) : update; dirty ||= slots[i].value !== next; slots[i].value = next; }];
  };
  const useMemo = (fn, deps) => { const i = cursor++; if (!slots[i] || deps.some((v, j) => v !== slots[i].deps[j])) slots[i] = { value: fn(), deps }; return slots[i].value; };
  const useEffect = (fn, deps) => { const i = cursor++, old = slots[i]; if (!old || deps.some((v, j) => v !== old.deps[j])) effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; }); };
  const h = (type, props, ...children) => ({ type, props: { ...props, children } });
  const defaults = { useRef, useState, useMemo, useEffect, h, Fragment: 'fragment', createPortal: value => value,
    document: { body: {}, activeElement: null }, HTMLElement: class {}, navigator: { onLine: true },
    window: { addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener: name => handlers.delete(name) },
  };
  const dependencies = { ...defaults, ...ports };
  const Component = new Function(...Object.keys(dependencies), transpile(body) + `;return ${name};`)(...Object.values(dependencies));
  const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props.children) : node ?? '';
  const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props.children)] : [];
  function render(patch = {}) {
    Object.assign(props, patch);
    let attempts = 0;
    do { assert.ok(++attempts < 20, 'settled render'); dirty = false; cursor = 0; tree = Component(props); for (const run of effects.splice(0)) run(); } while (dirty);
    return tree;
  }
  const driver = { render, props, text: () => text(render()), nodes: () => nodes(render()),
    button(label) { return nodes(render()).find(node => node.type === 'button' && text(node) === label); },
    click(label) { const button = driver.button(label); assert.ok(button && !button.props.disabled, label); button.props.onClick({}); render(); },
    back() { const event = new Event('product-back', { cancelable: true }); handlers.get('product-back')?.(event); return event; },
    stop() { for (const slot of slots) slot?.cleanup?.(); },
  };
  render(); return driver;
}

test('ShareSheet back/escape/cancel abort pending work and never choose a destination', async t => {
  const source = await fs.readFile('apps/mobile/src/features/intake/ShareSheet.tsx', 'utf8');
  let cancelled = 0, chosen = 0, signal;
  const driver = componentDriver(source, 'ShareSheet', { shareText: m.shareText, Capacitor: m.Capacitor }, {
    payload: payload(), currentTitle: '当前', onCancel: () => cancelled++, onChoose: async (_action, value) => { chosen++; signal = value; await new Promise(() => {}); },
  });
  t.after(() => driver.stop());
  assert.equal(driver.back().defaultPrevented, true); assert.equal(cancelled, 1); assert.equal(chosen, 0);
  driver.click('取消'); assert.equal(cancelled, 2); assert.equal(chosen, 0);
  driver.nodes().find(node => node.type === 'section').props.onKeyDown({ key: 'Escape', preventDefault() {} });
  assert.equal(cancelled, 3); assert.equal(chosen, 0);
  driver.click('开新任务'); assert.equal(chosen, 1); assert.equal(signal.aborted, false);
  driver.back(); assert.equal(signal.aborted, true); assert.equal(cancelled, 4);
});

function captureDriver(initialDraft, extra = {}, failFirst = false) {
  const calls = [], stored = new Map(); let failed = false;
  const client = {
    async list() { return { storeId: 'fixture-store', items: [], nextCursor: null }; },
    async request(route, method, body) {
      calls.push({ route, method, body: structuredClone(body) });
      const item = { ...body, state: 'todo', revision: 1, source: { kind: 'manual' }, currentAttempt: { delivery: 'none' } };
      stored.set(body.uid, item);
      if (failFirst && !failed) { failed = true; throw new Error('lost response'); }
      return { storeId: 'fixture-store', item };
    },
    async get(uid) { return { storeId: 'fixture-store', item: stored.get(uid) ?? { uid, title: '已有标题', detail: '已有说明', state: 'todo', revision: 1, assets: [], currentAttempt: { delivery: 'none' } } }; },
  };
  const ports = { VoiceInput: 'voice', ItemHandoff: 'handoff', ItemStateActions: 'state-actions', useDeviceRevoked: () => false, deviceRevokedMessage: 'revoked',
    captureApi: () => client, useCaptureVoice: () => ({}), voiceDraftHash: async () => '', canvasPreview() {}, captureTransaction() { assert.fail('text share must not masquerade as voice/image'); } };
  return { ...componentDriver(capture, 'CapturePanel', ports, { endpoint: 'synthetic', token: 'synthetic', scope: 'fixture', open: true, initialDraft, onClose() {}, onOpenTarget() {}, ...extra }), calls };
}

test('CapturePanel initialDraft applies once per key, only for new items, retaining File objects', async t => {
  const file = new File(['image'], 'one.png', { type: 'image/png' }), initialDraft = { key: 'capture-key', detail: '分享说明', files: [file] };
  const driver = captureDriver(initialDraft); t.after(() => driver.stop());
  const detail = () => driver.nodes().find(node => node.props['aria-label'] === '事项说明').props.value;
  assert.equal(detail(), '分享说明'); assert.equal(driver.text().split('one.png').length - 1, 1);
  driver.render({ initialDraft: { ...initialDraft }, open: false }); driver.render({ open: true });
  assert.equal(detail(), '分享说明'); assert.equal(driver.text().split('one.png').length - 1, 1);
  driver.render({ initialDraft: { ...initialDraft, key: 'another-key', detail: '第二份', files: [] } });
  assert.equal(detail(), '分享说明\n\n第二份');
  const editing = captureDriver(initialDraft, { itemUid: 'saved' }); t.after(() => editing.stop());
  await tick(); editing.render();
  assert.equal(editing.nodes().find(node => node.props['aria-label'] === '事项说明').props.value, '已有说明');
  assert.doesNotMatch(editing.text(), /one.png/);
});

test('text-only shares use the existing manual work item API, with stable IDs on uncertain retry and readback', async t => {
  const driver = captureDriver({ key: 'text', detail: '来自分享的说明\nhttps://example.test/', files: [] }, {}, true);
  t.after(() => driver.stop());
  driver.click('保存事项'); await tick(); driver.render();
  assert.match(driver.text(), /lost response/);
  driver.click('重试保存并核对'); await tick(); driver.render();
  assert.match(driver.text(), /事项已保存 · 待处理/);
  assert.equal(driver.calls.length, 2); assert.deepEqual(driver.calls[0].body, driver.calls[1].body);
  assert.equal(driver.calls[0].route, '/api/work-items');
  assert.equal(driver.calls[0].body.expectedRevision, 0); assert.equal(driver.calls[0].body.detail, '来自分享的说明\nhttps://example.test/');
  assert.equal(driver.calls[0].body.capture, undefined); assert.deepEqual(driver.calls[0].body.assets, []);
});

test('recent thread shortcuts follow updated time and skip equivalent list refreshes', async () => {
  let callback;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect' && node.arguments[0]?.getText(ast).includes('Intake.setRecentThreads')) callback = node.arguments[0].getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(callback);
  const calls = [], recentThreadsRef = { current: '' }, threads = [
    { id: 'old', updatedAt: '2026-11-10T00:00:00Z' },
    { id: 'live', threadName: '手机任务', updatedAt: '2026-11-15T00:00:00Z' },
    { id: 'desktop', threadName: '桌面任务', desktop: true, updatedAt: '2026-11-14T00:00:00Z' },
    { id: 'third', updatedAt: '2026-11-13T00:00:00Z' },
  ];
  const run = new Function('threads', 'recentThreadsRef', 'intakeAvailable', 'Intake', 'codexAttentionKey', 'isDesktopSource', `return (${transpile('const run = ' + callback).replace(/^const run = /, '').replace(/;\s*$/, '')})();`);
  const update = () => run(threads, recentThreadsRef, () => true, { async setRecentThreads(value) { calls.push(value); } }, (id, desktop) => `${desktop ? 'desktop' : 'live'}:${id}`, thread => thread.desktop === true);
  update(); update(); await tick();
  assert.equal(calls.length, 1); assert.deepEqual(calls[0].threads, [
    { key: 'live:live', title: '手机任务' }, { key: 'desktop:desktop', title: '桌面任务' }, { key: 'live:third', title: '线程' },
  ]);
  threads[0].updatedAt = '2026-11-16T00:00:00Z'; update(); await tick();
  assert.equal(calls.length, 2); assert.equal(calls[1].threads[0].key, 'live:old');
  assert.match(app, /if \(selected && !intakeShortcut && !handoffTarget\) void openThread\(selected\)/, 'cached selection must not replace a cold-start shortcut');
  assert.match(app, /if \(event.defaultPrevented \|\| intakeShares.length\) return/, 'the share sheet receives back before underlying sheets');
});
