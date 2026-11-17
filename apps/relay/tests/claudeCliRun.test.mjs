import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { ClaudeCliAdapter, claudeCliConfigSchema } from '../dist/agents/claudeCliAdapter.js';
import { compatibleClaudeVersion, claudeCliMinimumVersion, resolveClaudeCliExecutable } from '../dist/agents/claudeCliExecutable.js';
import { AgentGateway } from '../dist/agents/agentGateway.js';
import { ClaudeCliInteractions } from '../dist/agents/claudeCliInteractions.js';
import { ClaudeCliRuntime } from '../dist/agents/claudeCliRuntime.js';
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
      const run = { input, frames, inputs: [], interrupts: 0, closes: 0, modes: [], models: [] };
      runs.push(run);
      void (async () => { for await (const message of input.prompt) run.inputs.push(message); })();
      const query = { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), async interrupt() { run.interrupts++; }, async supportedModels() { return [{ value: "synthetic-model", displayName: "Synthetic model", description: "Test model" }]; }, async setModel(model) { run.models.push(model); }, async setPermissionMode(mode) { run.modes.push(mode); }, close() { run.closes++; frames.close(); } };
      run.query = query; return query;
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

test('default HTTP factory authenticates directory/create endpoints and rejects arbitrary roots and extra fields', async t => {
  const f = await fixture(t), executable = path.join(f.root, 'fake-claude');
  await fs.writeFile(executable, '#!/usr/bin/env node\nif (process.argv[2] !== "--version") process.exit(99);\nconsole.log("2.1.326 (Claude Code)");\n', { mode: 0o700 });
  const config = { host: '', port: 0, token: 'synthetic-admin', codexHome: path.join(f.root, 'empty-codex'), defaultCwd: f.root, claudeCli: { directories: [f.directory], executable } };
  const app = await createRelayServer({ logger: false, config: { ...config, keepAwake: false }, services: { claudeCliSdk: f.sdk, desktopControl: { stop: async () => {} } } }); t.after(() => app.close());
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

function ask(f, name = 'Bash', input = { command: 'synthetic-command --check' }, options = {}) {
  const controller = new AbortController();
  const answer = f.runs.at(-1).input.options.canUseTool(name, input, { signal: controller.signal, toolUseID: randomUUID(), requestId: randomUUID(), ...options });
  return { answer, controller, id: (name === 'AskUserQuestion' ? f.current().questions : f.current().permissions).at(-1)?.id };
}
const localRule = { type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'synthetic-command:*' }] };
const questions = [
  { question: 'Which format?', header: 'Format', options: [{ label: 'Summary', description: 'Brief', preview: '<b>Plain preview</b>' }, { label: 'Details', description: 'Full' }], multiSelect: false },
  { question: 'Which sections?', header: 'Sections', options: [{ label: 'Intro' }, { label: 'Conclusion' }], multiSelect: true },
];

test('tool approval waits for a phone, allows once with original input, and rejects repeat submissions', async t => {
  const f = await fixture(t); await f.adapter.sendMessage(f.id, f.operation());
  const input = { command: 'synthetic-command --check', metadata: { original: true } }, request = ask(f, 'Bash', input);
  let answered = false; void request.answer.then(() => { answered = true; }); await sleep(10); assert.equal(answered, false);
  assert.equal(f.current().permissions[0].workingDirectory, f.directory); assert.deepEqual(JSON.parse(f.current().permissions[0].detail), input);
  assert.equal(f.adapter.snapshot().capabilities.approve, true);
  await f.adapter.respondPermission(f.id, request.id, { ...f.operation(), decision: 'once' });
  assert.deepEqual(await request.answer, { behavior: 'allow', updatedInput: input }); assert.deepEqual(f.current().permissions, []);
  await assert.rejects(f.adapter.respondPermission(f.id, request.id, { ...f.operation(), decision: 'once' }), { code: 'CLAUDE_CLI_REQUEST_HANDLED', statusCode: 409 });
  assert.ok(!f.current().messages.some(message => message.text.includes('已自动拒绝'))); assert.equal(f.runs[0].input.options.hooks, undefined);
});

