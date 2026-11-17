import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import path from 'node:path';
import { KeepAwake, inhibitorCommand } from '../dist/gateway/keepAwake.js';
import { monitorKeepAwake } from '../dist/gateway/keepAwakeMonitor.js';
import { AgentGateway } from '../dist/agents/agentGateway.js';
import { OpenCodeAdapter } from '../dist/agents/openCodeAdapter.js';
import { DeepSeekAdapter } from '../dist/agents/deepSeekAdapter.js';
import { DesktopControl } from '../dist/desktop/desktopControl.js';
import { parseManagedConfig } from '../dist/gateway/config.js';
import { loadConfig } from '../dist/config.js';
import { createRelayServer } from '../dist/server/createRelayServer.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture(enabled = true, options = {}) {
  let now = 0, starts = 0, releases = 0, crashed;
  const timers = new Set(), calls = [];
  const awake = new KeepAwake(enabled, { platform: 'darwin', pid: 42,
    now: () => now,
    setTimer(fn, ms) { const timer = { at: now + ms, fn }; timers.add(timer); return timer; }, clearTimer(timer) { timers.delete(timer); },
    async start(command, args, exited) { starts++; crashed = exited; calls.push({ command, args }); return { async release() { releases++; exited(); } }; }, ...options,
  });
  return { awake, calls, starts: () => starts, releases: () => releases, crash: () => crashed(), timers,
    async advance(ms) { now += ms; for (const timer of [...timers]) if (timer.at <= now) { timers.delete(timer); timer.fn(); } await settle(); } };
}
const reason = (agentId = 'codex', count = 1) => ({ agentId, count });

test('holds on work; releases only after all work ended for 60 seconds', async () => {
  const f = fixture(); assert.equal(f.awake.snapshot().state, 'idle');
  await f.awake.update([reason()]); assert.equal(f.starts(), 1); assert.equal(f.awake.snapshot().state, 'holding');
  await f.awake.update([]); assert.equal(f.awake.snapshot().releasing, true);
  await f.advance(59_999); assert.equal(f.releases(), 0);
  await f.advance(1); assert.equal(f.releases(), 1); assert.equal(f.awake.snapshot().state, 'idle');
  await f.awake.stop(); assert.equal(f.releases(), 1);
});

test('new work cancels grace; multiple Agents share one inhibitor', async () => {
  const f = fixture(); await f.awake.update([reason('codex', 2), reason('claude-cli', 3), reason('deepseek'), reason('opencode')]);
  assert.equal(f.starts(), 1); assert.equal(f.awake.snapshot().reasons.length, 4);
  const copy = f.awake.snapshot(); copy.reasons[0].count = 100; assert.equal(f.awake.snapshot().reasons[0].count, 2);
  await f.awake.update([]); await f.advance(30_000);
  await f.awake.update([reason('deepseek')]); await f.advance(60_000); assert.equal(f.releases(), 0); assert.equal(f.timers.size, 0);
  await f.awake.update([]); await f.advance(60_000); assert.equal(f.releases(), 1);
  await f.awake.stop();
});

test('disabled and unsupported platforms never start a process', async () => {
  for (const [enabled, platform, state] of [[false, 'darwin', 'disabled'], [true, 'win32', 'unsupported'], [true, 'freebsd', 'unsupported']]) {
    const f = fixture(enabled, { platform }); await f.awake.update([reason()]); await f.advance(60_000);
    assert.equal(f.starts(), 0); assert.equal(f.awake.snapshot().state, state); await f.awake.stop();
  }
});

test('platform command is idle-only, argv based and tied to gateway lifetime', () => {
  assert.deepEqual(inhibitorCommand('darwin', 42), { command: '/usr/bin/caffeinate', args: ['-i', '-w', '42'] });
  const linux = inhibitorCommand('linux', 42, 'synthetic-node');
  assert.equal(linux.command, 'systemd-inhibit'); assert.ok(linux.args.includes('--what=idle')); assert.ok(linux.args.includes('--mode=block'));
  assert.equal(linux.args.at(-3), 'synthetic-node'); assert.equal(linux.args.at(-2), '-e'); assert.match(linux.args.at(-1), /stdin.*end/);
  assert.equal(inhibitorCommand('win32', 42), null);
});

test('spawn failure is state only; Linux missing command skips; unexpected exit can recover', async () => {
  for (const [platform, code, state] of [['darwin', 'ENOENT', 'error'], ['linux', 'ENOENT', 'unsupported'], ['linux', 'EACCES', 'error']]) {
    const f = fixture(true, { platform, start: async () => { throw Object.assign(new Error('synthetic private detail'), { code }); } });
    await f.awake.update([reason()]); assert.equal(f.awake.snapshot().state, state);
    assert.doesNotMatch(JSON.stringify(f.awake.snapshot()), /synthetic private detail|EACCES/); await f.awake.stop();
  }
  const f = fixture(); await f.awake.update([reason()]); f.crash(); assert.equal(f.awake.snapshot().errorCode, 'KEEP_AWAKE_PROCESS_EXITED');
  await f.awake.update([reason()]); assert.equal(f.starts(), 1); await f.advance(30_000);
  await f.awake.update([reason()]); assert.equal(f.starts(), 2); assert.equal(f.awake.snapshot().state, 'holding'); await f.awake.stop();
});

