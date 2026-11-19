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
import { alternatives, approvalPolicyForTurn, modelChoices, needsPreviousModel, readCatalog, sandboxPolicyForTurn, switchEffort, threadModelState } from '../dist/codex/modelSwitch.js';
import { DesktopNativeControl } from '../dist/desktop/desktopNativeControl.js';

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
  // A local proxy wraps every upstream refusal as http_connection_failed; the text and status keep the real cause.
  const proxied = (status, cause) => ({ message: `unexpected status ${status}: local proxy failed while handling /responses. cause: ${cause}`, codex_error_info: { http_connection_failed: { http_status_code: Number(status.split(' ')[0]) } } });
  assert.equal(codexReason(proxied('403 Forbidden', 'Request rejected by channel content protection (request id: synthetic)')), 'content_blocked');
  assert.equal(codexReason(proxied('403 Forbidden', 'invalid api key')), 'invalid_request');
  assert.equal(codexReason(proxied('502 Bad Gateway', 'upstream connect failed: dns error')), 'transport_error');
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

// A catalog like CC Switch writes it: one comp_hash shared by the channels, one model left on another hash.
async function codexHome(t, hashes = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'switch-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const models = catalog.data.map(m => ({ slug: m.model, comp_hash: hashes[m.model] ?? 'cc-switch',
    context_window: m.model.startsWith('ccs-cn/') ? 1_000_000 : 272_000, auto_compact_token_limit: m.model.startsWith('ccs-cn/') ? 900_000 : 244_800 }));
  await fs.writeFile(path.join(home, 'catalog.json'), JSON.stringify({ models }));
  await fs.writeFile(path.join(home, 'config.toml'), 'model_provider = "custom"\nmodel_catalog_json = "catalog.json"\n');
  return home;
}
const sandbox = { type: 'workspace-write', writable_roots: ['/work/extra'], network_access: true, exclude_tmpdir_env_var: false, exclude_slash_tmp: false };
const switchRollout = (id, model, tokens = 50_000) => [
  line('session_meta', { id, cwd: '/work/project' }),
  line('turn_context', { model: 'ccs-team/gpt-6.1-sol', effort: 'low', turn_id: 't0', approval_policy: 'on-request', sandbox_policy: { type: 'read-only' } }),
  line('response_item', message('user', '修复登录页的报错')),
  line('turn_context', { model, effort: 'high', turn_id: 't1', approval_policy: 'never', sandbox_policy: sandbox }),
  line('event_msg', { type: 'token_count', info: { last_token_usage: { input_tokens: tokens } } }),
  line('event_msg', { type: 'task_complete', turn_id: 't1', error: { message: 'exceeded retry limit, last status: 429 Too Many Requests' } }),
].join('\n') + '\n';

test('choices carry comp_hash from the configured catalog; only models Codex can reach without the exhausted one are offered', async t => {
  const home = await codexHome(t, { 'gpt-6.1-sol': '3000' });
  const choices = modelChoices(catalog, readCatalog(home));
  assert.ok(!choices.some(c => /image|hidden/.test(c.slug)), 'image and hidden models are not offered');
  assert.equal(choices.find(c => c.slug === 'ccs-relay/gpt-6.1-sol').channelLabel, '中转站');
  assert.equal(choices.find(c => c.slug === 'gpt-6.1-sol').compHash, '3000');
  const { usable, blocked } = alternatives(choices, 'ccs-team/gpt-6-astra');
  assert.ok(!usable.some(c => c.slug.startsWith('ccs-team/')), 'the exhausted channel is left out');
  assert.ok(!usable.some(c => c.slug === 'gpt-6.1-sol'), 'another comp_hash means Codex would compact with the exhausted model first');
  assert.equal(blocked, 1);
  assert.equal(usable[0].slug, 'gpt-6-astra', 'the same model on another channel comes first');
  assert.deepEqual(modelChoices(catalog, readCatalog('/nonexistent')).filter(c => c.compHash).length, 0, 'no catalog: nothing known, nothing blocked');
});

test('a smaller window blocks the switch only when the context is already past its limit', () => {
  const big = { compHash: 'cc-switch', contextWindow: 1_000_000 }, small = { slug: 'x', compHash: 'cc-switch', contextWindow: 272_000, compactLimit: 244_800 };
  assert.equal(needsPreviousModel(big, small, 100_000), false);
  assert.equal(needsPreviousModel(big, small, 250_000), true);
  assert.equal(needsPreviousModel({ compHash: null, contextWindow: null }, small, 900_000), false);
  assert.equal(needsPreviousModel({ compHash: '3000', contextWindow: 272_000 }, small, 1), true);
});