test('always allow echoes only local suggestions; missing or suppressed suggestions cannot be approved persistently', async t => {
  const f = await fixture(t); await f.adapter.sendMessage(f.id, f.operation());
  const other = { ...localRule, destination: 'userSettings' };
  const request = ask(f, 'Bash', {}, { suggestions: [other, localRule] });
  assert.deepEqual(f.current().permissions[0].decisions, ['once', 'always', 'reject']); assert.equal(f.current().permissions[0].localSettings, true);
  await f.adapter.respondPermission(f.id, request.id, { ...f.operation(), decision: 'always' });
  assert.deepEqual(await request.answer, { behavior: 'allow', updatedInput: {}, updatedPermissions: [localRule] });
  for (const options of [{}, { suggestions: [other] }, { suggestions: [localRule], suppressAlwaysAllowRule: true }, { suggestions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'localSettings' }] }]) {
    const denied = ask(f, 'Bash', {}, options); assert.deepEqual(f.current().permissions[0].decisions, ['once', 'reject']);
    await assert.rejects(f.adapter.respondPermission(f.id, denied.id, { ...f.operation(), decision: 'always' }), { code: 'CLAUDE_CLI_PERMISSION_INVALID' });
    await f.adapter.respondPermission(f.id, denied.id, { ...f.operation(), decision: 'reject' }); assert.equal((await denied.answer).behavior, 'deny');
  }
});

test('reject supplies the optional reason or default reason; Write/Edit input is complete with explicit truncation', async t => {
  const f = await fixture(t); await f.adapter.sendMessage(f.id, f.operation());
  for (const reason of ['Please use a safer command', '', '  ', undefined]) {
    const request = ask(f);
    await f.adapter.respondPermission(f.id, request.id, { ...f.operation(), decision: 'reject', reason });
    assert.deepEqual(await request.answer, { behavior: 'deny', message: reason?.trim() || '用户在手机上拒绝了这个操作' });
  }
  for (const name of ['Write', 'Edit']) {
    const input = { file_path: 'synthetic.txt', old_string: 'old', new_string: 'new', content: 'x'.repeat(25_000) };
    const request = ask(f, name, input), card = f.current().permissions[0];
    assert.equal(card.action, name); assert.equal(card.inputTruncated, true); assert.equal(card.detail.length, 20_000); assert.match(card.detail, /synthetic.txt/);
    await f.adapter.respondPermission(f.id, request.id, { ...f.operation(), decision: 'once' }); assert.deepEqual((await request.answer).updatedInput, input);
  }
});

test('a non-file input the phone cannot show in full is reject-only, and allow is refused server-side', async t => {
  const f = await fixture(t); await f.adapter.sendMessage(f.id, f.operation());
  const input = { command: `echo ${'x'.repeat(25_000)}; synthetic-hidden-tail` };
  const request = ask(f, 'Bash', input), card = f.current().permissions[0];
  assert.equal(card.inputTruncated, true); assert.deepEqual(card.decisions, ['reject']); assert.match(card.unavailableReason, /不能在手机上允许/);
  assert.deepEqual(card.save, []); assert.equal(card.localSettings, false); assert.doesNotMatch(card.detail, /synthetic-hidden-tail/);
  for (const decision of ['once', 'always']) {
    await assert.rejects(f.adapter.respondPermission(f.id, request.id, { ...f.operation(), decision }), { code: 'CLAUDE_CLI_PERMISSION_INVALID' });
  }
  await f.adapter.respondPermission(f.id, request.id, { ...f.operation(), decision: 'reject' });
  assert.equal((await request.answer).behavior, 'deny');
});

