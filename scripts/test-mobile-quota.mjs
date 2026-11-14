import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

// F6: when a Codex channel runs out of quota the phone offers the other channels; the gateway does the switch.
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-quota-'));
test.after(() => fs.rm(dir, { recursive: true, force: true }));
await build({
  stdin: { contents: "export * from './apps/mobile/src/features/quota/quotaSwitch.ts'; export { QuotaSwitchCard } from './apps/mobile/src/features/quota/QuotaSwitchCard.tsx'; export { modelChoices, alternatives } from './apps/relay/src/codex/modelSwitch.ts'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server';", resolveDir: process.cwd(), loader: 'ts' },
  outfile: path.join(dir, 'quota.cjs'), bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', nodePaths: [path.resolve('apps/mobile/node_modules')], logLevel: 'error',
});
const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
const m = createRequire(import.meta.url)(path.join(dir, 'quota.cjs'));
const app = await fs.readFile('apps/mobile/src/app/App.tsx', 'utf8');
const service = await fs.readFile('apps/mobile/android/app/src/main/java/com/mobilecodex/app/AttentionService.java', 'utf8');

const turn = (status, code) => ({ turnId: 't9', status, reason: { code, message: 'x' }, endedAt: '2026-11-14T00:00:00Z', timeSource: 'provider' });
const catalog = { data: [['gpt-6-astra', 'GPT-6-Astra'], ['ccs-team/gpt-6-astra', 'GPT-6-Astra（团队账号）'], ['ccs-cn/kimi-k3.1-pro', 'kimi-k3.1-pro（国产模型）'], ['ccs-cn/glm-5.3', 'glm-5.3（国产模型）'], ['ccs-relay/gpt-6.1-sol', 'GPT-6.1-Sol（中转站）']]
  .map(([model, displayName]) => ({ model, displayName, hidden: false, defaultReasoningEffort: 'high', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'high' }] })) };
const options = { model: 'ccs-team/gpt-6-astra', channel: 'ccs-team', channelLabel: '团队账号', resetAt: '2026-11-21T03:05:00Z', alternatives: m.alternatives(m.modelChoices(catalog), 'ccs-team/gpt-6-astra').usable, blocked: 0 };

test('the card shows only for an ended turn that stopped on quota', () => {
  assert.equal(m.needsQuotaSwitch(turn('failed', 'rate_limited'), false), true);
  assert.equal(m.needsQuotaSwitch(turn('interrupted', 'rate_limited'), false), true);
  assert.equal(m.needsQuotaSwitch(turn('failed', 'rate_limited'), true), false, 'not while a new turn runs');
  assert.equal(m.needsQuotaSwitch(turn('failed', 'provider_error'), false), false);
  assert.equal(m.needsQuotaSwitch(turn('completed', 'rate_limited'), false), false);
  assert.equal(m.needsQuotaSwitch(null, false), false);
});

test('picker labels always name the channel', () => {
  const [first, kimi] = options.alternatives;
  assert.equal(m.choiceLabel(first), 'GPT-6-Astra（默认渠道）');
  assert.equal(m.choiceLabel(kimi), 'kimi-k3.1-pro（国产模型）');
  assert.equal(m.choiceLabel({ ...kimi, displayName: 'Model (beta)', channelLabel: '中转站' }), 'Model（中转站）');
});

test('reset time is Beijing time; the summary names the exhausted channel', () => {
  assert.equal(m.beijingTime('2026-11-21T03:05:00Z'), '11-21 11:05');
  assert.equal(m.beijingTime('2026-11-14T20:10:00Z'), '11-15 04:10', 'crosses midnight');
  assert.equal(m.beijingTime(null), null);
  assert.equal(m.quotaSummary(options), '「团队账号」渠道的额度用完了，预计北京时间 11-21 11:05 恢复。');
  assert.equal(m.quotaSummary({ ...options, channelLabel: null, resetAt: null }), '这个渠道的额度用完了。');
});

test('gateway alternatives group by channel in its order, the same model on another channel first', () => {
  const groups = m.quotaChoiceGroups(options.alternatives);
  assert.deepEqual(groups.map(g => [g.label, g.choices.map(c => c.slug)]), [
    ['默认渠道', ['gpt-6-astra']], ['国产模型', ['ccs-cn/kimi-k3.1-pro', 'ccs-cn/glm-5.3']], ['中转站', ['ccs-relay/gpt-6.1-sol']]]);
});

