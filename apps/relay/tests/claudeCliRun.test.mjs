import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ClaudeCliAdapter, claudeCliConfigSchema } from '../dist/agents/claudeCliAdapter.js';
import { compatibleClaudeVersion, claudeCliMinimumVersion, resolveClaudeCliExecutable } from '../dist/agents/claudeCliExecutable.js';
import { ClaudeCliRuntime, claudeCliDenial } from '../dist/agents/claudeCliRuntime.js';
import { createRelayServer } from '../dist/server/createRelayServer.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { const deadline = Date.now() + 2500; while (!check()) { assert.ok(Date.now() < deadline, 'fixture timeout'); await sleep(5); } }
class Frames {
  values = []; wake = null; ended = false; failure = null;
  push(value) { this.values.push(value); this.wake?.(); }
  close() { this.ended = true; this.wake?.(); }
  crash() { this.failure = new Error('synthetic process failure'); this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (!this.ended) {
      if (this.failure) throw this.failure;
      const next = this.values.shift();
      if (next) yield next; else await new Promise(resolve => { this.wake = resolve; });
    }
  }
}
async function fixture(t, ports = {}) {
  await fs.mkdir('output/c4b-tests', { recursive: true });
  const root = await fs.mkdtemp(path.resolve('output/c4b-tests/run-'));
  const directory = path.join(root, 'project'), outside = path.join(root, 'outside');
  await fs.mkdir(directory); await fs.mkdir(outside);
  const id = randomUUID(), infos = [{ sessionId: id, cwd: directory, summary: 'Synthetic session', firstPrompt: 'Synthetic first prompt', lastModified: 1000, fileSize: 1 }];
  const runs = [], registered = new Set(), rows = new Map();
  const sdk = {
    async listSessions() { return structuredClone(infos); },
    async getSessionInfo(id) { return structuredClone(infos.find(info => info.sessionId === id)); },
    async getSessionMessages(id) { return structuredClone(rows.get(id) ?? []); },
    query(input) {
      const frames = new Frames();
      const run = { input, frames, inputs: [], interrupts: 0, closes: 0 };
      runs.push(run);
      void (async () => { for await (const message of input.prompt) run.inputs.push(message); })();
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), async interrupt() { run.interrupts++; }, close() { run.closes++; frames.close(); } };
    },
  };
  let versionReads = 0;
  const adapter = new ClaudeCliAdapter({ directories: [directory] }, sdk, async id => registered.has(id), 15, {
    resolveExecutable: async () => { versionReads++; return { executable: process.execPath, version: claudeCliMinimumVersion }; }, ...ports,
  });
  t.after(async () => { await adapter.stop(); await fs.rm(root, { recursive: true, force: true }); });
  const snapshots = [];
  const off = await adapter.watchSession(id, snapshot => snapshots.push(snapshot), () => {});
  const current = () => snapshots.at(-1);
  const operation = text => ({ controlToken: current().control.token, clientMessageId: randomUUID(), text: text ?? 'Synthetic input', delivery: 'queue' });
  const frame = (type, extra = {}, run = runs.at(-1)) => run.frames.push({ type, uuid: randomUUID(), session_id: run.input.options.resume ?? run.input.options.sessionId, parent_tool_use_id: null, ...extra });
  const result = (extra = {}, run) => frame('result', { subtype: 'success', is_error: false, ...extra }, run);
  return { adapter, root, directory, outside, id, infos, rows, sdk, runs, registered, snapshots, current, operation, frame, result, off, versionReads: () => versionReads };
}