test('questions retain original questions and use original text keys for single, multiple and free answers', async t => {
  const f = await fixture(t); await f.adapter.sendMessage(f.id, f.operation());
  const request = ask(f, 'AskUserQuestion', { questions, metadata: 'retained' });
  assert.equal(f.current().questions[0].questions[0].options[0].preview, '<b>Plain preview</b>'); assert.equal(f.current().questions[0].questions[1].multiple, true);
  assert.ok(f.current().questions[0].questions.every(question => question.custom));
  await assert.rejects(f.adapter.respondQuestion(f.id, request.id, { ...f.operation(), answers: [['Summary', 'Details'], ['Intro']] }), { code: 'CLAUDE_CLI_ANSWER_INVALID' });
  await f.adapter.respondQuestion(f.id, request.id, { ...f.operation(), answers: [['Summary'], ['Intro', 'Conclusion']] });
  assert.deepEqual(await request.answer, { behavior: 'allow', updatedInput: { questions, metadata: 'retained', answers: { 'Which format?': 'Summary', 'Which sections?': 'Intro, Conclusion' } } });
  await assert.rejects(f.adapter.respondQuestion(f.id, request.id, { ...f.operation(), answers: [['Details'], ['Intro']] }), { code: 'CLAUDE_CLI_REQUEST_HANDLED' });
  const free = ask(f, 'AskUserQuestion', { questions: [questions[0]] });
  await f.adapter.respondQuestion(f.id, free.id, { ...f.operation(), answers: [['My own response']] });
  assert.deepEqual((await free.answer).updatedInput.answers, { 'Which format?': 'My own response' }); assert.equal(f.current().questions.length, 0);
});

test('signal cancellation, result, interrupt, process failure and stop withdraw pending callbacks for both card kinds', async t => {
  for (const cause of ['signal', 'result', 'interrupt', 'crash', 'stop']) {
    const f = await fixture(t); await f.adapter.sendMessage(f.id, f.operation());
    const permission = ask(f), question = ask(f, 'AskUserQuestion', { questions });
    if (cause === 'signal') { permission.controller.abort(); question.controller.abort(); }
    if (cause === 'result') f.result();
    if (cause === 'interrupt') await f.adapter.interruptSession(f.id, f.operation());
    if (cause === 'crash') f.runs[0].frames.crash();
    if (cause === 'stop') await f.adapter.stop();
    const replies = await Promise.all([permission.answer, question.answer]); assert.ok(replies.every(answer => answer.behavior === 'deny'));
    if (cause !== 'stop') { assert.deepEqual(f.current().questions, []); assert.deepEqual(f.current().permissions, []); }
    else assert.equal(f.runs[0].closes, 1);
    if (cause !== 'stop') await assert.rejects(f.adapter.respondPermission(f.id, permission.id, { ...f.operation(), decision: 'once' }), { code: 'CLAUDE_CLI_REQUEST_HANDLED' });
  }
});

test('thirty minute deadline denies and interrupts; a resolved request never fires its old timer', async t => {
  const f = await fixture(t, { interactionMs: 40 }); await f.adapter.sendMessage(f.id, f.operation());
  for (const kind of ['Bash', 'AskUserQuestion']) {
    const request = ask(f, kind, kind === 'Bash' ? {} : { questions });
    await until(() => f.runs[0].interrupts > (kind === 'Bash' ? 0 : 1));
    const reply = await request.answer; assert.equal(reply.behavior, 'deny'); assert.match(reply.message, /30 分钟/); assert.equal(reply.interrupt, true);
    await until(() => f.runs[0].interrupts > (kind === 'Bash' ? 0 : 1));
    assert.deepEqual(f.current().questions, []); assert.deepEqual(f.current().permissions, []);
    f.result(); await until(() => f.current().status === 'idle'); assert.equal(f.current().lastTurn.status, 'interrupted');
    await f.adapter.sendMessage(f.id, f.operation());
  }
  const request = ask(f); await f.adapter.respondPermission(f.id, request.id, { ...f.operation(), decision: 'once' }); await request.answer;
  await sleep(60); assert.equal(f.runs[0].interrupts, 2);
});

