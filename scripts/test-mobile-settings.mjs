import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'settings-'));
test.after(() => fs.rm(dir, { recursive: true, force: true }));
await build({ stdin: { contents: "export * from './apps/mobile/src/features/connection/connectionStatus.ts'; export { deviceRevokedMessage } from './apps/mobile/src/features/connection/authorization.ts';", resolveDir: process.cwd(), loader: 'ts' },
  outfile: path.join(dir, 'model.mjs'), bundle: true, platform: 'node', format: 'esm' });
const { friendlyComputerName, connectionCardState, connectionCardTitles, deviceRevokedMessage } = await import(pathToFileURL(path.join(dir, 'model.mjs')).href);
const settings = await fs.readFile('apps/mobile/src/app/GlobalSettings.tsx', 'utf8');
const agents = await fs.readFile('apps/mobile/src/features/agents/AgentWorkspace.tsx', 'utf8');
const app = await fs.readFile('apps/mobile/src/app/App.tsx', 'utf8'), pairing = await fs.readFile('apps/mobile/src/features/connection/PairingPanel.tsx', 'utf8');

test('the computer is named by its relay ID or host, never the full URL', () => {
  assert.equal(friendlyComputerName('https://broker.example/proxy/r/my-mac'), 'my-mac');
  assert.equal(friendlyComputerName('http://192.168.1.8:8787'), '192.168.1.8:8787');
  assert.equal(friendlyComputerName('not a url'), '');
});
test('connection card states', () => {
  const base = { endpoint: 'https://x', token: 't', checking: false, failed: false, latency: 42, connectionState: 'ok' };
  assert.equal(connectionCardState({ ...base, token: '' }), 'none');
  assert.equal(connectionCardState({ ...base, checking: true, latency: null }), 'testing');
  assert.equal(connectionCardState({ ...base, checking: true }), 'ok', 'a re-check keeps showing the last good result');
  assert.equal(connectionCardState({ ...base, failed: true }), 'error');
  assert.equal(connectionCardState({ ...base, connectionState: 'error' }), 'error');
  assert.equal(connectionCardState(base), 'ok');
  assert.deepEqual(Object.keys(connectionCardTitles).sort(), ['error', 'none', 'ok', 'testing']);
});
test('settings order: connection card, pairing, voice, then 高级 with manual connection, status and diagnostics', () => {
  const order = ['<ConnectionCard', '<PairingPanel', '<VoiceSettings', '高级</DisclosureSummary>', '<h3>手动连接</h3>', '<h3>电脑状态</h3>', '会话显示诊断（仅 Codex）</DisclosureSummary>'].map(mark => settings.indexOf(mark));
  assert.ok(order.every(i => i > 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});
test('no developer jargon in visible settings text; 401 wording no longer claims revocation only', () => {
  for (const jargon of ['Relay endpoint', 'placeholder="Token"', 'Pair phone', '显示或隐藏 token', '打开健康检查', '<span>Relay</span>', '<span>Desktop</span>', 'IPC 可用']) assert.ok(!settings.includes(jargon) && !pairing.includes(jargon), jargon);
  assert.doesNotMatch(pairing, /Relay/);
  assert.match(deviceRevokedMessage, /撤销/); assert.match(deviceRevokedMessage, /令牌不对/); assert.match(deviceRevokedMessage, /重新配对/);
});

// Execute the production App with isolated hooks/ports; retain the same element tree on rerender.
const ast = ts.createSourceFile('App.tsx', app, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const appFunction = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'App').getText(ast).replace('export function', 'function');
const js = ts.transpileModule(appFunction, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
function appFixture(agentMode) {
  const states = [], effects = []; let cursor = 0;
  const storage = new Map([['productRemoteMode', agentMode ? 'agent' : 'codex']]);
  const profile = { id: 'test', cacheNamespace: 'fixed', endpoint: '', token: '', name: '测试连接' };
  const h = (type, props, ...children) => ({ type, props: { ...props, children } });
  const hooks = {
    React: { createElement: h, Suspense: 'Suspense' },
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useCallback: callback => callback, useEffect: effect => effects.push(effect), loadConnectionProfiles: () => [profile], defaultProfileId: profile.id,
    normalizeEndpoint: value => value, defaultSplitMode: () => 'auto', defaultApprovalPolicy: () => 'never', defaultSandboxMode: () => 'workspace-write',
    useVoiceRecovery: () => ({ recovery: {}, notice: null }), useAttention() {}, useIntake() {}, takeProductSettingsLaunch() {},
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    ProductRemoteShell: 'Shell', WorkItemsPage: 'Items', CapturePanel: 'Capture', AgentWorkspace: 'AgentWorkspace', Workspace: 'Workspace', GlobalSettings: 'Settings',
  };
  const renderApp = new Function(...Object.keys(hooks), js + '; return App;')(...Object.values(hooks));
  return { render() { cursor = 0; effects.length = 0; return renderApp(); }, effects, storage };
}
const find = (tree, type) => tree?.type === type ? tree : tree?.props?.children?.flat(Infinity).map(child => find(child, type)).find(Boolean);
test('both workspaces open global settings without switching mode or replacing the active workspace', () => {
  for (const agentMode of [false, true]) {
    const f = appFixture(agentMode), initial = f.render(), type = agentMode ? 'AgentWorkspace' : 'Workspace';
    const before = find(initial, type); assert.ok(before);
    assert.equal(find(initial, 'Settings').props.settingsOpen, false);
    before.props.onOpenSettings();
    const opened = f.render(), after = find(opened, type);
    assert.equal(find(opened, 'Settings').props.settingsOpen, true);
    assert.equal(after.type, before.type); assert.equal(after.props.key, before.props.key);
    assert.equal(after.props.handoffTarget, before.props.handoffTarget);
    assert.equal(f.storage.get('productRemoteMode'), agentMode ? 'agent' : 'codex');
    assert.equal(find(opened, agentMode ? 'Workspace' : 'AgentWorkspace'), undefined);
    find(opened, 'Settings').props.onClose(); assert.equal(find(f.render(), 'Settings').props.settingsOpen, false);
    // The host computer-settings entry uses the very same global sheet.
    initial.props.onComputerSettings(); assert.equal(find(f.render(), 'Settings').props.settingsOpen, true);
    assert.equal(f.storage.get('productRemoteMode'), agentMode ? 'agent' : 'codex');
  }
});
test('the settings back handler consumes back before Agent navigation and leaves the workspace mounted', () => {
  const savedWindow = globalThis.window; globalThis.window = new EventTarget();
  try {
    const f = appFixture(true); find(f.render(), 'AgentWorkspace').props.onOpenSettings(); f.render();
    const cleanups = f.effects.map(effect => effect()).filter(Boolean);
    const event = new Event('product-back', { cancelable: true }); window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true); assert.equal(find(f.render(), 'Settings').props.settingsOpen, false);
    assert.ok(find(f.render(), 'AgentWorkspace')); cleanups.forEach(cleanup => cleanup());
  } finally { globalThis.window = savedWindow; }
});
test('Agent settings callback reaches every header and Codex-only actions are explicit', () => {
  assert.match(agents, /<WorkspaceHeader[^]*?onOpenSettings={onOpenSettings}/);
  assert.match(agents, /selected && agent \? <AgentChat[^]*?key={`\$\{agent.id}:\$\{selected.id}`}/);
  for (const label of ['运行策略（仅 Codex）', '分屏（仅 Codex）', '会话显示诊断（仅 Codex）', '保存刷新（仅 Codex）']) assert.ok(settings.includes(label), label);
  assert.match(settings, /disabled={!codex\?\.available \|\| codex.busy}/);
  assert.match(app, /return \(\) => onSettingsTools\(null\)/);
  assert.doesNotMatch(app.slice(app.indexOf('function Workspace')), /settings-sheet|<VoiceSettings/);
});

const agentAst = ts.createSourceFile('AgentWorkspace.tsx', agents, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const agentFunction = agentAst.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'AgentWorkspace').getText(agentAst).replace('export default function', 'function');
const agentJs = ts.transpileModule(agentFunction, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
function renderAgentWorkspace(agent, session, onOpenSettings) {
  // Seed the production component at each navigation depth without network effects.
  const states = [[agent].filter(Boolean), agent, session ? [session] : [], session]; let cursor = 0;
  const hooks = {
    React: { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) },
    useState(initial) { const index = cursor++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial;
      return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; },
    useRef: value => ({ current: value }), useEffect() {}, useMemo: action => action(),
    useDeviceRevoked: () => false, loadAgentView: () => ({}), loadAgentDrafts: () => ({}), loadWorkspaceCache: () => ({ threads: [] }),
    groupByProject: () => [], checkingSummary: {}, offlineSummary: {}, projectGroupLabel: directory => directory.split('/').at(-1),
    WorkspaceHeader: 'Header', AgentChat: 'Chat', PullToRefresh: 'List', AgentPickRow: 'AgentRow', EmptyState: 'Empty',
    ProjectGroups: 'Projects', SessionRangeControl: 'Range', ListSkeleton: 'Skeleton',
  };
  return new Function(...Object.keys(hooks), agentJs + '; return AgentWorkspace;')(...Object.values(hooks))({
    handoffTarget: null, onTargetOpened() {}, onCapture() {}, endpoint: '', token: '', scope: 'synthetic', onBack() {}, voiceRecovery: {}, onOpenSettings,
  });
}
test('settings opens from the actual Agent picker, session list and chat headers without losing the session identity', () => {
  for (const id of [null, 'claude', 'deepseek', 'opencode', 'ccdesk']) {
    for (const chat of id ? [false, true] : [false]) {
      const f = appFixture(true), appTree = f.render(), onOpenSettings = find(appTree, 'AgentWorkspace').props.onOpenSettings;
      const agent = id ? { id, label: id } : null, session = chat ? { id: 'session', title: '合成会话', directory: '~/code/weather-app' } : null;
      const before = renderAgentWorkspace(agent, session, onOpenSettings);
      find(before, 'Header').props.onOpenSettings();
      const opened = f.render(); assert.equal(find(opened, 'Settings').props.settingsOpen, true);
      const after = renderAgentWorkspace(agent, session, find(opened, 'AgentWorkspace').props.onOpenSettings);
      assert.equal(find(after, 'Header').props.title, find(before, 'Header').props.title);
      assert.equal(find(after, 'Chat')?.props.key, find(before, 'Chat')?.props.key);
      if (chat) { assert.equal(find(after, 'Chat').props.session, session); assert.equal(find(after, 'Chat').props.agent, agent); }
      assert.equal(f.storage.get('productRemoteMode'), 'agent');
    }
  }
});