test('paired SDK metadata defines the compatibility floor; fake CLI runs only --version once', async t => {
  const f = await fixture(t);
  const require = createRequire(import.meta.url), sdkPath = require.resolve('@anthropic-ai/claude-agent-sdk');
  const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(sdkPath), 'package.json'), 'utf8'));
  assert.equal(manifest.version, '0.3.326'); assert.equal(manifest.claudeCodeVersion, claudeCliMinimumVersion);
  for (const [version, expected] of [['2.1.325', false], ['2.1.326', true], ['2.2.0', true], ['3.0.0', true], ['invalid', false]]) assert.equal(compatibleClaudeVersion(version), expected);
  const executable = path.join(f.root, 'fake-claude');
  await fs.writeFile(executable, '#!/usr/bin/env node\nif (process.argv.length !== 3 || process.argv[2] !== "--version") process.exit(99);\nconsole.log("2.1.326 (Claude Code)");\n', { mode: 0o700 });
  assert.deepEqual(await resolveClaudeCliExecutable(executable), { executable, version: '2.1.326' });
  await Promise.all([f.adapter.ready(), f.adapter.ready(), f.adapter.probe()]); assert.equal(f.versionReads(), 1);
  assert.equal(claudeCliConfigSchema.safeParse({ directories: [f.directory], executable: 'relative' }).success, false);
  await assert.rejects(resolveClaudeCliExecutable(path.join(f.root, 'missing')), { code: 'CLAUDE_CLI_EXECUTABLE_NOT_FOUND' });
});

test('create uses an opaque configured-root choice; resume uses the original session and all required SDK options', async t => {
  const f = await fixture(t), directories = await f.adapter.listDirectories();
  assert.equal(directories.directories[0].label, 'project'); assert.ok(!JSON.stringify(directories).includes(f.root));
  for (const directory of [f.outside, f.directory, '../outside', directories.directories[0].id + 'bad']) await assert.rejects(f.adapter.createSession({ directory, text: 'Synthetic' }), { code: 'CLAUDE_CLI_SESSION_NOT_ALLOWED' });
  const created = await f.adapter.createSession({ directory: directories.directories[0].id, text: 'Synthetic creation' });
  const run = f.runs[0]; await until(() => run.inputs.length === 1);
  assert.equal(run.input.options.sessionId, created.session.id); assert.equal(run.input.options.resume, undefined);
  assert.equal(created.session.directory, 'project'); assert.ok((await f.adapter.listSessions()).sessions.some(session => session.id === created.session.id));
  await f.adapter.sendMessage(f.id, f.operation());
  const resumed = f.runs[1]; await until(() => resumed.inputs.length === 1);
  assert.equal(resumed.input.options.resume, f.id); assert.equal(resumed.input.options.cwd, f.directory);
  assert.equal(resumed.input.options.pathToClaudeCodeExecutable, process.execPath);
  assert.equal(resumed.input.options.includePartialMessages, true); assert.equal(resumed.input.options.permissionMode, 'default');
  assert.deepEqual(resumed.input.options.settingSources, ['user', 'project', 'local']); assert.ok(Object.keys(process.env).length === Object.keys(resumed.input.options.env).length && Object.entries(process.env).every(([key, value]) => resumed.input.options.env[key] === value), "inherits the gateway environment without adding credentials");
  assert.equal(resumed.input.options.allowDangerouslySkipPermissions, undefined);
});