test('query controls require an existing process and accept only safe modes and supported models', async t => {
  const f = await fixture(t);
  await assert.rejects(f.adapter.sessionSettings(f.id), { code: 'CLAUDE_CLI_NOT_RUNNING' }); assert.equal(f.runs.length, 0);
  await f.adapter.sendMessage(f.id, f.operation());
  assert.deepEqual(await f.adapter.sessionSettings(f.id), { permissionMode: 'default', model: null, models: [{ value: 'synthetic-model', displayName: 'Synthetic model', description: 'Test model' }] });
  for (const mode of ['default', 'plan', 'acceptEdits']) await f.adapter.setPermissionMode(f.id, { ...f.operation(), mode });
  for (const mode of ['bypassPermissions', 'dontAsk', 'auto']) await assert.rejects(f.adapter.setPermissionMode(f.id, { ...f.operation(), mode }), { code: 'CLAUDE_CLI_PERMISSION_MODE_INVALID' });
  await assert.rejects(f.adapter.setModel(f.id, { ...f.operation(), model: 'unknown' }), { code: 'CLAUDE_CLI_MODEL_INVALID' });
  await f.adapter.setModel(f.id, { ...f.operation(), model: 'synthetic-model' });
  assert.deepEqual(f.runs[0].modes, ['default', 'plan', 'acceptEdits']); assert.deepEqual(f.runs[0].models, ['synthetic-model']);
  assert.deepEqual(f.current().runtimeSettings, { permissionMode: 'acceptEdits', model: 'synthetic-model' });
  f.result(); await until(() => f.current().status === 'idle');
  await f.adapter.setPermissionMode(f.id, { ...f.operation(), mode: 'default' }); assert.equal(f.runs.length, 1);
  f.runs[0].frames.close(); await until(() => f.runs[0].closes === 1); assert.equal(f.current().runtimeSettings, undefined);
  await assert.rejects(f.adapter.setModel(f.id, { ...f.operation(), model: 'synthetic-model' }), { code: 'CLAUDE_CLI_NOT_RUNNING' });
});

test('production interaction timeout is exactly thirty minutes and cancellation clears it', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const snapshot = { questions: [], permissions: [] }; let interruptions = 0;
  const interactions = new ClaudeCliInteractions(snapshot, 'synthetic-project', () => {}, () => { interruptions++; });
  const controller = new AbortController();
  const answer = interactions.request('Bash', {}, { signal: controller.signal, toolUseID: 'synthetic-tool', requestId: 'synthetic-request' });
  t.mock.timers.tick(30 * 60_000 - 1); assert.equal(snapshot.permissions.length, 1); assert.equal(interruptions, 0);
  t.mock.timers.tick(1); assert.equal((await answer).behavior, 'deny'); assert.equal(interruptions, 1); assert.equal(snapshot.permissions.length, 0);
  const canceled = interactions.request('Bash', {}, { signal: controller.signal, toolUseID: 'synthetic-tool-2', requestId: 'synthetic-request-2' });
  controller.abort(); await canceled; t.mock.timers.tick(30 * 60_000); assert.equal(interruptions, 1);
});

