import ts from 'typescript';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { appNavigationFixture, navigationModel, findElement as find } from './helpers/mobile-navigation-fixture.mjs';

// F1: the phone's notification bridge (keys shared with the gateway, settings, when to ask and start).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await mkdtemp(path.join(tmpdir(), 'mobile-attention-'));
const shim = path.join(temp, 'capacitor.mjs');
await writeFile(shim, `
export const Capacitor = { isNativePlatform: () => Boolean(globalThis.__native), isPluginAvailable: name => Boolean(globalThis.__plugins?.[name]) };
export const CapacitorHttp = { request: async () => { throw new Error("no http in tests"); } };
export const registerPlugin = name => new Proxy({}, { get: (_, method) => (...args) => globalThis.__plugins[name][method](...args) });
`);
await build({ stdin: { contents: `
export * from './apps/mobile/src/features/notify/attention';
export { attentionKey } from './apps/relay/src/attention/attentionHub';
`, resolveDir: root, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', outfile: path.join(temp, 'attention.mjs'),
  alias: { '@capacitor/core': shim }, logLevel: 'error' });
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
globalThis.window = new EventTarget();
const m = await import(pathToFileURL(path.join(temp, 'attention.mjs')));
test.after(() => rm(temp, { recursive: true, force: true }));

function plugin(permission) {
  const calls = [];
  const state = { permission };
  globalThis.__native = true;
  globalThis.__plugins = { Attention: {
    permission: async () => { calls.push('permission'); return { ...state, running: false }; },
    requestPermission: async () => { calls.push('request'); state.permission = state.next ?? 'granted'; return { ...state, running: false }; },
    start: async () => { calls.push('start'); return { ...state, running: true, started: true }; },
    setViewing: async value => { calls.push(['viewing', value.key]); },
  } };
  return { calls, state };
}

test('keys are the gateway attentionKey() for every channel and parse back to a target', () => {
  assert.equal(m.codexAttentionKey('t1', true), m.attentionKey({ source: 'desktop', threadId: 't1' }));
  assert.equal(m.codexAttentionKey('t1', false), m.attentionKey({ source: 'live', threadId: 't1', turnId: 'x' }));
  assert.equal(m.agentAttentionKey('deepseek', 's:1'), m.attentionKey({ source: 'agent', agentId: 'deepseek', sessionId: 's:1' }));
  assert.deepEqual(m.parseAttentionKey('desktop:t1'), { agentId: 'codex', sessionId: 't1' });
  assert.deepEqual(m.parseAttentionKey('live:t1'), { agentId: 'codex', sessionId: 't1' });
  assert.deepEqual(m.parseAttentionKey('agent:deepseek:s:1'), { agentId: 'deepseek', sessionId: 's:1' });
  for (const bad of ['', 'desktop:', 'agent:deepseek', 'agent::s', 'other:t1']) assert.equal(m.parseAttentionKey(bad), null, bad);
});

test('settings default to all on, survive corrupt storage and announce changes', () => {
  storage.clear();
  assert.deepEqual(m.loadNotifySettings(), { finished: true, approvals: true, offline: true });
  storage.set(m.notifySettingsKey, JSON.stringify({ finished: false, approvals: true }));
  assert.deepEqual(m.loadNotifySettings(), { finished: false, approvals: true, offline: true }, 'old settings enable the new option');
  m.saveNotifySettings({ finished: true, approvals: true, offline: false });
  assert.equal(m.loadNotifySettings().offline, false, 'explicit off survives reload');
  let changed = 0; const listener = () => changed++;
  window.addEventListener('mobicodex-notify-settings', listener);
  m.saveNotifySettings({ finished: false, approvals: true, offline: true });
  window.removeEventListener('mobicodex-notify-settings', listener);
  assert.equal(changed, 1);
  assert.deepEqual(m.loadNotifySettings(), { finished: false, approvals: true, offline: true });
  storage.set(m.notifySettingsKey, '{broken');
  assert.deepEqual(m.loadNotifySettings(), { finished: true, approvals: true, offline: true });
});

test('after a send: asks for permission once, starts only when allowed, and does nothing in a browser or when switched off', async () => {
  storage.clear();
  globalThis.__native = false; globalThis.__plugins = {};
  await m.attentionAfterSend();

  let p = plugin('prompt');
  await m.attentionAfterSend();
  assert.deepEqual(p.calls, ['permission', 'request', 'start']);

  storage.clear(); p = plugin('prompt'); p.state.next = 'denied';
  await m.attentionAfterSend();
  await m.attentionAfterSend();
  assert.deepEqual(p.calls, ['permission', 'request', 'permission'], 'a refusal is not asked again on every send');

  storage.clear(); p = plugin('granted');
  m.saveNotifySettings({ finished: false, approvals: false, offline: false });
  await m.attentionAfterSend();
  assert.deepEqual(p.calls, []);
  m.saveNotifySettings({ finished: false, approvals: true, offline: true });
  await m.attentionAfterSend();
  assert.deepEqual(p.calls, ['permission', 'start']);

  p = plugin('granted');
  m.saveNotifySettings({ finished: false, approvals: false, offline: true });
  await m.attentionAfterSend();
  assert.deepEqual(p.calls, ['permission', 'start'], 'offline-only still uses the existing task service');

  m.setAttentionViewing('desktop:t1');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(p.calls.at(-1), ['viewing', 'desktop:t1']);
});

test('#18 settings hint: only for granted finished notifications on builds that report pop-up and vibration', () => {
  const granted = { permission: 'granted', banner: true, vibrate: true };
  assert.equal(m.finishedAlertHint(granted, true), 'check');
  assert.equal(m.finishedAlertHint({ ...granted, banner: false }, true), 'off');
  assert.equal(m.finishedAlertHint({ ...granted, vibrate: false }, true), 'off');
  assert.equal(m.finishedAlertHint(granted, false), null, 'switched off in the app');
  assert.equal(m.finishedAlertHint({ ...granted, permission: 'denied' }, true), null, 'the permission button covers it');
  assert.equal(m.finishedAlertHint({ permission: 'granted' }, true), null, 'an older installed build cannot tell');
  assert.equal(m.finishedAlertHint(null, true), null);
});

test('#18 finished-task notifications pop up and vibrate on a new channel that replaces the old one', async () => {
  const java = name => readFile(path.join(root, 'apps/mobile/android/app/src/main/java/com/mobilecodex/app', name), 'utf8');
  const [channels, service, bridge] = await Promise.all(['AttentionNotifications.java', 'AttentionService.java', 'AttentionPlugin.java'].map(java));
  assert.match(channels, /DONE = "attention_done_v2"/);
  assert.match(channels, /new NotificationChannel\(DONE, "任务完成", NotificationManager\.IMPORTANCE_HIGH\)/);
  assert.match(channels, /done\.enableVibration\(true\)/);
  assert.match(channels, /deleteNotificationChannel\(LEGACY_DONE\)/);
  assert.match(channels, /legacy\.getImportance\(\) == NotificationManager\.IMPORTANCE_NONE/, 'a blocked old channel stays blocked');
  const finished = service.slice(service.indexOf('builder(this, AttentionNotifications.DONE)'), service.indexOf('privately(this, builder, AttentionNotifications.DONE)'));
  assert.match(finished, /setPriority\(NotificationCompat\.PRIORITY_HIGH\)/);
  assert.match(finished, /DEFAULT_VIBRATE/);
  assert.match(service, /privately\(this, builder, AttentionNotifications\.DONE\)/, 'lock screens keep the private version');
  assert.match(bridge, /ACTION_CHANNEL_NOTIFICATION_SETTINGS[\s\S]*EXTRA_CHANNEL_ID, AttentionNotifications\.DONE/);
  assert.match(bridge, /result\.put\("banner", banner\)/);
  assert.match(bridge, /result\.put\("vibrate", vibrate\)/);
});

for (const cold of [true, false]) {
  test(`${cold ? 'cold' : 'warm'} offline notification opens connection settings without switching Agent or requiring a reachable gateway`, async t => {
    const initial = navigationModel.agentSession('claude', 'existing');
    const f = appNavigationFixture(initial, [], cold ? { coldNotification: { kind: 'connection' } } : {});
    t.after(() => f.stop()); if (!cold) f.notify({ kind: 'connection' });
    await f.settle();
    assert.equal(find(f.render(), 'Settings').props.settingsOpen, true);
    assert.deepEqual(find(f.render(), 'AgentWorkspace').props.navigation, initial);
    assert.equal(f.requests.length, 0, 'opening settings does not resolve a session through an offline gateway');
  });
  test(`${cold ? 'cold' : 'warm'} notification opens CC Desk without a Codex fallback`, async t => {
    const target = { agentId: 'ccdesk', sessionId: 'desk-session', title: '合成会话' };
    const f = appNavigationFixture(cold ? navigationModel.agentPicker() : navigationModel.agentSession('claude', 'existing'), [], cold ? { coldNotification: target } : {});
    t.after(() => f.stop()); if (!cold) f.notify(target);
    await f.settle();
    const workspace = find(f.render(), 'AgentWorkspace');
    assert.deepEqual(workspace.props.navigation, navigationModel.agentSession('ccdesk', 'desk-session'));
    assert.equal(workspace.props.handoffTarget.title, '合成会话');
    assert.equal(find(f.render(), 'Workspace'), undefined);
    assert.equal(find(f.render(), 'Notice'), undefined);
  });
}
test('unknown and unavailable Agents show an explanation and keep the current page', async t => {
  for (const [id, agents, message] of [
    ['missing', [], /未知|未提供/], ['ccdesk', [{ id: 'ccdesk', sessionApi: 1, state: 'failed' }], /不可用/],
  ]) {
    const f = appNavigationFixture(navigationModel.agentSession('claude', 'existing'), [], { agents }); t.after(() => f.stop());
    f.notify({ agentId: id, sessionId: 'session', title: '' }); await f.settle();
    assert.deepEqual(find(f.render(), 'AgentWorkspace').props.navigation, navigationModel.agentSession('claude', 'existing'));
    assert.match(find(f.render(), 'Notice').props.children[0], message);
    assert.equal(find(f.render(), 'Workspace'), undefined);
  }
});
test('a temporarily unprobed Agent is not mistaken for a missing Agent', async t => {
  const f = appNavigationFixture(undefined, [], { agents: [{ id: 'claude', transport: 'claude-mods-http', state: 'unprobed' }] }); t.after(() => f.stop());
  f.notify({ agentId: 'claude', sessionId: 'session', title: '' }); await f.settle();
  assert.equal(find(f.render(), 'AgentWorkspace').props.navigation.agentId, 'claude');
});

test('native open listener delivers retained cold events once, uses the latest connection callback and ignores events after unmount', async () => {
  const source = await readFile(path.join(root, 'apps/mobile/src/features/notify/attention.ts'), 'utf8');
  const ast = ts.createSourceFile('attention.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const body = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'useAttention').getText(ast).replace(/^export /, '');
  const js = ts.transpileModule(body, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const slots = [], setups = [], calls = [], configurations = [], events = new EventTarget(); let cursor = 0, listener, release, removed = 0, registrations = 0;
  let settings = { ...m.defaultNotifySettings };
  const ports = {
    useRef(value) { return slots[cursor++] ??= { current: value }; },
    useEffect(setup, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((v, i) => v !== old.deps[i])) setups.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: setup() }; }); },
    attentionAvailable: () => true, parseAttentionKey: m.parseAttentionKey, gatewayAttentionKey: m.gatewayAttentionKey, loadNotifySettings: () => settings,
    changedEvent: 'settings', window: events, document: Object.assign(new EventTarget(), { visibilityState: 'hidden' }),
    Attention: { configure: async value => { configurations.push(value); },
      addListener(name, callback) {
        assert.equal(name, 'open'); registrations++; listener = callback;
        callback({ key: 'agent:ccdesk:cold', title: '冷启动提醒' });
        return new Promise(resolve => { release = resolve; });
      },
    },
  };
  const hook = new Function(...Object.keys(ports), js + '; return useAttention;')(...Object.values(ports));
  const receive = name => target => calls.push([name, target.sessionId ?? target.kind]);
  hook('first', '', receive('first')); for (const setup of setups.splice(0)) setup();
  cursor = 0; hook('second', '', receive('second')); for (const setup of setups.splice(0)) setup();
  listener({ key: 'agent:ccdesk:warm' });
  assert.equal(registrations, 1); assert.deepEqual(calls, [['first', 'cold'], ['second', 'warm']]);
  listener({ key: m.gatewayAttentionKey }); assert.deepEqual(calls.at(-1), ['second', 'connection']);
  assert.equal(configurations.at(-1).offline, true);
  settings = { ...settings, offline: false }; events.dispatchEvent(new Event('settings'));
  assert.equal(configurations.at(-1).offline, false, 'switch changes reach the running native service');
  assert.equal(configurations.at(-1).endpoint, 'second');
  for (const slot of slots) slot?.cleanup?.();
  listener({ key: 'agent:ccdesk:late' }); release({ remove: async () => { removed++; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(removed, 1); assert.equal(calls.length, 3);
});