test('queue waits for result; steer immediately appends; interrupt and terminal outcomes reach the shared snapshot', async t => {
  const f = await fixture(t), first = f.operation('First'); await f.adapter.sendMessage(f.id, first);
  await until(() => f.runs[0].inputs.length === 1);
  const queued = f.operation('Queued'); await f.adapter.sendMessage(f.id, queued);
  const steered = { ...f.operation('Steered'), delivery: 'steer' }; await f.adapter.sendMessage(f.id, steered);
  await until(() => f.runs[0].inputs.length === 2);
  assert.deepEqual(f.runs[0].inputs.map(message => message.message.content), ['First', 'Steered']);
  assert.equal(f.runs[0].inputs[1].priority, 'now'); assert.equal(f.current().queue.items[0].clientMessageId, queued.clientMessageId);
  const canceled = f.operation('Canceled'); await f.adapter.sendMessage(f.id, canceled);
  await f.adapter.cancelQueuedMessage(f.id, canceled.clientMessageId, f.operation());
  assert.equal(f.current().queue.items.length, 1);
  f.result(); await until(() => f.runs[0].inputs.length === 3);
  await assert.rejects(f.adapter.cancelQueuedMessage(f.id, queued.clientMessageId, f.operation()), { code: 'CLAUDE_CLI_QUEUE_ITEM_UNAVAILABLE' });
  assert.equal(f.current().lastTurn.status, 'completed'); assert.equal(f.current().status, 'running');
  assert.equal(f.runs[0].inputs[2].message.content, 'Queued');
  await f.adapter.interruptSession(f.id, f.operation()); assert.equal(f.runs[0].interrupts, 1);
  f.result({ is_error: true }); await until(() => f.current().status === 'idle'); assert.equal(f.current().lastTurn.status, 'interrupted');
  await f.adapter.sendMessage(f.id, f.operation()); f.result({ subtype: 'error_during_execution', is_error: true });
  await until(() => f.current().status === 'idle'); assert.equal(f.current().lastTurn.status, 'failed');
  assert.equal(f.runs.length, 1);
});