test('shutdown releases once, cancels grace and ignores late updates', async () => {
  const f = fixture(); await f.awake.update([reason()]); await f.awake.update([]);
  await Promise.all([f.awake.stop(), f.awake.stop()]); await f.advance(60_000); await f.awake.update([reason()]);
  assert.equal(f.starts(), 1); assert.equal(f.releases(), 1); assert.equal(f.timers.size, 0);
});

test('shutdown and grace expiry while process start is pending do not leak the lease', async () => {
  for (const stop of [false, true]) {
    let ready, released = 0;
    const f = fixture(true, { start: () => new Promise(resolve => { ready = () => resolve({ release: async () => { released++; } }); }) });
    const work = f.awake.update([reason()]); await f.awake.update([]);
    const stopping = stop ? f.awake.stop() : f.advance(60_000);
    ready(); await work; await stopping; await settle(); assert.equal(released, 1); await f.awake.stop(); assert.equal(released, 1);
  }
});

test('gateway counts existing local/bridge state, excludes CC Desk and retains counts during read failure', async () => {
  let native = 2, remote = 3, fail = false, excluded = 0;
  const gateway = new AgentGateway([
    { snapshot: () => ({ id: 'claude-cli' }), runningCount: () => native },
    { snapshot: () => ({ id: 'opencode' }), refreshRunningCount: async () => { if (fail) throw new Error(); return remote; } },
    { snapshot: () => ({ id: 'ccdesk' }), runningCount: () => { excluded++; return 10; }, refreshRunningCount: async () => { excluded++; return 10; } },
  ]);
  assert.deepEqual((await gateway.runningCounts()).reasons, [reason('opencode', 3), reason('claude-cli', 2)]);
  native = 0; remote = 0; fail = true;
  const stale = await gateway.runningCounts(); assert.deepEqual(stale.unavailableSources, ['opencode']); assert.equal(stale.reasons.find(row => row.agentId === 'opencode').count, 3);
  fail = false; assert.equal((await gateway.runningCounts()).reasons.find(row => row.agentId === 'opencode').count, 0); assert.equal(excluded, 0);
});

test('OpenCode and DeepSeek read only their existing activity sources without opening sessions', async () => {
  const calls = [];
  const opencode = new OpenCodeAdapter({ json: async route => { calls.push(route); return { data: { a: { type: 'running' }, b: { type: 'running' } } }; } });
  const deepseek = new DeepSeekAdapter({ json: async route => { calls.push(route); return { running: 3 }; } });
  assert.equal(await opencode.refreshRunningCount(), 2); assert.equal(await deepseek.refreshRunningCount(), 3);
  assert.deepEqual(calls, ['/api/session/active', '/activity']);
  const read = DesktopControl.prototype.runningThreadIds;
  assert.deepEqual(read.call({ streamSnapshots: new Map([['a', { threadId: 'a', status: 'inProgress' }], ['b', { threadId: 'b', status: 'starting' }], ['c', { threadId: 'c', status: 'idle' }]]) }), ['a', 'b']);
});

test('monitor deduplicates live and desktop threads, works without phone watches and stops during a pending read', async () => {
  const f = fixture(); let turns = [{ threadId: 'same', turnId: 'turn-a' }], desktop = ['same', 'other'], resolve;
  const liveTurns = Object.assign(new EventEmitter(), { listActiveTurns: () => turns });
  const listeners = new Set(); let agentCount = 1, reads = 0;
  const agents = { cachedRunningCounts: () => [reason('claude-cli', agentCount)], runningCounts: async () => { reads++; return new Promise(done => { resolve = done; }); } };
  const monitor = monitorKeepAwake(f.awake, { liveTurns, desktop: { runningThreadIds: () => desktop, onStreamSnapshot: fn => { listeners.add(fn); return () => listeners.delete(fn); } }, agents }, true);
  await settle(); assert.equal(f.starts(), 1); assert.deepEqual(f.awake.snapshot().reasons, [reason('codex', 2), reason('claude-cli')]);
  turns = []; desktop = []; agentCount = 0; liveTurns.emit('snapshot'); await settle(); assert.equal(f.awake.snapshot().releasing, true);
  desktop = ['new']; for (const fn of listeners) fn(); await settle(); assert.equal(f.awake.snapshot().releasing, false);
  await monitor.stop(); resolve({ reasons: [reason('deepseek', 3)], unavailableSources: [] }); await settle();
  assert.equal(f.starts(), 1); assert.equal(f.releases(), 1); assert.equal(listeners.size, 0); assert.equal(liveTurns.listenerCount('snapshot'), 0); assert.equal(reads, 1);
});

