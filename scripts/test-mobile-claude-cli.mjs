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
  "export { composeMessageWithAttachments } from './apps/mobile/src/features/chat/attachments';",
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
  const components = ['WorkspaceHeader', 'SystemNotice', 'PullToRefresh', 'ProjectGroups', 'EmptyState', 'AgentPickRow', 'ListSkeleton', 'MessageSkeleton', 'Loader2', 'SessionRangeControl', 'MessageMediaProvider', 'MessageTimeline', 'ComputerComposer', 'ComposerSessionStatus', 'AttachmentTray', 'VoiceInput', 'AgentQueue', 'ClaudeCliCreate', 'AgentQuestions', 'AgentSessionControls', 'ArrowUp', 'MessageSquare'];
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
    authHeaders: () => ({ Authorization: 'synthetic' }), requestJson: (url, options) => overrides.apiPost(url, 'synthetic', options.body, options),
    requestAnimationFrame() {}, apiGet: async route => route === '/api/agents' ? { agents: [agent] } : { sessions: [session], cursor: null },
    apiPost: () => assert.fail('read-only UI must not write'),
    haptic() {},
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
  // A version or runtime gate from the server keeps the common composer read-only.
  f.receive({ ...snapshot, control: { token: id, canSend: true, canSteer: true, canInterrupt: true } });
  const composer = f.find('ComputerComposer').props;
  for (const key of ['disabled', 'uploadDisabled']) assert.equal(composer[key], true);
  for (const key of ['canSend', 'canStop']) assert.equal(composer[key], false);
  assert.equal(composer.voice, null); assert.match(f.text(), /这个会话正在电脑上使用，请先在电脑上退出 claude/);
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


test('runnable Claude CLI shares send/steer/queue/interrupt composer and preserves explicit busy errors', async t => {
  const requests = [];
  const f = driver('AgentChat', { endpoint: '', token: 'synthetic', agent, session: { ...session, desktopOpen: false }, draft: 'Synthetic input', onDraft() {}, scopeKey: 'synthetic', voiceRecovery: {} }, {
    loadPendingAgentDraft: () => null, savePendingAgentDraft: () => true, attentionAfterSend: async () => {},
    apiPost: async (url, _token, body) => { requests.push({ url, body }); return { delivery: 'confirmed' }; },
  }); t.after(() => f.stop());
  const running = { ...snapshot, session: { ...session, desktopOpen: false }, readOnly: undefined, status: 'running', activeTurnId: id,
    control: { token: id, canSend: true, canSteer: true, canInterrupt: true } };
  f.receive(running);
  let composer = f.find('ComputerComposer').props;
  assert.equal(composer.disabled, false); assert.equal(composer.canSend, true); assert.equal(composer.canStop, true);
  assert.deepEqual(composer.deliveries, { steer: true, queue: true });
  composer.onSend('steer'); await f.settle();
  assert.equal(requests[0].body.delivery, 'steer'); assert.equal(requests[0].body.text, 'Synthetic input');
  f.receive(running); composer = f.find('ComputerComposer').props; composer.onSend('queue'); await f.settle();
  assert.equal(requests[1].body.delivery, 'queue');
  f.find('ComputerComposer').props.onStop(); await f.settle(); assert.match(requests[2].url, /interrupt$/);
  assert.doesNotMatch(f.text(), /只读预览/);
});

test('session creation selects only gateway directory choices and sends exactly directory and initial text', async t => {
  const requests = [], created = [];
  const f = driver('ClaudeCliCreate', { endpoint: '', token: 'synthetic', disabled: false, onCreated: session => created.push(session) }, {
    apiGet: async route => { assert.equal(route, '/api/agents/claude-cli/directories'); return { directories: [{ id: 'opaque-choice', label: 'project' }] }; },
    apiPost: async (url, _token, body) => { requests.push({ url, body }); return { session }; },
  }); t.after(() => f.stop());
  f.find('button').props.onClick(); await f.settle();
  assert.equal(f.find('select').props.value, 'opaque-choice');
  assert.equal(f.find('option').props.value, 'opaque-choice');
  f.find('textarea').props.onChange({ target: { value: '  Synthetic first sentence  ' } });
  f.find('form').props.onSubmit({ preventDefault() {} }); await f.settle();
  assert.deepEqual(requests, [{ url: '/api/agents/claude-cli/sessions', body: { directory: 'opaque-choice', text: 'Synthetic first sentence' } }]);
  assert.deepEqual(created, [session]);
});

