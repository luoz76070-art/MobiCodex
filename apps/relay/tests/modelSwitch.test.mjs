import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRelayServer } from '../dist/server/createRelayServer.js';
import { codexReason } from '../dist/store/lastTurn.js';
import { turnProgress } from '../dist/store/turnActivity.js';
import { alternatives, continuationLimits, modelChoices, readContinuation } from '../dist/codex/modelSwitch.js';

const catalog = { data: [
  ['gpt-6.1-sol', 'GPT-6.1-Sol', ['low', 'medium', 'high']], ['gpt-6-astra', 'GPT-6-Astra', ['low', 'medium', 'high']],
  ['ccs-cn/deepseek-v4.1-flash', 'deepseek-v4.1-flash（国产模型）', ['none', 'high']], ['ccs-cn/kimi-k3.1-pro', 'kimi-k3.1-pro（国产模型）', ['low', 'high', 'max']],
  ['ccs-team/gpt-6-astra', 'GPT-6-Astra（团队账号）', ['low', 'medium']], ['ccs-team/gpt-6.1-sol', 'GPT-6.1-Sol（团队账号）', ['low', 'medium']],
  ['ccs-team/gpt-image-2.5-flare', 'gpt-image-2.5-flare（团队账号）', ['none', 'high']], ['ccs-relay/gpt-6.1-sol', 'GPT-6.1-Sol（中转站）', ['low', 'medium']],
  ['hidden-model', 'Hidden', ['low'], true],
].map(([model, displayName, efforts, hidden]) => ({ id: model, model, displayName, hidden: Boolean(hidden), defaultReasoningEffort: efforts.at(-1), supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) })) };

const line = (type, payload) => JSON.stringify({ timestamp: '2026-11-14T00:00:00Z', type, payload });
const message = (role, text) => ({ type: 'message', role, content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }] });
const rollout = (id, model) => [
  line('session_meta', { id, cwd: '/work/project' }),
  line('response_item', message('developer', '<permissions instructions>sandbox</permissions instructions>')),
  line('response_item', message('user', '<environment_context>cwd</environment_context>')),
  line('turn_context', { model, effort: 'xhigh', turn_id: 't1' }),
  line('response_item', message('user', '修复登录页的报错')),
  line('response_item', { type: 'reasoning', summary: [], encrypted_content: 'secret-from-old-account' }),
  line('response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'pnpm test' }),
  line('response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: '1 failed' }),
  line('response_item', message('assistant', '找到原因了，正在改')),
].join('\n') + '\n';

test('429 in any form is rate_limited: app-server error info, the rollout message, usage limits', () => {
  assert.equal(codexReason({ message: 'x', codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } } }), 'rate_limited');
  assert.equal(codexReason('exceeded retry limit, last status: 429 Too Many Requests'), 'rate_limited');
  assert.equal(codexReason({ codexErrorInfo: 'usageLimitExceeded' }), 'rate_limited');
  assert.equal(codexReason({ codexErrorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 502 } } }), 'provider_error');
  assert.equal(codexReason('exceeded retry limit, last status: 502 Bad Gateway'), 'provider_error');
  assert.equal(codexReason({ codexErrorInfo: 'contextWindowExceeded', message: '429 tokens' }), 'token_limit');
  // As stored in a rollout's task_complete.
  assert.equal(codexReason({ message: 'request failed', codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } } }), 'rate_limited');
  assert.equal(codexReason({ message: 'x', codex_error_info: 'context_window_exceeded' }), 'token_limit');
});

test('a rollout turn that gave up with an error is failed, not completed', () => {
  const line = (type, payload) => ({ value: { timestamp: '2026-11-14T08:00:00Z', type, payload } });
  const error = { message: 'exceeded retry limit, last status: 429 Too Many Requests', codex_error_info: { response_too_many_failed_attempts: { http_status_code: 429 } } };
  const failed = turnProgress([line('turn_context', { turn_id: 't1' }), line('event_msg', { type: 'task_started', turn_id: 't1' }), line('event_msg', { type: 'task_complete', turn_id: 't1', last_agent_message: null, error })]);
  assert.equal(failed.turnStatus, 'failed');
  assert.deepEqual([failed.lastTurn.status, failed.lastTurn.reason.code], ['failed', 'rate_limited']);
  for (const value of [undefined, null, '', {}]) {
    const done = turnProgress([line('event_msg', { type: 'task_started', turn_id: 't2' }), line('event_msg', { type: 'task_complete', turn_id: 't2', error: value })]);
    assert.deepEqual([done.turnStatus, done.lastTurn.reason.code], ['completed', 'ok']);
  }
});

test('choices: channels from slugs and display names; the exhausted channel is left out and the same model elsewhere comes first', () => {
  const choices = modelChoices(catalog);
  assert.ok(!choices.some(c => /image|hidden/.test(c.slug)), 'image and hidden models are not offered');
  assert.deepEqual(choices.find(c => c.slug === 'ccs-relay/gpt-6.1-sol'), { slug: 'ccs-relay/gpt-6.1-sol', displayName: 'GPT-6.1-Sol（中转站）', channel: 'ccs-relay', channelLabel: '中转站', efforts: ['low', 'medium'], defaultEffort: 'medium' });
  assert.equal(choices.find(c => c.slug === 'gpt-6.1-sol').channelLabel, '默认渠道');
  const offered = alternatives(choices, 'ccs-team/gpt-6-astra').map(c => c.slug);
  assert.ok(!offered.some(slug => slug.startsWith('ccs-team/')));
  assert.equal(offered[0], 'gpt-6-astra');
  assert.deepEqual(alternatives(choices, 'gpt-6.1-sol').map(c => c.slug).slice(0, 3), ['ccs-team/gpt-6.1-sol', 'ccs-relay/gpt-6.1-sol', 'ccs-cn/deepseek-v4.1-flash'], 'same model first, then catalog order');
});