test('stream partials merge into complete messages, hide reasoning/subagents/tool arguments and report activity', async t => {
  const f = await fixture(t); await f.adapter.sendMessage(f.id, f.operation());
  f.frame('stream_event', { event: { type: 'message_start', message: { id: 'api-message' } } });
  f.frame('stream_event', { event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'PRIVATE REASONING' } } });
  await until(() => f.current().activityEvidence.kind === 'thinking');
  f.frame('stream_event', { event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } });
  f.frame('stream_event', { event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Visible partial' } } });
  await until(() => f.current().messages.some(message => message.text === 'Visible partial'));
  assert.equal(f.current().activityEvidence.kind, 'outputting');
  f.frame('stream_event', { event: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', name: 'Read', input: { secret: 'PRIVATE ARGS' } } } });
  await until(() => f.current().activityEvidence.kind === 'working');
  f.frame('assistant', { uuid: 'canonical-message', message: { content: [{ type: 'thinking', thinking: 'PRIVATE REASONING' }, { type: 'text', text: 'Visible final' }, { type: 'tool_use', name: 'Read', input: { secret: 'PRIVATE ARGS' } }] } });
  f.frame('assistant', { parent_tool_use_id: 'subagent', message: { content: [{ type: 'text', text: 'PRIVATE CHILD' }] } });
  f.result(); await until(() => f.current().status === 'idle');
  assert.equal(f.current().messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal(f.current().messages.at(-1).text, 'Visible final\n工具调用：Read');
  assert.doesNotMatch(JSON.stringify(f.snapshots), /PRIVATE/); assert.equal(f.current().activityEvidence, null);
});

test('plugin registration and recent external writes reject before query, including a registration race', async t => {
  const f = await fixture(t);
  f.registered.add(f.id); await assert.rejects(f.adapter.sendMessage(f.id, f.operation()), { code: 'CLAUDE_CLI_SESSION_BUSY', statusCode: 409 });
  f.registered.clear(); f.infos[0].lastModified = Date.now();
  await assert.rejects(f.adapter.sendMessage(f.id, f.operation()), { code: 'CLAUDE_CLI_SESSION_BUSY' });
  f.infos[0].lastModified = 1000;
  const original = f.sdk.getSessionMessages; f.sdk.getSessionMessages = async id => { f.registered.add(id); return original(id); };
  await assert.rejects(f.adapter.sendMessage(f.id, f.operation()), { code: 'CLAUDE_CLI_SESSION_BUSY' }); assert.equal(f.runs.length, 0);
});

test('root escape and symlink retarget are refused at the execution boundary', async t => {
  const f = await fixture(t), link = path.join(f.directory, 'alias'); await fs.symlink(f.outside, link, 'dir');
  f.infos[0].cwd = link;
  await assert.rejects(f.adapter.sendMessage(f.id, f.operation()), { code: 'CLAUDE_CLI_SESSION_NOT_ALLOWED' });
  f.infos[0].cwd = path.join(f.directory, '..', 'outside');
  await assert.rejects(f.adapter.sendMessage(f.id, f.operation()), { code: 'CLAUDE_CLI_SESSION_NOT_ALLOWED' });
  assert.equal(f.runs.length, 0);
});

test('resume preserves the authorized SDK project alias and rechecks a retarget before later sends', async t => {
  const f = await fixture(t), alias = path.join(f.root, 'project-alias');
  await fs.symlink(f.directory, alias, 'dir'); f.infos[0].cwd = alias;
  await f.adapter.sendMessage(f.id, f.operation()); assert.equal(f.runs[0].input.options.cwd, alias);
  await fs.unlink(alias); await fs.symlink(f.outside, alias, 'dir');
  await assert.rejects(f.adapter.sendMessage(f.id, f.operation()), { code: 'CLAUDE_CLI_SESSION_NOT_ALLOWED' });
  assert.equal(f.runs.length, 1);
});

test('reclaimed process can resume its own unchanged recent record, but rejects a subsequent external edit', async t => {
  const f = await fixture(t, { idleMs: 25 });
  await f.adapter.sendMessage(f.id, f.operation()); f.infos[0].lastModified = Date.now(); f.infos[0].fileSize = 200;
  f.result(); await until(() => f.current().status === 'idle'); f.off();
  await until(() => f.runs[0].closes === 1);
  await f.adapter.sendMessage(f.id, f.operation('Resume unchanged'));
  f.result(); await until(() => f.runs.length === 2 && f.runs[1].closes === 1);
  f.infos[0].fileSize++;
  await assert.rejects(f.adapter.sendMessage(f.id, f.operation('External edit')), { code: 'CLAUDE_CLI_SESSION_BUSY' });
});

test('a failing subscriber releases its viewer; crash preserves unsent queue text and late subscribers see unsaved failures', async t => {
  const f = await fixture(t, { idleMs: 25 });
  await f.adapter.sendMessage(f.id, f.operation()); await f.adapter.sendMessage(f.id, f.operation('Unsent synthetic input'));
  f.runs[0].frames.crash(); await until(() => f.current().lastTurn?.status === 'failed');
  assert.ok(f.current().messages.some(message => message.role === 'system' && message.text.includes('Unsent synthetic input')));
  const directory = (await f.adapter.listDirectories()).directories[0].id;
  const created = await f.adapter.createSession({ directory, text: 'Startup fails' }); f.runs[1].frames.crash();
  await until(() => f.runs[1].closes === 1);
  let last;
  const off = await f.adapter.watchSession(created.session.id, value => { last = value; }, () => {});
  assert.equal(last.lastTurn.status, 'failed'); assert.equal(last.control.canSend, false); assert.match(last.readOnly, /会话记录尚未保存/); off();
  const next = await f.adapter.createSession({ directory, text: 'Throwing viewer' });
  await f.adapter.watchSession(next.session.id, () => { throw new Error('synthetic subscriber'); }, () => {});
  f.result(); await until(() => f.runs[2].closes === 1);
});

test('concurrent creates reserve at most three processes; viewers prevent idle reclamation; stop closes once', async t => {
  const f = await fixture(t, { idleMs: 35 }), directory = (await f.adapter.listDirectories()).directories[0].id;
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => f.adapter.createSession({ directory, text: `Synthetic ${i}` })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 3);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'CLAUDE_CLI_BUSY_LIMIT'));
  const created = results.find(result => result.status === 'fulfilled').value.session;
  const off = await f.adapter.watchSession(created.id, () => {}, () => {});
  for (const run of f.runs) f.result({}, run);
  await until(() => f.runs.filter(run => run.closes).length === 2);
  assert.equal(f.runs.find(run => run.input.options.sessionId === created.id).closes, 0);
  off(); await until(() => f.runs.every(run => run.closes === 1));
  await f.adapter.createSession({ directory, text: 'Reclaimed capacity' });
  await f.adapter.stop(); await f.adapter.stop(); assert.ok(f.runs.every(run => run.closes === 1));
});