test('version and process limit errors are visible in the shared workspace and create form', async t => {
  for (const [code, pattern] of [['CLAUDE_CLI_SESSION_BUSY', /这个会话正在电脑上使用/], ['CLAUDE_CLI_BUSY_LIMIT', /3 个运行会话/]]) {
    const f = driver('ClaudeCliCreate', { endpoint: '', token: 'synthetic', disabled: false, onCreated() { assert.fail('must not create'); } }, {
      apiGet: async () => ({ directories: [{ id: 'choice', label: 'project' }] }),
      apiPost: async () => { throw { status: 409, code }; },
    }); t.after(() => f.stop());
    f.find('button').props.onClick(); await f.settle(); f.find('textarea').props.onChange({ target: { value: 'Synthetic input' } });
    f.find('form').props.onSubmit({ preventDefault() {} }); await f.settle(); assert.match(f.text(), pattern);
    assert.equal(f.find('textarea').props.value, 'Synthetic input');
  }
  const f = driver('AgentWorkspace', { navigation: model.agentList('claude-cli'), endpoint: '', token: 'synthetic', scope: 'synthetic', handoffTarget: null }, {
    apiGet: async route => route === '/api/agents' ? { agents: [{ ...agent, errorCode: 'CLAUDE_CLI_VERSION_TOO_OLD', errorMessage: '请升级 Claude Code（当前 2.1.1，需要 ≥ 2.1.326）' }] } : { sessions: [session], cursor: null },
  }); t.after(() => f.stop()); await f.settle();
  assert.match(f.text(), /请升级 Claude Code（当前 2.1.1，需要 ≥ 2.1.326）/); assert.equal(nodes(f.render()).find(node => node.type?.name === 'ClaudeCliCreate').props.disabled, true);
});


test('uncertain creation retries the same key and body without allowing a second task', async t => {
  const attempts = [], created = [];
  const f = driver('ClaudeCliCreate', { endpoint: '', token: 'synthetic', disabled: false, onCreated: value => created.push(value) }, {
    apiGet: async () => ({ directories: [{ id: 'choice', label: 'project' }] }),
    apiPost: async (_url, _token, body, options) => { attempts.push({ body, key: options.headers['Idempotency-Key'] }); if (attempts.length === 1) throw new Error('synthetic lost response'); return { session }; },
  }); t.after(() => f.stop());
  f.find('button').props.onClick(); await f.settle(); f.find('textarea').props.onChange({ target: { value: 'Synthetic creation' } });
  f.find('form').props.onSubmit({ preventDefault() {} }); await f.settle();
  assert.match(f.text(), /创建结果待确认/); assert.equal(f.find('textarea').props.disabled, true);
  f.find('form').props.onSubmit({ preventDefault() {} }); await f.settle();
  assert.deepEqual(attempts[0], attempts[1]); assert.deepEqual(created, [session]);
});


test('Claude CLI latest view uses the newest history cursor as the live window advances', async t => {
  let route;
  const f = driver('AgentChat', { endpoint: '', token: 'synthetic', agent, session, draft: '', onDraft() {}, scopeKey: 'synthetic', voiceRecovery: {} }, {
    apiGet: async value => { route = value; return { messages: [], cursor: null }; },
  }); t.after(() => f.stop());
  f.receive(snapshot); f.receive({ ...snapshot, historyCursor: 'advanced-cursor' });
  nodes(f.render()).find(node => node.type === 'button' && text(node) === '加载更早的消息').props.onClick();
  await f.settle(); assert.match(route, /cursor=advanced-cursor/);
});

const questionSource = await source('apps/mobile/src/features/agents/AgentQuestions.tsx');
const controlsSource = await source('apps/mobile/src/features/agents/AgentSessionControls.tsx');
const permission = { id, status: 'pending', action: 'Bash', resources: [], detail: '{"command":"synthetic-command"}', save: ['synthetic-rule'],
  workingDirectory: 'synthetic-project', inputTruncated: true, allowReason: true, localSettings: true, decisions: ['once', 'always', 'reject'], unavailableReason: null };
