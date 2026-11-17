import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { build } from 'esbuild';

await fs.mkdir('output/c4a-tests', { recursive: true });
const directory = await fs.mkdtemp(path.resolve('output/c4a-tests/mobile-'));
test.after(() => fs.rm(directory, { recursive: true, force: true }));
await build({ stdin: { contents: [
  "export * from './apps/mobile/src/features/agents/catalog';",
  "export * from './apps/mobile/src/features/agents/agentSummary';",
  "export * from './apps/mobile/src/features/agents/runtime';",
  "export * from './apps/mobile/src/features/agents/drafts';",
  "export * from './apps/mobile/src/features/threads/model';",
  "export * from './apps/mobile/src/app/navigation';",
  "export { agentSessionStatus } from './apps/mobile/src/features/chat/sessionStatusModel';",
].join('\n'), loader: 'ts', resolveDir: process.cwd() }, outfile: path.join(directory, 'models.cjs'), bundle: true, format: 'cjs', platform: 'node', define: { 'import.meta.env': '{}' }, nodePaths: [path.resolve('apps/mobile/node_modules')] });
const oldStorage = globalThis.localStorage;
globalThis.localStorage = { getItem: () => null };
const model = createRequire(import.meta.url)(path.join(directory, 'models.cjs'));
if (oldStorage === undefined) delete globalThis.localStorage; else globalThis.localStorage = oldStorage;
async function source(file) {
  const input = await fs.readFile(file, 'utf8'), ast = ts.createSourceFile(file, input, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const body = ast.statements.filter(node => !ts.isImportDeclaration(node)).map(node => node.getText(ast)).join('\n').replaceAll('export default function', 'function').replaceAll('export function', 'function');
  return ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText;
}
const workspaceSource = await source('apps/mobile/src/features/agents/AgentWorkspace.tsx');
const pickerSource = await source('apps/mobile/src/features/agents/AgentPicker.tsx');
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : node && typeof node === 'object' ? [node, ...nodes(node.props?.children)] : [];
const text = node => Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : node ?? '';
const id = '10000000-0000-4000-8000-000000000001';
const agent = { id: 'claude-cli', label: 'Claude CLI', transport: 'claude-cli-local-records', sessionApi: 1, enabled: true };
const session = { id, title: 'Synthetic session', directory: 'project', updatedAt: '2026-11-17T00:00:00Z', desktopOpen: true };
const snapshot = { agentId: agent.id, session, connected: true, updatedAt: session.updatedAt, status: 'idle', activity: 'outputting', messages: [{ id: 'a', role: 'user', text: 'First', timestamp: '', kind: 'agent_message' }, { id: 'b', role: 'assistant', text: 'Second', timestamp: '', kind: 'agent_message' }], questions: [], permissions: [], historyCursor: 'synthetic-cursor', partialText: true, control: { token: id, canSend: false, canSteer: false, canInterrupt: false }, submission: null, readOnly: '只读预览，发送功能下一版提供' };

function driver(name, props, overrides = {}, code = workspaceSource) {
  const slots = [], effects = [], windowPort = new EventTarget(); let cursor = 0, dirty = true, tree, subscription;
  const components = ['WorkspaceHeader', 'SystemNotice', 'PullToRefresh', 'ProjectGroups', 'EmptyState', 'AgentPickRow', 'ListSkeleton', 'MessageSkeleton', 'Loader2', 'SessionRangeControl', 'MessageMediaProvider', 'MessageTimeline', 'ComputerComposer', 'ComposerSessionStatus', 'AttachmentTray', 'VoiceInput', 'AgentQueue'];
  const deps = { ...model, Fragment: "Fragment", revokeAttachmentPreviews() {}, ...Object.fromEntries(components.map(name => [name, name])),
    h: (type, props, ...children) => ({ type, props: { ...props, children } }),
    useState(value) { const i = cursor++; slots[i] ??= { value: typeof value === 'function' ? value() : value }; return [slots[i].value, next => { const value = typeof next === 'function' ? next(slots[i].value) : next; dirty ||= value !== slots[i].value; slots[i].value = value; }]; },
    useRef(value) { return slots[cursor++] ??= { current: value }; },
    useEffect(setup, deps) { const i = cursor++, old = slots[i]; if (!old || deps.some((value, j) => value !== old.deps[j])) effects.push(() => { old?.cleanup?.(); slots[i] = { deps, cleanup: setup() }; }); },
    window: windowPort, document: { hidden: false }, crypto: globalThis.crypto,
    useDeviceRevoked: () => false, deviceRevokedMessage: '已撤销', productBeforeNavigate: 'before-navigate',
    registerVoiceAgentDrafts: () => () => {}, loadWorkspaceCache: () => ({ threads: [] }), loadReadingPositions: () => ({}), saveReadingPositions: () => {},
    setAttentionViewing() {}, agentAttentionKey: () => '', maxMessagesPerThread: 200, buildUrl: (_endpoint, route) => route,
    subscribeEvents(options) { subscription = options; return () => {}; }, createSnapshotReducer: () => value => value,
    requestAnimationFrame() {}, apiGet: async route => route === '/api/agents' ? { agents: [agent] } : { sessions: [session], cursor: null },
    apiPost: () => assert.fail('read-only UI must not write'),
    ...overrides,
  };
  const Component = new Function(...Object.keys(deps), code + `; return ${name};`)(...Object.values(deps));
  function render() { let count = 0; do { assert.ok(++count < 25, 'UI did not settle'); dirty = false; cursor = 0; tree = Component(props); for (const effect of effects.splice(0)) effect(); } while (dirty); return tree; }
  render();
  return { render, find: type => nodes(render()).find(node => node.type === type), text: () => text(render()),
    async settle() { for (let i = 0; i < 5; i++) { await new Promise(resolve => setImmediate(resolve)); render(); } },
    receive(value) { subscription.events['agent-session'](value); subscription.onState('online'); render(); },
    stop() { for (const slot of slots) slot?.cleanup?.(); },
  };
}

test('Claude CLI is a peer Agent; disabled entry has its own status and does not fetch sessions', async t => {
  const reads = [], selected = [];
  const f = driver('AgentPicker', { endpoint: '', token: 'synthetic', scope: 'synthetic', onSelect: id => selected.push(id) }, {
    apiGet: async route => { reads.push(route); return { agents: [{ ...agent, enabled: false }] }; },
  }, pickerSource); t.after(() => f.stop()); await f.settle();
  const rows = nodes(f.render()).filter(node => node.type === 'AgentPickRow');
  assert.deepEqual(rows.map(node => node.props.id), ['codex', 'claude-cli']);
  assert.equal(rows[1].props.summary.status, 'disabled'); assert.equal(model.agentStatusLabels.disabled, '未启用');
  assert.match(model.summaryLine(rows[1].props.summary), /配置允许读取的目录/);
  rows[1].props.onOpen(); assert.deepEqual(selected, ['claude-cli']);
  assert.ok(!reads.some(route => route.includes('/claude-cli/sessions')));
  assert.equal(f.find('WorkspaceHeader').props.title, '选择 Agent');
});

test('Claude CLI list uses the shared header, project groups and navigation, and marks desktop registration', async t => {
  const navigations = [];
  const f = driver('AgentWorkspace', { navigation: model.agentList('claude-cli'), onNavigate: next => navigations.push(next), onOpenAgents() {}, endpoint: '', token: 'synthetic', scope: 'synthetic', handoffTarget: null }); t.after(() => f.stop()); await f.settle();
  assert.equal(f.find('WorkspaceHeader').props.agentId, 'claude-cli');
  const group = f.find('ProjectGroups'); assert.equal(group.props.agentId, 'claude-cli');
  const row = group.props.children[0](session); assert.match(text(row), /电脑上开着/); assert.match(text(row), /Synthetic session/);
  row.props.onClick(); assert.deepEqual(navigations, [model.agentSession('claude-cli', id)]);
});

test('unconfigured workspace explains configuration without requesting history or sessions', async t => {
  const reads = [];
  const f = driver('AgentWorkspace', { navigation: model.agentList('claude-cli'), endpoint: '', token: 'synthetic', scope: 'synthetic', handoffTarget: null }, {
    apiGet: async route => { reads.push(route); return { agents: [{ ...agent, enabled: false }] }; },
  }); t.after(() => f.stop()); await f.settle();
  assert.equal(f.find('EmptyState').props.title, 'Claude CLI 未启用'); assert.match(f.text(), /claudeCli.directories/); assert.deepEqual(reads, ['/api/agents']);
});

test('read-only chat keeps text order, blocks send/upload/interrupt and voice, and pages beyond the render budget', async t => {
  let historyReads = 0;
  const f = driver('AgentChat', { endpoint: '', token: 'synthetic', agent, session, draft: 'Synthetic draft', onDraft() {}, scopeKey: 'synthetic', voiceRecovery: {} }, {
    apiGet: async () => { historyReads++; return { messages: Array.from({ length: 50 }, (_, i) => ({ id: `old-${historyReads}-${i}`, role: 'user', text: `Older ${i}`, timestamp: '', kind: 'agent_message' })), cursor: `cursor-${historyReads}` }; },
  }); t.after(() => f.stop());
  assert.match(f.text(), /只读预览，发送功能下一版提供/);
  // Even incorrect advertised capabilities cannot enable this phase's read-only Agent.
  f.receive({ ...snapshot, control: { token: id, canSend: true, canSteer: true, canInterrupt: true } });
  const composer = f.find('ComputerComposer').props;
  for (const key of ['disabled', 'uploadDisabled']) assert.equal(composer[key], true);
  for (const key of ['canSend', 'canStop']) assert.equal(composer[key], false);
  assert.equal(composer.voice, null); assert.match(f.text(), /电脑上开着，请到 Claude Code 操作/);
  composer.onSend(); composer.onStop(); await f.find('input').props.onChange({ target: { files: [{}] } });
  assert.deepEqual(f.find('MessageTimeline').props.messages.map(message => message.text), ['First', 'Second']);
  for (let page = 0; page < 6; page++) {
    const button = nodes(f.render()).find(node => node.type === 'button' && text(node) === '加载更早的消息');
    assert.ok(button); button.props.onClick(); await f.settle();
  }
  assert.equal(historyReads, 6); assert.equal(f.find('MessageTimeline').props.messages.length, 200);
  assert.ok(f.find('MessageTimeline').props.messages[0].id.startsWith('old-6'));
  const latest = nodes(f.render()).find(node => node.type === 'button' && text(node).includes('返回最新')); latest.props.onClick();
  assert.deepEqual(f.find('MessageTimeline').props.messages.map(message => message.text), ['First', 'Second']);
});