test('thread state: last model, effort, permissions and context size; converted for a turn that keeps them', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'switch-state-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  await fs.writeFile(file, switchRollout('a', 'ccs-team/gpt-6-astra', 163_000));
  const state = await threadModelState(file);
  assert.deepEqual({ ...state, sandboxPolicy: state.sandboxPolicy?.type }, { model: 'ccs-team/gpt-6-astra', effort: 'high', approvalPolicy: 'never', sandboxPolicy: 'workspace-write', contextTokens: 163_000 });
  assert.deepEqual(sandboxPolicyForTurn(state.sandboxPolicy), { type: 'workspaceWrite', writableRoots: ['/work/extra'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false });
  assert.deepEqual(sandboxPolicyForTurn({ type: 'read-only' }), { type: 'readOnly', networkAccess: false });
  assert.deepEqual(sandboxPolicyForTurn({ type: 'danger-full-access' }), { type: 'dangerFullAccess' });
  assert.equal(sandboxPolicyForTurn({ type: 'something-new' }), null);
  assert.equal(approvalPolicyForTurn('never'), 'never');
  assert.equal(approvalPolicyForTurn('on-failure'), 'on-request', 'unknown approval asks');
  const choice = { efforts: ['low', 'medium', 'high'], defaultEffort: 'high' };
  assert.equal(switchEffort(choice, 'high'), 'high', 'the thread keeps its effort');
  assert.equal(switchEffort(choice, 'xhigh'), 'medium');
  assert.equal(switchEffort({ efforts: ['none', 'high'], defaultEffort: 'high' }, 'xhigh'), 'high');
});

test('desktop switch turn names the model and states every setting instead of inheriting them', async () => {
  const state = { cwd: '/work/project', turnHistory: { kind: 'canonical', history: { entitiesByKey: { a: { turnId: 'old', status: 'failed', params: {}, items: [] } }, islands: [{ entries: [{ value: 'a' }] }] } } };
  const sent = [];
  const control = new DesktopNativeControl({ read: () => ({ epoch: 'e1', owner: 'desk', state }), changed() {}, wait: async () => {},
    request: async (method, params) => { sent.push([method, params]); return { resultType: 'success', method, handledByClientId: 'desk', result: { turn: { id: 'new' } } }; } });
  const settings = { model: 'ccs-cn/kimi-k3.1-pro', effort: 'high', sandboxPolicy: { type: 'readOnly', networkAccess: false }, approvalPolicy: 'never' };
  await control.send({ threadId: 'th', controlToken: 'e1', expectedTurnId: null, clientMessageId: randomUUID(), message: '接着做', mode: 'start', turnSettings: settings });
  const [[method, params]] = sent;
  assert.equal(method, 'thread-follower-start-turn');
  assert.equal(params.turnStart.context.inheritThreadSettings, false);
  assert.deepEqual([params.turnStart.request.model, params.turnStart.request.effort, params.turnStart.request.sandboxPolicy, params.turnStart.request.approvalPolicy],
    [settings.model, 'high', settings.sandboxPolicy, 'never']);
  await control.send({ threadId: 'th2', controlToken: 'e1', expectedTurnId: null, clientMessageId: randomUUID(), message: '普通消息', mode: 'start' });
  assert.equal(sent[1][1].turnStart.context.inheritThreadSettings, true, 'ordinary sends are unchanged');
  assert.equal(sent[1][1].turnStart.request.model, undefined);
});