test('card: a channel picker and the two choices; no channels left means only waiting', () => {
  const html = m.renderToStaticMarkup(m.createElement(m.QuotaSwitchCard, { options, loading: false, busy: false, error: '', onContinue() {}, onDismiss() {} }));
  assert.match(html, /额度用完/);
  assert.match(html, /<optgroup label="默认渠道"><option value="gpt-6-astra" selected="">GPT-6-Astra（默认渠道）<\/option><\/optgroup><optgroup label="国产模型">/);
  assert.match(html, /换到这个模型接着做/);
  assert.match(html, /等恢复再说/);
  assert.match(html, /就在这个线程里换，不开新任务/);
  assert.doesNotMatch(html, /没有列出/);
  assert.match(m.renderToStaticMarkup(m.createElement(m.QuotaSwitchCard, { options: { ...options, blocked: 2 }, loading: false, busy: false, error: '', onContinue() {}, onDismiss() {} })), /另有 2 个模型要先用原渠道整理上下文/);
  const none = m.renderToStaticMarkup(m.createElement(m.QuotaSwitchCard, { options: { ...options, alternatives: [] }, loading: false, busy: false, error: '', onContinue() {}, onDismiss() {} }));
  assert.doesNotMatch(none, /换到这个模型接着做|<select/);
  assert.match(none, /只能等额度恢复/);
  const busy = m.renderToStaticMarkup(m.createElement(m.QuotaSwitchCard, { options, loading: false, busy: true, error: 'HTTP 400', onContinue() {}, onDismiss() {} }));
  assert.match(busy, /正在换过去/);
  assert.match(busy, /role="alert"[^>]*>.*HTTP 400/);
});

test('"wait" hides the card for that turn only and the list stays short', () => {
  m.dismissQuota('thread-a', 't1');
  assert.equal(m.quotaDismissed('thread-a', 't1'), true);
  assert.equal(m.quotaDismissed('thread-a', 't2'), false, 'a later 429 shows the card again');
  for (let i = 0; i < 40; i++) m.dismissQuota('thread-b', `t${i}`);
  assert.equal(JSON.parse(storage.get('mobicodexQuotaDismissedV1')).length, 30);
  assert.equal(m.quotaDismissed('thread-a', 't1'), false, 'the oldest entries go first');
});

test('switch prompts: the thread carries the context, the message only says what changed', () => {
  assert.equal(m.switchPrompt('quota', '团队账号', '国产模型'), '（换渠道接着做）上一轮在「团队账号」因为额度用完中断了，现在换到「国产模型」。请先看一下当前进度（必要时检查工作区里的实际改动），然后接着把没做完的部分做完。');
  assert.match(m.switchPrompt('return', null, '团队账号'), /^（换回原渠道）现在换回「团队账号」。.*只回复“已换回”/);
});

test('stand-in records: notice with the reset time, kept per thread, the newest few only', () => {
  const record = { homeModel: 'ccs-team/gpt-6-astra', homeLabel: '团队账号', toModel: 'ccs-cn/kimi-k3.1-pro', toLabel: '国产模型', resetAt: '2026-11-21T03:05:00Z', at: '2026-11-14T10:00:00Z' };
  assert.equal(m.standInNotice(record, Date.parse('2026-11-14T10:00:00Z')), '正在用「国产模型」顶替「团队账号」，预计北京时间 11-21 11:05 恢复。');
  assert.equal(m.standInNotice(record, Date.parse('2026-11-22T00:00:00Z')), '正在用「国产模型」顶替「团队账号」，原渠道应该已经恢复。');
  assert.equal(m.standInNotice({ ...record, resetAt: null }), '正在用「国产模型」顶替「团队账号」。');
  let records = m.saveSwitchRecord({}, 'thread-a', record);
  assert.deepEqual(m.loadSwitchRecords(), { 'thread-a': record });
  records = m.saveSwitchRecord(records, 'thread-a', null);
  assert.deepEqual(m.loadSwitchRecords(), {});
  for (let i = 0; i < 60; i++) records = m.saveSwitchRecord(records, `t${i}`, { ...record, at: new Date(Date.UTC(2026, 10, 14, 0, i)).toISOString() });
  assert.equal(Object.keys(m.loadSwitchRecords()).length, 50);
  assert.ok(!('t0' in m.loadSwitchRecords()), 'the oldest go first');
});

test('wiring: a switch is a send on the same thread with the model named; notifications point at switching', () => {
  const body = app.slice(app.indexOf('async function switchChannel'), app.indexOf('async function resolveSendRoute'));
  assert.match(body, /sendDesktopMessage\(threadKey, message, "", \[\], attempt\.clientMessageId, "start", control\.guard, true, model\)/, 'desktop threads: through the desktop, same guard as a send');
  assert.match(body, /\/api\/live\/turns"\), token,\s*\{ threadId: threadKey, message, clientMessageId: attempt\.clientMessageId, cwd: source\.cwd, approvalPolicy, sandbox: sandboxMode, model \}/, 'otherwise the gateway resumes this thread');
  assert.doesNotMatch(body, /setSelected|\/continue/, 'no new thread');
  assert.match(body, /channelAttemptRef\.current\?\.key === key \? channelAttemptRef\.current/, 'retry-safe message id');
  assert.match(body, /attentionAfterSend\(\)/);
  assert.match(app, /\.\.\.\(switchModel \? \{ model: switchModel \} : \{\}\)/);
  assert.match(app, /switchChannel\(switchRecords\[selected\.id!\]\.homeModel, "return"\)/, 'the stand-in notice switches back');
  assert.match(app, /switch-options/);
  assert.match(app, /lastTurnError !== activeRuntime\.lastTurn\?\.reason\.message && !\(quotaKey && quotaSwitch\?\.key === quotaKey/, 'the raw upstream error is not repeated under the card');
  assert.match(service, /"rate_limited"\.equals\(reason\.optString\("code"\)\) && !key\.startsWith\("agent:"\)/);
  assert.match(service, /点开换个渠道接着做/);
});