test('HTTP approvals and controls preserve authentication, control token validation and idempotency', async t => {
  const f = await fixture(t);
  const config = { host: '', port: 0, token: 'synthetic-admin', codexHome: path.join(f.root, 'empty-codex'), defaultCwd: f.root };
  const app = await createRelayServer({ logger: false, config: { ...config, keepAwake: false }, services: { agentGateway: new AgentGateway([f.adapter]), desktopControl: { stop: async () => {} } } }); t.after(() => app.close());
  const headers = { authorization: `Bearer ${config.token}` }, base = `/api/agents/claude-cli/sessions/${f.id}`;
  assert.equal((await app.inject({ url: `${base}/controls` })).statusCode, 401);
  assert.equal((await app.inject({ url: `${base}/controls`, headers })).statusCode, 409);
  await f.adapter.sendMessage(f.id, f.operation());
  const permission = ask(f), question = ask(f, 'AskUserQuestion', { questions: [questions[0]] });
  const permissionRoute = `${base}/permissions/${permission.id}/respond`, permissionBody = { controlToken: f.current().control.token, clientMessageId: randomUUID(), decision: 'reject', reason: 'Synthetic reason' };
  assert.equal((await app.inject({ method: 'POST', url: permissionRoute, payload: permissionBody })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: permissionRoute, headers, payload: { ...permissionBody, clientMessageId: randomUUID(), controlToken: randomUUID() } })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: permissionRoute, headers, payload: { ...permissionBody, clientMessageId: randomUUID(), reason: 'x'.repeat(2001) } })).statusCode, 400);
  const replies = await Promise.all([0, 1].map(() => app.inject({ method: 'POST', url: permissionRoute, headers, payload: permissionBody })));
  assert.deepEqual(replies.map(reply => reply.statusCode), [200, 200]); assert.deepEqual(await permission.answer, { behavior: 'deny', message: 'Synthetic reason' });
  const duplicate = await app.inject({ method: 'POST', url: permissionRoute, headers, payload: { ...permissionBody, clientMessageId: randomUUID() } });
  assert.equal(duplicate.statusCode, 409); assert.equal(duplicate.json().error, 'CLAUDE_CLI_REQUEST_HANDLED');
  const op = () => ({ controlToken: f.current().control.token, clientMessageId: randomUUID() });
  const questionReply = await app.inject({ method: 'POST', url: `${base}/questions/${question.id}/respond`, headers, payload: { ...op(), answers: [['My format']] } });
  assert.equal(questionReply.statusCode, 200); assert.deepEqual((await question.answer).updatedInput.answers, { 'Which format?': 'My format' });
  for (const suffix of ['permission-mode', 'model']) assert.equal((await app.inject({ method: 'POST', url: `${base}/${suffix}`, payload: { ...op(), ...(suffix === 'model' ? { model: 'synthetic-model' } : { mode: 'plan' }) } })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: `${base}/permission-mode`, headers, payload: { ...op(), mode: 'bypassPermissions' } })).statusCode, 400);
  const modeBody = { ...op(), mode: 'plan' };
  for (let i = 0; i < 2; i++) assert.equal((await app.inject({ method: 'POST', url: `${base}/permission-mode`, headers, payload: modeBody })).statusCode, 200);
  assert.deepEqual(f.runs[0].modes, ['plan']);
  assert.equal((await app.inject({ method: 'POST', url: `${base}/model`, headers, payload: { ...op(), model: 'unknown' } })).statusCode, 400);
  assert.equal((await app.inject({ method: 'POST', url: `${base}/model`, headers, payload: { ...op(), model: 'synthetic-model' } })).statusCode, 200);
  const state = (await app.inject({ url: `${base}/controls`, headers })).json(); assert.equal(state.permissionMode, 'plan'); assert.equal(state.model, 'synthetic-model');
  assert.equal(state.models[0].displayName, 'Synthetic model'); assert.equal(f.runs.length, 1);
});

test('late model catalogs cannot alter a replacement Query; SDK control failures are safe errors', async t => {
  const f = await fixture(t); await f.adapter.sendMessage(f.id, f.operation());
  let release; f.runs[0].query.supportedModels = () => new Promise(resolve => { release = resolve; });
  const waiting = f.adapter.sessionSettings(f.id); await until(() => Boolean(release));
  f.runs[0].frames.crash(); await until(() => f.current().lastTurn?.status === 'failed');
  await f.adapter.sendMessage(f.id, f.operation());
  release([{ value: 'stale-model', displayName: 'Stale', description: '' }]);
  await assert.rejects(waiting, { code: 'CLAUDE_CLI_NOT_RUNNING' }); assert.equal(f.current().runtimeSettings.model, null);
  f.runs[1].query.setPermissionMode = async () => { throw new Error('PRIVATE SDK ERROR'); };
  await assert.rejects(f.adapter.setPermissionMode(f.id, { ...f.operation(), mode: 'plan' }), { code: 'CLAUDE_CLI_SETTINGS_FAILED', message: 'CLAUDE_CLI_SETTINGS_FAILED' });
  assert.equal(f.current().runtimeSettings.permissionMode, 'default'); assert.doesNotMatch(JSON.stringify(f.snapshots), /PRIVATE/);
});

