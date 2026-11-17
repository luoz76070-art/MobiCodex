import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { ClaudeCliAdapter, claudeCliConfigSchema } from '../dist/agents/claudeCliAdapter.js';
import { createAgentGateway } from '../dist/agents/agentGateway.js';
import { parseManagedConfig } from '../dist/gateway/config.js';
import { createRelayServer } from '../dist/server/createRelayServer.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { const end = Date.now() + 2500; while (!predicate()) { assert.ok(Date.now() < end, 'fixture timeout'); await sleep(5); } }
async function fixture(t, count = 1, pollMs = 15) {
  await fs.mkdir('output/c4a-tests', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('output/c4a-tests/adapter-'));
  const allowed = path.join(root, 'allowed'), nested = path.join(allowed, 'project'), outside = path.join(root, 'outside');
  await Promise.all([fs.mkdir(nested, { recursive: true }), fs.mkdir(outside)]);
  const infos = Array.from({ length: count }, (_, index) => ({ sessionId: randomUUID(), summary: `Session ${index}`, firstPrompt: `Question ${index}`, cwd: index % 2 ? allowed : nested, lastModified: 2000 - index, fileSize: 1 }));
  const rows = new Map(infos.map(info => [info.sessionId, []])), calls = [], registered = new Set();
  const sdk = {
    async listSessions(options) { calls.push(['list', options]); return structuredClone(infos.filter(info => !options?.dir || info.cwd === options.dir)); },
    async getSessionInfo(id, options) { calls.push(['info', options]); return structuredClone(infos.find(info => info.sessionId === id && info.cwd === options.dir)); },
    async getSessionMessages(id, options) { calls.push(['messages', options]); return structuredClone(rows.get(id) ?? []); },
  };
  const adapter = new ClaudeCliAdapter({ directories: [allowed, nested] }, sdk, async id => registered.has(id), pollMs);
  t.after(async () => { await adapter.stop(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, allowed, nested, outside, infos, rows, calls, sdk, adapter, registered };
}
const row = (id, index, content = `Body ${index}`) => ({ session_id: id, uuid: `message-${index}`, type: index % 2 ? 'assistant' : 'user', parent_tool_use_id: null, parent_agent_id: null, message: { content } });

test('missing or empty config stays disabled without any SDK reads; schema accepts only absolute directory lists', async t => {
  const f = await fixture(t);
  for (const config of [undefined, { directories: [] }]) {
    const adapter = new ClaudeCliAdapter(config, f.sdk);
    assert.equal(adapter.snapshot().enabled, false); assert.equal(adapter.snapshot().errorCode, 'CLAUDE_CLI_DISABLED');
    assert.ok(Object.values(adapter.snapshot().capabilities).every(value => value === false));
    await assert.rejects(adapter.listSessions(), { code: 'CLAUDE_CLI_DISABLED', statusCode: 409 }); await adapter.stop();
  }
  assert.equal(f.calls.length, 0);
  for (const config of [{ directories: ['relative'] }, { directories: [f.allowed + '\0'] }, { directories: [f.allowed], extra: true }]) assert.equal(claudeCliConfigSchema.safeParse(config).success, false);
  const config = { version: 1, port: 8787, token: 'a'.repeat(48), managerKey: 'b'.repeat(48), codexHome: f.root, workspace: f.root, desktopTransport: 'native', claudeCli: { directories: [f.allowed] } };
  assert.deepEqual(parseManagedConfig(config).claudeCli, config.claudeCli);
  assert.throws(() => parseManagedConfig({ ...config, claudeCli: { directories: ['relative'] } }), { code: 'GATEWAY_CONFIG_INVALID' });
  const gateway = createAgentGateway({ codexHome: f.root }, { claudeCliSdk: f.sdk }); t.after(() => gateway.stop());
  assert.equal(gateway.snapshot().find(agent => agent.id === 'claude-cli').enabled, false);
});

test('realpath allowlist rejects sibling prefixes, dot-dot escapes, symlink escapes and absent cwd before reading messages', async t => {
  const f = await fixture(t), prefix = path.join(f.root, 'allowed-sibling'), link = path.join(f.allowed, 'escape');
  await fs.mkdir(prefix); await fs.symlink(f.outside, link, 'dir');
  const paths = [f.outside, path.join(f.allowed, '..', 'outside'), link, prefix, undefined, 'relative'];
  const denied = paths.map(cwd => ({ ...f.infos[0], sessionId: randomUUID(), cwd })); f.infos.push(...denied);
  assert.deepEqual((await f.adapter.listSessions()).sessions.map(session => session.id), [f.infos[0].sessionId]);
  for (const info of denied) await assert.rejects(f.adapter.watchSession(info.sessionId, () => {}, () => {}), { code: 'CLAUDE_CLI_SESSION_NOT_ALLOWED' });
  assert.equal(f.calls.filter(([name]) => name === 'messages').length, 0);
  const rootLink = path.join(f.root, 'root-link'); await fs.symlink(f.allowed, rootLink, 'dir');
  const adapter = new ClaudeCliAdapter({ directories: [rootLink] }, f.sdk); t.after(() => adapter.stop());
  assert.equal((await adapter.listSessions()).sessions.length, 1);
  const off = await adapter.watchSession(f.infos[0].sessionId, () => {}, () => {}); off();
  assert.ok(f.calls.filter(([name]) => name === 'messages').every(([, options]) => options.dir === f.nested));
});

test('merged list deduplicates, sorts, searches title/first prompt and signs keyset cursors without paths', async t => {
  const f = await fixture(t, 113); f.infos[1].lastModified = f.infos[0].lastModified;
  f.infos[0].customTitle = 'Unique title'; f.infos[100].firstPrompt = 'Needle first sentence'; f.registered.add(f.infos[0].sessionId);
  let cursor, sessions = [];
  do { const page = await f.adapter.listSessions('', cursor); assert.ok(page.sessions.length <= 50); sessions.push(...page.sessions); cursor = page.cursor; if (cursor) assert.ok(!Buffer.from(cursor.split('.')[0], 'base64url').toString().includes(f.root)); } while (cursor);
  assert.equal(sessions.length, 113); assert.equal(new Set(sessions.map(session => session.id)).size, 113);
  assert.ok(sessions.every((session, i) => !i || session.updatedAt <= sessions[i - 1].updatedAt));
  assert.ok(sessions.every(session => ['project', 'allowed'].includes(session.directory)));
  assert.equal(sessions.find(session => session.id === f.infos[0].sessionId).desktopOpen, true);
  assert.equal((await f.adapter.listSessions('UNIQUE')).sessions[0].id, f.infos[0].sessionId);
  assert.equal((await f.adapter.listSessions('needle')).sessions[0].id, f.infos[100].sessionId);
  const first = await f.adapter.listSessions();
  await assert.rejects(f.adapter.listSessions('different', first.cursor), { code: 'CLAUDE_CLI_CURSOR_INVALID' });
  await assert.rejects(f.adapter.listSessions('', first.cursor + 'x'), { code: 'CLAUDE_CLI_CURSOR_INVALID' });
});

test('authorized symlink project keys remain readable, while retargeting during a read discards the result', async t => {
  const f = await fixture(t), id = f.infos[0].sessionId, alias = path.join(f.allowed, 'alias');
  await fs.symlink(f.nested, alias, 'dir'); f.infos[0].cwd = alias; f.rows.set(id, [row(id, 0)]);
  let snapshot;
  const off = await f.adapter.watchSession(id, value => { snapshot = value; }, () => {}); off();
  assert.equal(snapshot.messages.length, 1); assert.equal(snapshot.session.directory, 'project');
  const read = f.sdk.getSessionMessages;
  f.sdk.getSessionMessages = async (...args) => { await fs.unlink(alias); await fs.symlink(f.outside, alias, 'dir'); return read(...args); };
  let published = 0;
  await assert.rejects(f.adapter.watchSession(id, () => published++, () => {}), { code: 'CLAUDE_CLI_SESSION_NOT_ALLOWED' });
  assert.equal(published, 0);
});

test('history walks backward through more than the render budget, with text/tool summaries and no thinking or tool arguments', async t => {
  const f = await fixture(t), id = f.infos[0].sessionId, rows = Array.from({ length: 271 }, (_, index) => row(id, index));
  rows.push(row(id, 271, [{ type: 'thinking', thinking: 'PRIVATE' }, { type: 'text', text: 'Visible' }, { type: 'tool_use', name: 'Read', input: { private: 'PRIVATE' } }, { type: 'tool_result', content: 'PRIVATE' }]));
  rows.push({ ...row(id, 272, 'PRIVATE'), type: 'system' }, { ...row(id, 273, 'PRIVATE'), parent_tool_use_id: 'nested' }, { ...row(id, 274, 'PRIVATE'), parent_agent_id: 'nested' });
  f.rows.set(id, rows); let snapshot;
  const off = await f.adapter.watchSession(id, value => { snapshot = value; }, () => {}); off();
  assert.equal(snapshot.messages.length, 50); assert.equal(snapshot.readOnly, '只读预览，发送功能下一版提供');
  assert.ok(Object.entries(snapshot.control).filter(([key]) => key !== 'token').every(([, value]) => value === false));
  assert.equal(snapshot.messages.at(-1).text, 'Visible\n工具调用：Read\n工具执行结果');
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE/); assert.ok(snapshot.messages.every(message => message.timestamp === ''));
  let cursor = snapshot.historyCursor, all = snapshot.messages;
  do { const page = await f.adapter.readHistory(id, cursor); all = [...page.messages, ...all]; cursor = page.cursor; } while (cursor);
  assert.deepEqual(all.map(message => message.id), rows.slice(0, 272).map(message => message.uuid));
  await assert.rejects(f.adapter.readHistory(randomUUID(), snapshot.historyCursor), { code: 'CLAUDE_CLI_CURSOR_INVALID' });
  f.rows.set(id, rows.slice(10));
  await assert.rejects(f.adapter.readHistory(id, snapshot.historyCursor), { code: 'CLAUDE_CLI_HISTORY_CHANGED', statusCode: 409 });
});

test('every mutation is explicitly read-only even when enabled, disabled or stopped', async t => {
  const f = await fixture(t);
  for (const adapter of [f.adapter, new ClaudeCliAdapter(undefined, f.sdk)]) {
    for (const state of ['active', 'stopped']) {
      if (state === 'stopped') await adapter.stop();
      for (const method of ['sendMessage', 'interruptSession', 'respondQuestion', 'respondPermission']) await assert.rejects(adapter[method](), { code: 'CLAUDE_CLI_READ_ONLY', statusCode: 409 });
    }
  }
  assert.equal(f.calls.length, 0);
});

test('live follow reads only while watched, shares polling, refreshes changed records and registration, and releases the last watcher', async t => {
  const f = await fixture(t), id = f.infos[0].sessionId; await sleep(25); assert.equal(f.calls.length, 0);
  f.rows.set(id, [row(id, 0)]); const values = [], second = [];
  const off = await f.adapter.watchSession(id, value => values.push(value), () => {});
  const offSecond = await f.adapter.watchSession(id, value => second.push(value), () => {});
  const reads = () => f.calls.filter(([name]) => name === 'messages').length;
  assert.equal(reads(), 1); await sleep(45); assert.equal(reads(), 1);
  f.rows.get(id).push(row(id, 1)); f.infos[0].fileSize++;
  await until(() => values.at(-1).messages.length === 2); assert.equal(second.at(-1).messages.length, 2);
  f.registered.add(id); await until(() => values.at(-1).session.desktopOpen);
  off(); const count = values.length; f.infos[0].fileSize++; await until(() => second.length > count);
  assert.equal(values.length, count); offSecond(); const calls = f.calls.length; await sleep(45); assert.equal(f.calls.length, calls);
});

test('a changed cwd revokes a running subscription without reading the replacement directory', async t => {
  const f = await fixture(t), id = f.infos[0].sessionId; let disconnected = 0;
  await f.adapter.watchSession(id, () => {}, () => disconnected++); const reads = f.calls.filter(([name]) => name === 'messages').length;
  f.infos[0].cwd = f.outside; await until(() => disconnected === 1);
  assert.equal(f.calls.filter(([name]) => name === 'messages').length, reads);
});

test('stop during an SDK read prevents a late snapshot or restarted polling', async t => {
  const f = await fixture(t), id = f.infos[0].sessionId; let release, entered = false, snapshots = 0;
  f.sdk.getSessionMessages = async () => { entered = true; return new Promise(resolve => { release = resolve; }); };
  const watch = f.adapter.watchSession(id, () => snapshots++, () => {}); await until(() => entered); await f.adapter.stop(); release([]);
  await assert.rejects(watch, { code: 'CLAUDE_CLI_STOPPED' }); assert.equal(snapshots, 0);
  const count = f.calls.length; await sleep(35); assert.equal(f.calls.length, count);
});

test('default HTTP factory wires config, authentication, plugin registration lookup and read-only 409 responses', async t => {
  const f = await fixture(t), id = f.infos[0].sessionId;
  const config = { host: '', port: 0, token: 'synthetic-admin', codexHome: path.join(f.root, 'empty-codex'), defaultCwd: f.root, claudeCli: { directories: [f.allowed] }, claude: { bridgeToken: 'synthetic-bridge-key-'.repeat(3) } };
  const app = await createRelayServer({ logger: false, config, services: { claudeCliSdk: f.sdk, desktopControl: { stop: async () => {} } } }); t.after(() => app.close());
  const auth = { authorization: `Bearer ${config.token}` }, route = '/api/agents/claude-cli/sessions';
  assert.equal((await app.inject({ url: route })).statusCode, 401);
  assert.equal((await app.inject({ url: '/api/agents', headers: auth })).json().agents.find(agent => agent.id === 'claude-cli').label, 'Claude CLI');
  assert.equal((await app.inject({ url: route, headers: auth })).json().sessions[0].desktopOpen, false);
  assert.equal((await app.inject({ method: 'POST', url: '/api/claude-bridge/register', headers: { authorization: `Bearer ${config.claude.bridgeToken}` }, payload: { sessionId: id, activationId: randomUUID(), version: '2.1.287', directory: f.nested, turnId: null } })).statusCode, 200);
  assert.equal((await app.inject({ url: route, headers: auth })).json().sessions[0].desktopOpen, true);
  for (const key of ['dir', 'directory', 'cwd', 'range']) assert.equal((await app.inject({ url: `${route}?${key}=arbitrary`, headers: auth })).statusCode, 400);
  const op = { controlToken: randomUUID(), clientMessageId: randomUUID() };
  for (const [suffix, extra] of [['messages', { text: 'Synthetic', delivery: 'queue' }], ['interrupt', {}], [`questions/${randomUUID()}/respond`, { answers: [['Synthetic']] }], [`permissions/${randomUUID()}/respond`, { decision: 'once' }]]) {
    const result = await app.inject({ method: 'POST', url: `${route}/${id}/${suffix}`, headers: auth, payload: { ...op, ...extra, clientMessageId: randomUUID() } });
    assert.equal(result.statusCode, 409); assert.equal(result.json().error, 'CLAUDE_CLI_READ_ONLY');
  }
  assert.equal(f.calls.filter(([name]) => name === 'messages').length, 0);
});

test('installed official SDK reads isolated records with no login, network or child processes and no native CLI', async t => {
  const f = await fixture(t);
  const { stdout } = await promisify(execFile)(process.execPath, ['apps/relay/tests/fixtures/claudeCliSdk.mjs'], {
    env: { PATH: '', HOME: f.root, USERPROFILE: f.root, CLAUDE_CONFIG_DIR: path.join(f.root, 'sdk-config'), C4A_TEST_ROOT: f.root }, timeout: 10000,
  });
  assert.deepEqual(JSON.parse(stdout), { sessions: 1, messages: 2, processAttempts: 0, networkAttempts: 0, nativePackages: 0 });
});