test('concurrent first sends share one process and shutdown fences version checks in flight', async t => {
  const f = await fixture(t); await Promise.all([f.adapter.sendMessage(f.id, f.operation()), f.adapter.sendMessage(f.id, f.operation())]);
  assert.equal(f.runs.length, 1); assert.equal(f.current().queue.items.length, 1);
  let release;
  const runtime = new ClaudeCliRuntime(f.sdk.query, undefined, () => {}, { resolveExecutable: () => new Promise(resolve => { release = resolve; }) });
  const pending = runtime.start(f.current(), f.directory, f.operation(), true);
  await until(() => Boolean(release)); runtime.stop(); release({ executable: process.execPath, version: claudeCliMinimumVersion });
  await assert.rejects(pending, { code: 'CLAUDE_CLI_STOPPED' }); assert.equal(f.runs.length, 1);

});

test('process crash is isolated with a failed lastTurn and allows a clean resume', async t => {
  const f = await fixture(t); await f.adapter.sendMessage(f.id, f.operation()); f.runs[0].frames.crash();
  await until(() => f.current().lastTurn?.status === 'failed');
  assert.equal(f.current().lastTurn.reason.code, 'CLAUDE_CLI_PROCESS_FAILED'); assert.equal(f.runs[0].closes, 1);
  await f.adapter.sendMessage(f.id, f.operation('Retry')); assert.equal(f.runs.length, 2);
});

test('clean stream completion after a result preserves the completed turn and releases capacity', async t => {
  const f = await fixture(t); await f.adapter.sendMessage(f.id, f.operation()); f.result();
  await until(() => f.current().lastTurn?.status === 'completed'); f.runs[0].frames.close();
  await until(() => f.runs[0].closes === 1); assert.equal(f.current().lastTurn.status, 'completed');
});

test('live history cursor advances with persisted records instead of skipping messages evicted from the live window', async t => {
  const f = await fixture(t);
  const rows = count => Array.from({ length: count }, (_, i) => ({ session_id: f.id, uuid: `history-${i}`, type: 'assistant', parent_tool_use_id: null, parent_agent_id: null, message: { content: `Synthetic history ${i}` } }));
  f.rows.set(f.id, rows(70)); f.infos[0].fileSize = 70;
  await f.adapter.sendMessage(f.id, f.operation()); const initial = f.current().historyCursor;
  f.rows.set(f.id, rows(190)); f.infos[0].fileSize = 190;
  for (let i = 70; i < 190; i++) f.frame('assistant', { uuid: `history-${i}`, message: { content: [{ type: 'text', text: `Synthetic history ${i}` }] } });
  await until(() => f.current().historyCursor !== initial);
  const older = await f.adapter.readHistory(f.id, f.current().historyCursor);
  assert.equal(older.messages.at(-1).id, 'history-139');
  assert.ok(f.current().messages.some(message => message.id === 'history-140'));
});

test('old/missing executable disables sending and exposes a safe specific Agent error', async t => {
  const f = await fixture(t, { resolveExecutable: async () => ({ executable: process.execPath, version: '2.1.1' }) });
  assert.equal(f.adapter.snapshot().state, 'failed'); assert.equal(f.current().control.canSend, false);
  assert.equal(f.adapter.snapshot().errorMessage, '请升级 Claude Code（当前 2.1.1，需要 ≥ 2.1.326）');
  await assert.rejects(f.adapter.sendMessage(f.id, f.operation()), { code: 'CLAUDE_CLI_VERSION_TOO_OLD' }); assert.equal(f.runs.length, 0);
  const other = new ClaudeCliAdapter({ directories: [f.directory] }, f.sdk, undefined, 15, { resolveExecutable: async () => { throw Object.assign(new Error('private details'), { code: 'CLAUDE_CLI_EXECUTABLE_NOT_FOUND' }); } });
  t.after(() => other.stop()); await other.ready(); assert.equal(other.snapshot().errorCode, 'CLAUDE_CLI_EXECUTABLE_NOT_FOUND'); assert.doesNotMatch(JSON.stringify(other.snapshot()), /private details/);
});