test('routes: switch options, and a switch is an ordinary send on the same thread (desktop or gateway) that names the model', async t => {
  const home = await codexHome(t, { 'gpt-6.1-sol': '3000' });
  const threadId = randomUUID(), file = path.join(home, 'rollout.jsonl'), starts = [], desktopSends = [];
  await fs.writeFile(file, switchRollout(threadId, 'ccs-team/gpt-6-astra'));
  const bareId = randomUUID(), bare = path.join(home, 'bare.jsonl');
  await fs.writeFile(bare, [line('session_meta', { id: bareId, cwd: '/work/project' }), line('turn_context', { model: 'ccs-team/gpt-6-astra', effort: 'high', turn_id: 't1' })].join('\n') + '\n');
  const turn = id => ({ threadId: id, turnId: 'next-turn', status: 'inProgress', messages: [], events: [], approvals: [], userInputs: [], thread: null, error: null, updatedAt: new Date().toISOString(), messageCount: 0, eventCount: 0 });
  const liveTurns = Object.assign(new EventEmitter(), { stop: async () => {}, listModels: async () => catalog, getTurn: () => null,
    async startTurn(params) { starts.push(params); return turn(params.threadId ?? 'fresh'); } });
  const app = await createRelayServer({ logger: false, config: { keepAwake: false, host: '127.0.0.1', port: 0, token: 'admin', codexHome: home, defaultCwd: home }, services: {
    store: { close() {}, getThreadSummary: async id => id === threadId || id === bareId ? { id, threadName: '修复登录页', cwd: '/work/project', source: 'vscode', originator: 'Codex Desktop', rolloutPath: id === bareId ? bare : file, updatedAt: '' } : null },
    live: { stop: async () => {} }, liveTurns, quotaResetAt: async model => model === 'ccs-team/gpt-6-astra' ? '2026-11-21T03:05:00.000Z' : null,
    desktopControl: { stop: async () => {}, messageQueue: { stop: async () => {}, revoke: async () => {} }, onStreamSnapshot: () => () => {}, followThread: () => () => {}, getStreamSnapshot: () => null,
      async sendMessage(params) { desktopSends.push(params); return { ok: true, action: 'start-turn', delivery: 'confirmed' }; } },
    agentGateway: { stop: async () => {}, sessions: () => ({}), snapshot: () => [] } } });
  t.after(() => app.close());
  const request = (method, url, payload) => app.inject({ method, url, payload, headers: { authorization: 'Bearer admin' } });

  const options = (await request('GET', `/api/codex/threads/${threadId}/switch-options`)).json();
  assert.deepEqual([options.model, options.channelLabel, options.resetAt, options.blocked], ['ccs-team/gpt-6-astra', '团队账号', '2026-11-21T03:05:00.000Z', 1]);
  assert.equal(options.alternatives[0].slug, 'gpt-6-astra');
  assert.equal((await request('GET', `/api/codex/threads/${randomUUID()}/switch-options`)).statusCode, 404);

  // Desktop: the turn goes through the desktop with the thread's own permissions and effort.
  const desktopBody = { message: '接着做', clientMessageId: randomUUID(), mode: 'start', controlToken: randomUUID(), expectedTurnId: null, model: 'ccs-cn/kimi-k3.1-pro' };
  const sent = await request('POST', `/api/desktop/control/threads/${threadId}/messages`, desktopBody);
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal((await request('POST', `/api/desktop/control/threads/${threadId}/messages`, desktopBody)).statusCode, 200);
  assert.equal(desktopSends.length, 1, 'a retried switch is not sent twice');
  assert.deepEqual(desktopSends[0].turnSettings, { model: 'ccs-cn/kimi-k3.1-pro', effort: 'high', approvalPolicy: 'never',
    sandboxPolicy: { type: 'workspaceWrite', writableRoots: ['/work/extra'], networkAccess: true, excludeTmpdirEnvVar: false, excludeSlashTmp: false } });
  assert.equal((await request('POST', `/api/desktop/control/threads/${threadId}/messages`, { ...desktopBody, clientMessageId: randomUUID(), mode: 'steer' })).statusCode, 400, 'a switch never steers');
  assert.equal((await request('POST', `/api/desktop/control/threads/${threadId}/messages`, { ...desktopBody, clientMessageId: randomUUID(), model: 'no-such-model' })).statusCode, 400);
  const plain = await request('POST', `/api/desktop/control/threads/${threadId}/messages`, { ...desktopBody, clientMessageId: randomUUID(), model: undefined });
  assert.equal(plain.statusCode, 200);
  assert.equal(desktopSends.at(-1).turnSettings, undefined, 'ordinary desktop sends carry no settings');
  const unknown = await request('POST', `/api/desktop/control/threads/${bareId}/messages`, { ...desktopBody, clientMessageId: randomUUID() });
  assert.equal(unknown.statusCode, 409, 'unknown permissions would fall back to the desktop default (full access)');
  assert.equal(desktopSends.length, 2);

  // Gateway: the same thread is resumed on the new model, keeping its permissions over the phone's defaults.
  const live = await request('POST', '/api/live/turns', { threadId, message: '接着做', clientMessageId: randomUUID(), approvalPolicy: 'on-request', sandbox: 'read-only', model: 'gpt-6-astra' });
  assert.equal(live.statusCode, 200, live.body);
  assert.deepEqual([starts[0].threadId, starts[0].model, starts[0].effort, starts[0].approvalPolicy, starts[0].sandbox], [threadId, 'gpt-6-astra', 'high', 'never', 'workspace-write']);
  assert.equal(live.json().threadId, threadId, 'no new thread');
  assert.equal((await request('POST', '/api/live/turns', { message: 'x', clientMessageId: randomUUID(), model: 'gpt-6-astra' })).statusCode, 400, 'a switch needs a thread');
  assert.deepEqual((await request('GET', '/api/attention')).json().items.map(i => i.key).sort(), [`desktop:${threadId}`, `live:${threadId}`]);
});