test('canceled signals and malformed questions fail closed; pending payload and count stay bounded', async t => {
  const f = await fixture(t); await f.adapter.sendMessage(f.id, f.operation());
  const controller = new AbortController(); controller.abort();
  assert.equal((await ask(f, 'Bash', {}, { signal: controller.signal }).answer).behavior, 'deny'); assert.equal(f.current().permissions.length, 0);
  assert.equal((await ask(f, 'AskUserQuestion', { questions: [{ question: 'Invalid', options: 'invalid' }] }).answer).behavior, 'deny'); assert.equal(f.current().questions.length, 0);
  const huge = { question: 'Large preview?', options: Array.from({ length: 100 }, (_, i) => ({ label: `Option ${i}`, preview: '界'.repeat(20_000) })) };
  assert.equal((await ask(f, 'AskUserQuestion', { questions: [huge] }).answer).behavior, 'deny'); assert.equal(f.current().questions.length, 0);
  const requests = Array.from({ length: 32 }, () => ask(f));
  assert.equal(f.current().permissions.length, 32);
  assert.equal((await ask(f).answer).behavior, 'deny'); assert.equal(f.current().permissions.length, 32);
  await f.adapter.interruptSession(f.id, f.operation());
  assert.ok((await Promise.all(requests.map(request => request.answer))).every(reply => reply.behavior === 'deny')); assert.deepEqual(f.current().permissions, []);
});

test('F5 counts running turns rather than retained Claude CLI query processes', async t => {
  const f = await fixture(t); assert.equal(f.adapter.runningCount(), 0);
  const activity = []; const release = f.adapter.onActivity(() => activity.push(f.adapter.runningCount())); t.after(release);
  await f.adapter.sendMessage(f.id, f.operation()); assert.equal(f.adapter.runningCount(), 1);
  f.result(); await until(() => f.current().status === 'idle');
  assert.equal(f.adapter.runningCount(), 0); assert.equal(f.runs[0].closes, 0); assert.ok(activity.includes(1)); assert.equal(activity.at(-1), 0);
  await f.adapter.sendMessage(f.id, f.operation()); assert.equal(f.adapter.runningCount(), 1);
  f.runs[0].frames.crash(); await until(() => f.current().lastTurn?.status === 'failed'); assert.equal(f.adapter.runningCount(), 0);
});

test('a model API that Claude Code keeps retrying is shown, cleared on output and named when the turn gives up', async t => {
  const f = await fixture(t); await f.adapter.sendMessage(f.id, f.operation());
  await until(() => f.runs[0].inputs.length === 1);
  f.frame('system', { subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 500, error_status: 429, error: 'rate_limit' });
  await until(() => Boolean(f.current().notice));
  assert.match(f.current().notice, /限流（429）.*第 2\/10 次重试/u); assert.equal(f.current().status, 'running');
  f.frame('stream_event', { event: { type: 'message_start', message: { id: 'm1' } } });
  await until(() => f.current().notice === null);
  f.frame('system', { subtype: 'api_retry', attempt: 3, max_retries: 10, error_status: 502, error: 'server_error' });
  await until(() => /出错（502）/u.test(f.current().notice ?? ''));
  f.result({ subtype: 'error_during_execution', is_error: true });
  await until(() => f.current().status === 'idle');
  assert.equal(f.current().notice, null); assert.equal(f.current().lastTurn.status, 'failed');
  assert.equal(f.current().lastTurn.reason.code, 'CLAUDE_CLI_FAILED');
  assert.match(f.current().lastTurn.reason.message, /出错（502）.*重试 3 次后放弃/u);
  await f.adapter.sendMessage(f.id, f.operation('Again'));
  f.frame('system', { subtype: 'api_retry', attempt: 10, max_retries: 10, error_status: 429 });
  await until(() => /限流/u.test(f.current().notice ?? ''));
  f.result({ subtype: 'error_during_execution', is_error: true });
  await until(() => f.current().status === 'idle');
  assert.equal(f.current().lastTurn.reason.code, 'rate_limited');
  await f.adapter.sendMessage(f.id, f.operation('Clean')); f.result();
  await until(() => f.current().lastTurn?.status === 'completed' && f.current().status === 'idle');
  assert.equal(f.current().lastTurn.reason.message, '已完成', 'a later clean turn does not inherit the old API failure');
});