const button = (f, label) => nodes(f.render()).find(node => node.type === 'button' && text(node) === label);

test('shared approval card shows input, working directory, truncation and local settings; reason and double-click lock work', async t => {
  const replies = [];
  const f = driver('PermissionCard', { permission, agentLabel: 'Claude CLI', disabled: false, onRespond: async (...args) => { replies.push(args); return true; } }); t.after(() => f.stop());
  assert.match(f.text(), /Bash/); assert.match(f.text(), /synthetic-project/); assert.match(f.text(), /synthetic-command/); assert.match(f.text(), /已截断/); assert.match(f.text(), /写进这个项目的本地设置/);
  assert.deepEqual(nodes(f.render()).filter(node => node.type === 'button').map(text), ['允许一次', '总是允许', '拒绝']);
  f.find('textarea').props.onChange({ target: { value: 'Please stop here' } });
  const reject = button(f, '拒绝'); reject.props.onClick(); reject.props.onClick(); await f.settle();
  assert.deepEqual(replies, [['reject', 'Please stop here']]); assert.ok(button(f, '允许一次').props.disabled);
  const noRule = driver('PermissionCard', { permission: { ...permission, decisions: ['once', 'reject'], save: [], localSettings: false }, agentLabel: 'Claude CLI', disabled: false, onRespond: async () => true }); t.after(() => noRule.stop());
  assert.equal(button(noRule, '总是允许'), undefined); assert.doesNotMatch(noRule.text(), /写进这个项目/);
  for (const decision of ['允许一次', '总是允许']) {
    const allowed = driver('PermissionCard', { permission, agentLabel: 'Claude CLI', disabled: false, onRespond: async (...args) => { replies.push(args); return true; } }); t.after(() => allowed.stop());
    button(allowed, decision).props.onClick(); await allowed.settle();
  }
  assert.deepEqual(replies.slice(1), [['once', undefined], ['always', undefined]]);
});

test('question card supports single, multiple, Other and literal text previews', async t => {
  const request = { id, status: 'pending', questions: [
    { question: 'Format?', header: 'Format', options: [{ label: 'Brief', description: 'Short', preview: '<script>synthetic-preview</script>' }, { label: 'Full', description: 'Long' }], multiple: false, custom: true },
    { question: 'Sections?', header: 'Sections', options: [{ label: 'Intro', description: '' }, { label: 'End', description: '' }], multiple: true, custom: true },
    { question: 'Anything else?', header: '', options: [], multiple: false, custom: true },
  ] };
  const replies = [], f = driver('AgentQuestions', { request, agentLabel: 'Claude CLI', disabled: false, onRespond: async values => { replies.push(values); return true; } }, {}, questionSource); t.after(() => f.stop());
  assert.equal(f.find('pre').props.children[0], '<script>synthetic-preview</script>'); assert.equal(f.find('script'), undefined);
  const inputs = () => nodes(f.render()).filter(node => node.type === 'input');
  inputs()[0].props.onChange({ target: { checked: true } });
  inputs()[3].props.onChange({ target: { checked: true } }); inputs()[4].props.onChange({ target: { checked: true } });
  const free = nodes(f.render()).find(node => node.type === 'textarea'); free.props.onChange({ target: { value: 'My own detail' } });
  const submit = f.find('form').props.onSubmit; submit({ preventDefault() {} }); submit({ preventDefault() {} }); await f.settle();
  assert.deepEqual(replies, [[['Brief'], ['Intro', 'End'], ['My own detail']]]);
  const other = driver('AgentQuestions', { request: { ...request, questions: [request.questions[0]] }, agentLabel: 'Claude CLI', disabled: false, onRespond: async values => { replies.push(values); return true; } }, {}, questionSource); t.after(() => other.stop());
  nodes(other.render()).filter(node => node.type === 'input')[2].props.onChange({ target: { checked: true } });
  other.find('textarea').props.onChange({ target: { value: 'Different format' } }); other.find('form').props.onSubmit({ preventDefault() {} }); await other.settle();
  assert.deepEqual(replies.at(-1), [['Different format']]);
});

