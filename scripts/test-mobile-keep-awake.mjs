import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

await fs.mkdir('output/f5', { recursive: true });
const temp = await fs.mkdtemp(path.resolve('output/f5/mobile-'));
test.after(() => fs.rm(temp, { recursive: true, force: true }));
await build({ entryPoints: ['apps/mobile/src/features/connection/keepAwakeStatus.ts', 'apps/mobile/src/features/connection/connectionStatus.ts'], outdir: temp, bundle: true, platform: 'node', format: 'esm', outExtension: { '.js': '.mjs' } });
const { keepAwakeLabel } = await import(pathToFileURL(path.join(temp, 'keepAwakeStatus.mjs')).href);
const model = await import(pathToFileURL(path.join(temp, 'connectionStatus.mjs')).href);
const source = await fs.readFile('apps/mobile/src/features/connection/ConnectionCard.tsx', 'utf8');
const ast = ts.createSourceFile('ConnectionCard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const body = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ConnectionCard').getText(ast).replace('export function', 'function');
const js = ts.transpileModule(body, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
function card(read) {
  const slots = [], effects = [], requests = []; let cursor = 0;
  const props = { endpoint: 'synthetic', token: 'synthetic', connectionState: 'ok', open: true };
  const hooks = {
    ...model, keepAwakeLabel, React: { createElement: (type, props, ...children) => ({ type, props, children }) },
    useRef(value) { return slots[cursor++] ??= { current: value }; },
    useState(value) { const index = cursor++; slots[index] ??= { value }; return [slots[index].value, next => { slots[index].value = next; }]; },
    useEffect(setup, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((value, i) => value !== old.deps[i])) { effects.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: setup() }; }); } },
    buildUrl: (endpoint, route) => endpoint + route,
    apiGet: (url, token, signal) => { requests.push({ url, token, signal }); return read(url, signal); },
  };
  const component = new Function(...Object.keys(hooks), js + '; return ConnectionCard;')(...Object.values(hooks));
  const render = patch => { Object.assign(props, patch); cursor = 0; const tree = component(props); while (effects.length) effects.shift()(); return tree; };
  return { render, requests, stop() { for (const slot of slots) slot?.cleanup?.(); } };
}
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : Array.isArray(node) ? node.map(text).join('') : node.children.map(text).join('');
const find = (node, predicate) => !node || typeof node !== 'object' ? null : Array.isArray(node) ? node.map(child => find(child, predicate)).find(Boolean) : predicate(node) ? node : find(node.children, predicate);

test('all keep-awake states and per-Agent counts use stable Chinese copy', () => {
  for (const [state, expected] of [['disabled', '未启用'], ['idle', '空闲'], ['unsupported', '不支持'], ['error', '出错']]) assert.ok(keepAwakeLabel({ state }).includes(expected));
  const label = keepAwakeLabel({ state: 'holding', reasons: [{ agentId: 'codex', count: 2 }, { agentId: 'claude-cli', count: 1 }, { agentId: 'deepseek', count: 3 }, { agentId: 'opencode', count: 1 }] });
  for (const expected of ['保持唤醒中', 'Codex 2 个任务', 'Claude CLI 1 个任务', 'DeepSeek 3 个任务', 'OpenCode 1 个任务']) assert.ok(label.includes(expected));
  assert.match(keepAwakeLabel({ state: 'holding', reasons: [], releasing: true }), /60 秒后释放/);
  assert.match(keepAwakeLabel({ state: 'idle', unavailableSources: ['deepseek'] }), /暂不可用/);
});

test('untrusted diagnostics do not expose raw errors, paths or unknown Agent names', () => {
  assert.doesNotMatch(keepAwakeLabel({ state: 'holding', reasons: [{ agentId: 'private-source', count: 1 }, { agentId: 'codex', count: -1 }], errorCode: 'private-detail' }), /private|Codex/);
  for (const bad of [null, undefined, 'private-text', { state: 'private-text' }, { state: 'constructor' }, { state: 'toString' }]) assert.match(keepAwakeLabel(bad), /状态不可用/);
});

test('actual computer card reads authenticated diagnostics and renders a matching accessible status row', async () => {
  let state = 'holding';
  const f = card(async url => url.endsWith('/api/connection') ? {} : { keepAwake: { state, reasons: [{ agentId: 'claude-cli', count: 2 }] } });
  try {
    f.render(); await settle(); const tree = f.render();
    const row = find(tree, node => node.props?.role === 'status'); assert.equal(row.type, 'p'); assert.equal(row.props.className, 'setting-description');
    assert.match(text(row), /保持唤醒：保持唤醒中（Claude CLI 2 个任务）/);
    assert.equal(f.requests.length, 2); assert.ok(f.requests.every(request => request.token === 'synthetic'));
    state = 'idle'; find(tree, node => node.type === 'button').props.onClick(); await settle(); assert.match(text(f.render()), /保持唤醒：空闲/);
  } finally { f.stop(); }
});

test('older gateway diagnostics failure preserves connectivity and shows compatibility status', async () => {
  const f = card(async url => { if (url.endsWith('/api/diagnostics')) throw Object.assign(new Error(), { status: 404 }); return {}; });
  try { f.render(); await settle(); const label = text(f.render()); assert.match(label, /已连接电脑/); assert.match(label, /电脑端可能需要升级/); assert.doesNotMatch(label, /连接不上电脑/); }
  finally { f.stop(); }
});

test('switching computers cancels and ignores a late diagnostic result', async () => {
  let resolve;
  const f = card(async url => url === 'synthetic/api/diagnostics' ? new Promise(done => { resolve = done; }) : url.endsWith('/api/diagnostics') ? { keepAwake: { state: 'disabled' } } : {});
  try {
    f.render(); await settle(); const oldRequest = f.requests.at(-1);
    f.render({ endpoint: 'other-synthetic' }); await settle(); assert.equal(oldRequest.signal.aborted, true);
    resolve({ keepAwake: { state: 'holding' } }); await settle(); assert.match(text(f.render()), /保持唤醒：未启用/);
  } finally { f.stop(); }
});