test('disabled monitoring never queries agents or adds listeners', async () => {
  const f = fixture(false), monitor = monitorKeepAwake(f.awake, { liveTurns: {}, desktop: {}, agents: { runningCounts() { assert.fail('disabled'); } } }, false);
  await monitor.refresh(); await monitor.stop(); assert.equal(f.starts(), 0);
});

test('configuration defaults true and explicitly false survives the managed boundary', () => {
  const config = { version: 1, port: 8787, token: 'a'.repeat(32), managerKey: 'b'.repeat(32), codexHome: path.resolve('output/f5/empty'), workspace: process.cwd(), desktopTransport: 'native' };
  assert.equal(parseManagedConfig(config).keepAwake, true); assert.equal(parseManagedConfig({ ...config, keepAwake: false }).keepAwake, false);
  assert.throws(() => parseManagedConfig({ ...config, keepAwake: 'false' }), { code: 'GATEWAY_CONFIG_INVALID' });
  const before = process.env.MOBILE_CODEX_KEEP_AWAKE;
  try { delete process.env.MOBILE_CODEX_KEEP_AWAKE; assert.equal(loadConfig().keepAwake, true); process.env.MOBILE_CODEX_KEEP_AWAKE = 'false'; assert.equal(loadConfig().keepAwake, false); }
  finally { if (before === undefined) delete process.env.MOBILE_CODEX_KEEP_AWAKE; else process.env.MOBILE_CODEX_KEEP_AWAKE = before; }
});

test('diagnostics are authenticated and shutdown releases the injected process even without phone watchers', async t => {
  await fs.mkdir('output/f5', { recursive: true }); const root = await fs.mkdtemp(path.resolve('output/f5/gateway-'));
  let count = 2, starts = 0, releases = 0;
  const liveTurns = Object.assign(new EventEmitter(), { listActiveTurns: () => Array.from({ length: count }, (_, i) => ({ threadId: `synthetic-${i}` })), stop: async () => {} });
  const app = await createRelayServer({ logger: false, config: { host: '', port: 0, token: 'synthetic', defaultCwd: root, codexHome: path.join(root, 'empty') },
    keepAwakePorts: { platform: 'darwin', start: async () => { starts++; return { release: async () => { releases++; } }; } },
    services: { liveTurns, desktopControl: { stop: async () => {} } } });
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  assert.equal((await app.inject('/api/diagnostics')).statusCode, 401);
  const report = (await app.inject({ url: '/api/diagnostics', headers: { authorization: 'Bearer synthetic' } })).json();
  assert.equal(report.keepAwake.state, 'holding'); assert.deepEqual(report.keepAwake.reasons, [reason('codex', 2)]);
  assert.doesNotMatch(JSON.stringify(report), /synthetic-0/); assert.ok(!JSON.stringify(report).includes(root));
  count = 0; liveTurns.emit('snapshot'); await settle(); await app.close(); assert.equal(starts, 1); assert.equal(releases, 1);
});

test('monitor retains desktop follow only until idle and handles local Agent events without bridge polling', async () => {
  const f = fixture(); let running = ['desktop-one'], count = 0, reads = 0, followed = 0, released = 0, activity;
  const listeners = new Set(), liveTurns = Object.assign(new EventEmitter(), { listActiveTurns: () => [] });
  const desktop = { runningThreadIds: () => running, onStreamSnapshot(fn) { listeners.add(fn); return () => listeners.delete(fn); }, followThread() { followed++; return () => { released++; }; } };
  const agents = { cachedRunningCounts: () => [reason('claude-cli', count)], async runningCounts() { reads++; return { unavailableSources: [] }; }, onActivity(fn) { activity = fn; return () => { activity = null; }; } };
  const monitor = monitorKeepAwake(f.awake, { liveTurns, desktop, agents }, true); await settle(); assert.equal(followed, 1);
  running = []; for (const fn of listeners) fn(); await settle(); assert.equal(released, 1); assert.equal(f.awake.snapshot().releasing, true);
  count = 1; activity(); await settle(); assert.equal(f.awake.snapshot().releasing, false); assert.equal(reads, 1);
  count = 0; activity(); await settle(); await f.advance(60_000); assert.equal(f.releases(), 1);
  await monitor.stop(); assert.equal(activity, null); assert.equal(released, 1);
});

test('OS inhibitor is released even if a desktop subscription cleanup throws', async () => {
  const f = fixture();
  const monitor = monitorKeepAwake(f.awake, {
    liveTurns: Object.assign(new EventEmitter(), { listActiveTurns: () => [] }),
    desktop: { runningThreadIds: () => ['synthetic'], followThread: () => () => { throw new Error('synthetic cleanup'); } },
    agents: { cachedRunningCounts: () => [], async runningCounts() { return { unavailableSources: [] }; } },
  }, true);
  await settle(); assert.equal(f.starts(), 1); await monitor.stop(); assert.equal(f.releases(), 1);
});