test('continuation history: visible messages and tool calls only; long threads keep their latest part without a dangling output', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'continuation-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  await fs.writeFile(file, rollout('a', 'ccs-team/gpt-6-astra'));
  const history = await readContinuation(file);
  assert.equal(history.model, 'ccs-team/gpt-6-astra');
  assert.deepEqual(history.items.map(i => i.type), ['message', 'custom_tool_call', 'custom_tool_call_output', 'message']);
  assert.ok(!JSON.stringify(history.items).includes('secret-from-old-account'));
  assert.ok(!JSON.stringify(history.items).includes('environment_context'));
  const saved = continuationLimits.items;
  continuationLimits.items = 2;
  try {
    const cut = await readContinuation(file);
    assert.deepEqual(cut.items.map(i => i.type), ['message'], 'a tool output whose call was cut off is dropped too');
    assert.equal(cut.omitted, 3);
  } finally { continuationLimits.items = saved; }
});

test('routes: switch options for an exhausted thread; continue starts a seeded thread once and is watched for notifications', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-switch-'));
  const threadId = randomUUID(), file = path.join(root, 'rollout.jsonl'), starts = [];
  await fs.writeFile(file, rollout(threadId, 'ccs-team/gpt-6-astra'));
  const liveTurns = Object.assign(new EventEmitter(), { stop: async () => {}, listModels: async () => catalog, getTurn: () => null,
    async startTurn(params) { starts.push(params); return { threadId: 'new-thread', turnId: 'new-turn', status: 'inProgress', messages: [], events: [], approvals: [], userInputs: [], thread: null, error: null, updatedAt: new Date().toISOString(), messageCount: 0, eventCount: 0 }; } });
  const app = await createRelayServer({ logger: false, config: { host: '127.0.0.1', port: 0, token: 'admin', codexHome: path.join(root, 'empty'), defaultCwd: root }, services: {
    store: { close() {}, getThreadSummary: async id => id === threadId ? { id, threadName: '修复登录页', cwd: '/work/project', source: 'vscode', originator: 'desktop', rolloutPath: file, updatedAt: '' } : null },
    live: { stop: async () => {} }, liveTurns, quotaResetAt: async model => model === 'ccs-team/gpt-6-astra' ? '2026-11-21T03:05:00.000Z' : null,
    desktopControl: { stop: async () => {}, messageQueue: { stop: async () => {}, revoke: async () => {} }, onStreamSnapshot: () => () => {}, followThread: () => () => {}, getStreamSnapshot: () => null },
    agentGateway: { stop: async () => {}, sessions: () => ({}), snapshot: () => [] } } });
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const request = (method, url, payload) => app.inject({ method, url, payload, headers: { authorization: 'Bearer admin' } });

  const options = (await request('GET', `/api/codex/threads/${threadId}/switch-options`)).json();
  assert.equal(options.model, 'ccs-team/gpt-6-astra');
  assert.equal(options.channelLabel, '团队账号');
  assert.equal(options.resetAt, '2026-11-21T03:05:00.000Z');
  assert.equal(options.alternatives[0].slug, 'gpt-6-astra');
  assert.equal((await request('GET', `/api/codex/threads/${randomUUID()}/switch-options`)).statusCode, 404);

  assert.equal((await request('POST', `/api/codex/threads/${threadId}/continue`, { model: 'no-such-model', clientMessageId: randomUUID() })).statusCode, 400);
  const body = { model: 'ccs-cn/kimi-k3.1-pro', clientMessageId: randomUUID(), approvalPolicy: 'on-request', sandbox: 'workspace-write' };
  const first = await request('POST', `/api/codex/threads/${threadId}/continue`, body);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal((await request('POST', `/api/codex/threads/${threadId}/continue`, body)).statusCode, 200);
  assert.equal(starts.length, 1, 'a retried continue does not start a second thread');
  const [start] = starts;
  assert.equal(start.model, 'ccs-cn/kimi-k3.1-pro');
  assert.equal(start.effort, 'max', 'no medium offered: the model default');
  assert.equal(start.cwd, '/work/project');
  assert.equal(start.inject.length, 4);
  assert.match(start.message, /团队账号.*额度用完/);
  assert.equal(start.name, '修复登录页 · 换到国产模型');
  assert.equal(start.approvalPolicy, 'on-request');
  assert.deepEqual({ continuedFrom: first.json().continuedFrom, channelLabel: first.json().channelLabel }, { continuedFrom: threadId, channelLabel: '国产模型' });
  const watched = (await request('GET', '/api/attention')).json().items;
  assert.deepEqual(watched.map(i => i.key), ['live:new-thread']);
});