test('approval callbacks and AskUserQuestion always deny and emit visible system notices', async t => {
  const f = await fixture(t); await f.adapter.sendMessage(f.id, f.operation()); const options = f.runs[0].input.options;
  for (const tool of ['Bash', 'AskUserQuestion']) {
    const answer = await options.canUseTool(tool, { private: true }, { toolUseID: randomUUID(), signal: new AbortController().signal });
    assert.deepEqual(answer, { behavior: 'deny', message: claudeCliDenial });
    assert.ok(f.current().messages.some(message => message.role === 'system' && message.text === `已自动拒绝：${tool}（手机审批下一版提供）`));
  }
  const hook = options.hooks.PreToolUse[0]; assert.equal(hook.matcher, 'AskUserQuestion');
  const answer = await hook.hooks[0]({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }, randomUUID());
  assert.equal(answer.hookSpecificOutput.permissionDecision, 'deny');
  await assert.rejects(f.adapter.respondPermission(), { code: 'CLAUDE_CLI_READ_ONLY' });
  await assert.rejects(f.adapter.respondQuestion(), { code: 'CLAUDE_CLI_READ_ONLY' });
});

test('default HTTP factory authenticates directory/create endpoints and rejects arbitrary roots and extra fields', async t => {
  const f = await fixture(t), executable = path.join(f.root, 'fake-claude');
  await fs.writeFile(executable, '#!/usr/bin/env node\nif (process.argv[2] !== "--version") process.exit(99);\nconsole.log("2.1.326 (Claude Code)");\n', { mode: 0o700 });
  const config = { host: '', port: 0, token: 'synthetic-admin', codexHome: path.join(f.root, 'empty-codex'), defaultCwd: f.root, claudeCli: { directories: [f.directory], executable } };
  const app = await createRelayServer({ logger: false, config, services: { claudeCliSdk: f.sdk, desktopControl: { stop: async () => {} } } }); t.after(() => app.close());
  const headers = { authorization: `Bearer ${config.token}` }, route = '/api/agents/claude-cli';
  for (const [method, url, payload] of [['GET', `${route}/directories`], ['POST', `${route}/sessions`, { directory: 'invalid', text: 'Synthetic' }]]) assert.equal((await app.inject({ method, url, payload })).statusCode, 401);
  const directories = (await app.inject({ url: `${route}/directories`, headers })).json().directories;
  assert.ok(!JSON.stringify(directories).includes(f.root));
  assert.equal((await app.inject({ method: 'POST', url: `${route}/sessions`, headers, payload: { directory: f.directory, text: 'Synthetic' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: `${route}/sessions`, headers, payload: { directory: directories[0].id, text: 'Synthetic', cwd: f.outside } })).statusCode, 400);
  const createHeaders = { ...headers, 'idempotency-key': randomUUID() };
  const created = await app.inject({ method: 'POST', url: `${route}/sessions`, headers: createHeaders, payload: { directory: directories[0].id, text: 'Synthetic' } });
  const replay = await app.inject({ method: 'POST', url: `${route}/sessions`, headers: createHeaders, payload: { directory: directories[0].id, text: 'Synthetic' } });
  assert.equal(replay.json().session.id, created.json().session.id);
  assert.equal(created.statusCode, 200); assert.ok(created.json().session.id); assert.equal(f.runs.length, 1);
  assert.equal((await app.inject({ url: '/api/agents', headers })).json().agents.find(agent => agent.id === 'claude-cli').capabilities.sendMessage, true);
  await app.close(); assert.equal(f.runs[0].closes, 1);
});