test('runtime controls load Query model choices, offer only safe modes and send explicit changes', async t => {
  const calls = [], settings = { permissionMode: 'default', model: null, models: [{ value: 'synthetic-model', displayName: 'Synthetic model', description: 'Test choice' }] };
  const f = driver('AgentSessionControls', { settings, disabled: false, load: async () => settings,
    onMode: async mode => { calls.push(['mode', mode]); settings.permissionMode = mode; return true; },
    onModel: async model => { calls.push(['model', model]); settings.model = model; return true; },
  }, {}, controlsSource); t.after(() => f.stop());
  f.find('details').props.onToggle({ currentTarget: { open: true } }); await f.settle();
  const selects = () => nodes(f.render()).filter(node => node.type === 'select');
  assert.deepEqual(nodes(selects()[0]).filter(node => node.type === 'option').map(node => node.props.value), ['default', 'plan', 'acceptEdits']);
  assert.match(text(selects()[1]), /Synthetic model/);
  selects()[0].props.onChange({ target: { value: 'plan' } }); button(f, '切换权限模式').props.onClick(); await f.settle();
  selects()[1].props.onChange({ target: { value: 'synthetic-model' } }); button(f, '切换模型').props.onClick(); await f.settle();
  assert.deepEqual(calls, [['mode', 'plan'], ['model', 'synthetic-model']]);
});

test('chat routes shared approval, question and switching actions; retraction and process closure remove their entries', async t => {
  const calls = [], f = driver('AgentChat', { endpoint: '', token: 'synthetic', agent, session, draft: '', onDraft() {}, scopeKey: 'synthetic', voiceRecovery: {} }, {
    apiPost: async (route, _token, payload) => { calls.push({ route, payload }); return { ok: true, delivery: 'confirmed' }; },
  }); t.after(() => f.stop());
  const active = { ...snapshot, readOnly: undefined, runtimeSettings: { permissionMode: 'default', model: 'synthetic-model' },
    permissions: [permission], questions: [{ id, status: 'pending', questions: [] }], control: { token: id, canSend: true, canSteer: false, canInterrupt: false } };
  f.receive(active);
  const card = nodes(f.render()).find(node => node.type?.name === 'PermissionCard');
  await card.props.onRespond('reject', 'Synthetic reason'); await f.settle();
  await f.find('AgentQuestions').props.onRespond([['Synthetic answer']]); await f.settle();
  await f.find('AgentSessionControls').props.onMode('plan'); await f.settle();
  await f.find('AgentSessionControls').props.onModel('synthetic-model'); await f.settle();
  assert.deepEqual(calls.map(call => call.route.split('/').slice(-2).join('/')), [`${id}/respond`, `${id}/respond`, `${id}/permission-mode`, `${id}/model`]);
  assert.equal(calls[0].payload.reason, 'Synthetic reason'); assert.deepEqual(calls[1].payload.answers, [['Synthetic answer']]);
  assert.equal(calls[2].payload.mode, 'plan'); assert.equal(calls[3].payload.model, 'synthetic-model');
  assert.ok(calls.every(call => call.payload.controlToken === id && call.payload.clientMessageId));
  f.receive({ ...active, permissions: [], questions: [], runtimeSettings: undefined });
  assert.equal(nodes(f.render()).find(node => node.type?.name === 'PermissionCard'), undefined); assert.equal(f.find('AgentQuestions'), undefined); assert.equal(f.find('AgentSessionControls'), undefined);
});

test('a stuck turn shows the host notice (model API retrying) only while running', async () => {
  const workspace = await (await import('node:fs/promises')).readFile('apps/mobile/src/features/agents/AgentWorkspace.tsx', 'utf8');
  assert.match(workspace, /snapshot\?\.status === "running" && snapshot\.notice && <SystemNotice>\{snapshot\.notice\}<\/SystemNotice>/);
  assert.ok(workspace.indexOf('snapshot.notice && <SystemNotice>') > workspace.indexOf('</MessageMediaProvider>'), 'notice sits below the messages');
});

