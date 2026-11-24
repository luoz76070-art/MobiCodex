import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRelayServer } from '../dist/server/createRelayServer.js';
import { FeedbackStore, feedbackImageBytes } from '../dist/feedback/store.js';
import { defaultGatewayConfigPath, parseManagedConfig } from '../dist/gateway/config.js';
import { FeedbackIssueError, createFeedbackRedactor, createFeedbackSubmitter, ghIssueClient } from '../dist/feedback/github.js';
import { png, jpeg, webp } from './fixtures/capture.mjs';
const context = { version: '0.3.1', versionCode: 42, page: '会话', agentId: 'ccdesk', sessionId: 'synthetic-session', lastError: '连接中断', model: '测试手机', os: 'Android 16' };
const input = (extra = {}) => ({ clientId: randomUUID(), text: '返回会话时没有恢复原来的位置', context, ...extra });
async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-'));
  const dataDirectory = path.join(root, 'private-data'), workspace = path.join(root, 'project');
  await fs.mkdir(workspace);
  const app = await createRelayServer({ logger: false, config: { host: 'localhost', port: 0, token: 'synthetic-admin', codexHome: path.join(root, 'no-sessions'), defaultCwd: workspace, dataDirectory,
    ...(extra.feedback ? { feedback: extra.feedback, feedbackHide: ['relay.example.net'] } : {}) },
    services: { desktopControl: { stop: async () => {} }, liveTurns: { stop: async () => {} }, ...(extra.issues ? { feedbackIssues: extra.issues } : {}) } });
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const admin = { authorization: 'Bearer synthetic-admin' };
  const pair = async () => {
    const pairing = (await app.inject({ method: 'POST', url: '/api/pairing', headers: admin })).json();
    const result = (await app.inject({ method: 'POST', url: '/api/pairing/consume', payload: { code: pairing.code, name: '测试设备' } })).json();
    return { headers: { authorization: `Bearer ${result.token}` }, id: result.device.id };
  };
  return { app, root, dataDirectory, workspace, admin, pair,
    post: (headers, payload = input()) => app.inject({ method: 'POST', url: '/api/feedback', headers, payload }),
    list: headers => app.inject({ url: '/api/feedback', headers }),
    targets: headers => app.inject({ url: '/api/feedback/targets', headers }),
    preview: (headers, payload) => app.inject({ method: 'POST', url: '/api/feedback/preview', headers, payload }),
  };
}
test('feedback authenticates before parsing, rejects invalid credentials and revoked devices', async t => {
  const f = await fixture(t);
  assert.equal((await f.post({ 'content-type': 'application/json' }, '{bad')).statusCode, 401);
  assert.equal((await f.list({ authorization: 'Bearer not-a-device' })).statusCode, 401);
  const device = await f.pair();
  assert.equal((await f.post(device.headers)).statusCode, 200);
  await f.app.inject({ method: 'DELETE', url: `/api/devices/${device.id}`, headers: f.admin });
  assert.equal((await f.post(device.headers)).statusCode, 401);
  assert.equal((await f.list(device.headers)).statusCode, 401);
});
test('text, UUID, screenshot and every context field have strict schema and length bounds', async t => {
  const f = await fixture(t), { headers } = await f.pair();
  for (const payload of [input({ text: '' }), input({ text: ' '.repeat(4) }), input({ text: '字'.repeat(2001) }), input({ clientId: 'not-a-uuid' }), input({ owner: 'another-device' }), input({ screenshot: { fileName: 'fake.png', mimeType: 'image/png', dataBase64: 'eA==' } })]) assert.equal((await f.post(headers, payload)).statusCode, 400);
  for (const [name, max] of [['version',80],['page',80],['agentId',64],['sessionId',160],['lastError',200],['model',120],['os',120]]) {
    assert.equal((await f.post(headers, input({ context: { ...context, [name]: 'x'.repeat(max + 1) } }))).statusCode, 400, name);
  }
  assert.equal((await f.post(headers, input({ context: { ...context, versionCode: -1 } }))).statusCode, 400);
  assert.equal((await f.post(headers, input({ context: { ...context, unknown: 'not allowed' } }))).statusCode, 400);
  assert.equal((await f.post(headers, input({ text: '字'.repeat(2000) }))).statusCode, 200);
});
test('image headers and structure must agree with MIME; size is checked after decoding', async t => {
  const f = await fixture(t), { headers } = await f.pair();
  for (const [data, mimeType] of [[png(),'image/png'],[jpeg(),'image/jpeg'],[webp(),'image/webp']]) {
    const result = await f.post(headers, input({ screenshot: { mimeType, dataBase64: data.toString('base64') } }));
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().screenshot.mimeType, mimeType);
  }
  for (const [data, mimeType] of [[Buffer.from('<svg/>'),'image/png'],[png(),'image/jpeg'],[png().subarray(0,12),'image/png']]) assert.equal((await f.post(headers, input({ screenshot: { mimeType, dataBase64: data.toString('base64') } }))).statusCode, 422);
  assert.equal((await f.post(headers, input({ screenshot: { mimeType: 'image/png', dataBase64: '!!!!' } }))).statusCode, 400);
  // The base64 length still fits the schema: the decoded size must enforce the exact 5MiB boundary.
  const oversized = Buffer.alloc(feedbackImageBytes + 1).toString('base64');
  assert.equal((await f.post(headers, input({ screenshot: { mimeType: 'image/png', dataBase64: oversized } }))).statusCode, 413);
});
test('concurrent duplicate UUIDs return one receipt, persist across restart, and cannot rewrite human status', async t => {
  const f = await fixture(t), device = await f.pair(), payload = input();
  const results = await Promise.all(Array.from({ length: 5 }, () => f.post(device.headers, payload)));
  for (const result of results) { assert.equal(result.statusCode, 200); assert.deepEqual(result.json(), results[0].json()); }
  const receipt = results[0].json(), file = path.join(f.dataDirectory, 'feedback', `${receipt.id}.json`);
  const stored = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const status of [{ state: 'filed', issue: 12 }, { state: 'fixed', version: '0.3.2' }, { state: 'dismissed', reason: '已有相同反馈' }]) {
    await fs.writeFile(file, JSON.stringify({ ...stored, status }));
    const retried = await f.post(device.headers, { ...payload, text: 'same clientId must not rewrite the first text' });
    assert.deepEqual(retried.json().status, status); assert.equal(retried.json().text, payload.text);
    assert.deepEqual((await f.list(device.headers)).json().items[0].status, status);
  }
  const reloaded = new FeedbackStore(f.dataDirectory);
  assert.equal((await reloaded.save(payload, device.id, () => {})).id, receipt.id);
  assert.equal((await reloaded.list(device.id, () => {})).length, 1);
  assert.equal((await f.app.inject({ method: 'PATCH', url: '/api/feedback', headers: device.headers, payload: { status: { state: 'fixed', version: '0.3.2' } } })).statusCode, 404);
});
test('deduplication is scoped to a device and GET never returns another device or owner/private file metadata', async t => {
  const f = await fixture(t), a = await f.pair(), b = await f.pair(), payload = input();
  const first = (await f.post(a.headers, payload)).json(), second = (await f.post(b.headers, payload)).json();
  assert.notEqual(first.id, second.id);
  for (const [device, id] of [[a,first.id],[b,second.id]]) {
    const response = await f.list(device.headers);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(response.json().items.map(item => item.id), [id]);
    assert.equal('owner' in response.json().items[0], false);
    assert.equal('screenshotPath' in response.json().items[0], false);
  }
});
test('#59 finished feedback is removed a week after its last change; waiting feedback always stays', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-prune-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = Date.parse('2026-11-01T00:00:00.000Z');
  const store = new FeedbackStore(root, () => now), dir = path.join(root, 'feedback');
  const states = { received: { state: 'received' }, retrying: { state: 'retrying', reason: '连不上 GitHub' }, filed: { state: 'filed', issue: 3 },
    fixed: { state: 'fixed', version: '0.4.6' }, dismissed: { state: 'dismissed', reason: '重复' }, recent: { state: 'filed', issue: 4 } };
  const ids = {};
  for (const [name, status] of Object.entries(states)) {
    const receipt = await store.save(input({ text: name }), 'admin', () => {}); ids[name] = receipt.id;
    const file = path.join(dir, `${receipt.id}.json`), stored = JSON.parse(await fs.readFile(file, 'utf8'));
    await fs.writeFile(file, JSON.stringify({ ...stored, status }), { mode: 0o600 });
    const changed = new Date(name === 'recent' ? now + 6 * 86_400_000 : now);
    await fs.utimes(file, changed, changed);
  }
  await fs.writeFile(path.join(dir, `${ids.filed}.png`), png(), { mode: 0o600 });
  now += 8 * 86_400_000;
  assert.equal(await store.prune(), 3);
  const left = (await store.list('admin', () => {})).map(item => item.text).sort();
  assert.deepEqual(left, ['received', 'recent', 'retrying']);
  await assert.rejects(fs.access(path.join(dir, `${ids.filed}.png`)), 'the screenshot goes with its receipt');
  assert.equal(await store.prune(), 0);
});
test('per-device rolling hourly limit survives restart; duplicates do not count and other devices are independent', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-limit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = Date.parse('2026-11-17T00:00:00.000Z');
  let store = new FeedbackStore(root, () => now);
  const first = input();
  await store.save(first, 'device-a', () => {});
  for (let n = 1; n < 20; n++) await store.save(input(), 'device-a', () => {});
  store = new FeedbackStore(root, () => now);
  await store.save(first, 'device-a', () => {});
  await assert.rejects(store.save(input(), 'device-a', () => {}), { statusCode: 429 });
  await store.save(input(), 'device-b', () => {});
  now += 3_600_000;
  await store.save(input(), 'device-a', () => {});
});
test('JSON and screenshot are private, in a private feedback directory outside the project', async t => {
  const f = await fixture(t), { headers } = await f.pair();
  const result = (await f.post(headers, input({ screenshot: { mimeType: 'image/png', dataBase64: png().toString('base64') } }))).json();
  const directory = path.join(f.dataDirectory, 'feedback');
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  for (const extension of ['json','png']) assert.equal((await fs.stat(path.join(directory, `${result.id}.${extension}`))).mode & 0o777, 0o600);
  await assert.rejects(fs.access(path.join(f.workspace, 'feedback')));
  assert.ok(path.isAbsolute(defaultGatewayConfigPath()));
  assert.equal(path.basename(defaultGatewayConfigPath()), 'gateway.json');
  const stored = await fs.readFile(path.join(directory, `${result.id}.json`), 'utf8');
  assert.ok(!stored.includes('Bearer'));
});
test('a symlink inbox is rejected and failed guards do not commit a receipt', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-links-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'elsewhere'));
  await fs.symlink(path.join(root, 'elsewhere'), path.join(root, 'feedback'));
  const store = new FeedbackStore(root);
  await assert.rejects(store.save(input(), 'device-a', () => {}), { message: 'feedback_store_unavailable' });
  await fs.unlink(path.join(root, 'feedback'));
  await assert.rejects(store.save(input(), 'device-a', () => { throw new Error('revoked'); }), /revoked/);
  assert.deepEqual(await fs.readdir(path.join(root, 'elsewhere')), []);
});

const repo = 'example-owner/example-repo';
const github = { repos: [{ id: 'mobicodex', repo, label: 'MobiCodex', public: true }] };
function fakeIssues() {
  const calls = [], issues = [], fake = { calls, issues, fail: undefined, existing: undefined };
  fake.client = {
    async find(name, marker) { calls.push(['find', name]); return fake.existing ?? issues.find(issue => issue.repo === name && issue.body.includes(marker))?.number; },
    async create(name, issue) {
      calls.push(['create', name]);
      if (fake.fail) throw fake.fail;
      issues.push({ repo: name, number: issues.length + 1, ...issue }); return issues.length;
    },
  };
  return fake;
}
const receiptFile = (f, id) => path.join(f.dataDirectory, 'feedback', `${id}.json`);

test('targets come from the gateway config; preview hides private details and rejects unknown targets', async t => {
  const fake = fakeIssues(), f = await fixture(t, { feedback: { github }, issues: fake.client }), { headers } = await f.pair();
  const targets = await f.targets(headers);
  assert.equal(targets.headers['cache-control'], 'no-store');
  assert.deepEqual(targets.json(), { targets: [{ id: 'mobicodex', label: 'MobiCodex', repo, public: true }] });
  assert.equal((await f.targets({ authorization: 'Bearer not-a-device' })).statusCode, 401);
  const text = [`打开 ${os.homedir()}/secret-project/a.txt 失败`, '联系 someone@example.com，服务器 10.1.2.3:8080，https://relay.example.net/x?k=1',
    `令牌 sk-${'a'.repeat(24)}，管理口令 synthetic-admin，提一下 @octocat`, `看 https://github.com/${repo}/issues/1`].join('\n');
  const preview = await f.preview(headers, { text, context: { ...context, lastError: '连接 /Users/somebody/x 超时' }, target: 'mobicodex' });
  assert.equal(preview.statusCode, 200, preview.body);
  const { title, body, target } = preview.json();
  assert.deepEqual(target, { id: 'mobicodex', label: 'MobiCodex', repo, public: true });
  assert.equal(title, '手机反馈：打开 ~/secret-project/a.txt 失败');
  for (const hidden of [os.homedir(), 'someone@example.com', '10.1.2.3', 'relay.example.net', 'sk-aaaa', 'synthetic-admin', 'synthetic-session', '/Users/somebody', '@octocat'])
    assert.ok(!body.includes(hidden) && !title.includes(hidden), hidden);
  for (const kept of [`https://github.com/${repo}/issues/1`, '@\u200boctocat', '| 版本 | 0.3.1（code42） |', '| 手机 | 测试手机 · Android 16 |', '| 最近错误 | 连接 ~/x 超时 |', '| Agent | ccdesk |'])
    assert.ok(body.includes(kept), kept);
  assert.ok(!body.includes('mobicodex-feedback:'), 'the marker is added only when filing');
  assert.equal((await f.preview(headers, { text, context, target: 'elsewhere' })).json().error, 'feedback_unknown_target');
  const unknown = await f.post(headers, input({ target: 'elsewhere' }));
  assert.equal(unknown.statusCode, 400); assert.equal(unknown.json().error, 'feedback_unknown_target');
  assert.deepEqual((await f.list(headers)).json().items, []); assert.deepEqual(fake.calls, []);
  const local = await fixture(t), device = await local.pair();
  assert.deepEqual((await local.targets(device.headers)).json(), { targets: [] });
  assert.equal((await local.preview(device.headers, { text, context, target: 'mobicodex' })).statusCode, 400);
  assert.equal((await local.post(device.headers, input({ target: 'mobicodex' }))).statusCode, 400);
});

test('feedback with a target is filed once, exactly as previewed plus the marker; resending keeps the receipt', async t => {
  const fake = fakeIssues(), f = await fixture(t, { feedback: { github }, issues: fake.client }), { headers } = await f.pair();
  const payload = input({ target: 'mobicodex' });
  const preview = (await f.preview(headers, { text: payload.text, context, target: 'mobicodex' })).json();
  const first = await f.post(headers, payload);
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json().status, { state: 'filed', issue: 1, repo }); assert.equal(first.json().target, 'mobicodex');
  assert.deepEqual(fake.calls, [['find', repo], ['create', repo]]);
  assert.equal(fake.issues[0].title, preview.title);
  assert.equal(fake.issues[0].body, `${preview.body}\n\n<!-- mobicodex-feedback:${first.json().id} -->\n`);
  assert.deepEqual((await f.post(headers, payload)).json(), first.json()); assert.equal(fake.calls.length, 2);
  const stored = JSON.parse(await fs.readFile(receiptFile(f, first.json().id), 'utf8'));
  assert.equal(stored.target, 'mobicodex'); assert.deepEqual(stored.status, { state: 'filed', issue: 1, repo });
  const local = await f.post(headers, input());
  assert.deepEqual(local.json().status, { state: 'received' }); assert.equal('target' in local.json(), false); assert.equal(fake.calls.length, 2);
});

test('a failed submission says why without gh output, a later sweep files it, and a marker match is never filed twice', async t => {
  const fake = fakeIssues(), f = await fixture(t, { feedback: { github }, issues: fake.client }), { headers } = await f.pair();
  fake.fail = new FeedbackIssueError('gh_network');
  const failed = (await f.post(headers, input({ target: 'mobicodex' }))).json();
  assert.deepEqual(failed.status, { state: 'retrying', reason: '电脑连不上 GitHub' });
  fake.fail = new Error('gh: secret-host.example could not be reached');
  const other = (await f.post(headers, input({ target: 'mobicodex' }))).json();
  assert.deepEqual(other.status, { state: 'retrying', reason: '提交没成功' });
  assert.deepEqual((await f.list(headers)).json().items.map(item => item.status.state), ['retrying', 'retrying']);
  // The first attempt did reach GitHub; only its reply was lost.
  fake.fail = undefined; fake.existing = 7;
  const targets = new Map(github.repos.map(target => [target.id, target]));
  const submitter = createFeedbackSubmitter({ store: new FeedbackStore(f.dataDirectory), targets, client: fake.client, redact: createFeedbackRedactor() });
  await submitter.sweep(); await submitter.stop();
  for (const item of (await f.list(headers)).json().items) assert.deepEqual(item.status, { state: 'filed', issue: 7, repo });
  assert.equal(fake.calls.filter(([name]) => name === 'create').length, 2, 'no create after a marker match');
});

test('a person\'s triage always wins over the gateway, and an unconfigured target waits with a reason', async t => {
  const fake = fakeIssues(), f = await fixture(t, { feedback: { github }, issues: fake.client }), { headers } = await f.pair();
  fake.fail = new FeedbackIssueError('gh_auth');
  const receipt = (await f.post(headers, input({ target: 'mobicodex' }))).json();
  assert.match(receipt.status.reason, /没登录 GitHub/);
  const file = receiptFile(f, receipt.id), stored = JSON.parse(await fs.readFile(file, 'utf8'));
  await fs.writeFile(file, JSON.stringify({ ...stored, status: { state: 'dismissed', reason: '已有相同反馈' } }));
  fake.fail = undefined; const before = fake.calls.length;
  const store = new FeedbackStore(f.dataDirectory);
  const submitter = createFeedbackSubmitter({ store, targets: new Map(github.repos.map(target => [target.id, target])), client: fake.client, redact: createFeedbackRedactor() });
  await submitter.sweep(); await submitter.kick(receipt.id);
  assert.equal(fake.calls.length, before);
  assert.equal(await store.transition(receipt.id, { state: 'filed', issue: 3, repo }), false);
  assert.deepEqual((await f.list(headers)).json().items[0].status, { state: 'dismissed', reason: '已有相同反馈' });
  // The gateway lost the repo from its config after accepting the feedback.
  await fs.writeFile(file, JSON.stringify({ ...stored, status: { state: 'received' } }));
  const bare = createFeedbackSubmitter({ store, targets: new Map(), client: fake.client, redact: createFeedbackRedactor() });
  await bare.sweep(); await bare.stop(); await submitter.stop();
  assert.deepEqual((await f.list(headers)).json().items[0].status, { state: 'retrying', reason: '电脑上的网关没有配置这个仓库' });
  assert.equal(fake.calls.length, before);
});

test('gateway config accepts feedback.github and rejects unsafe values', () => {
  const base = { version: 1, port: 8787, token: 'a'.repeat(40), managerKey: 'b'.repeat(40), codexHome: '/c', workspace: '/w', desktopTransport: 'native' };
  const ok = parseManagedConfig({ ...base, feedback: { github: { ...github, gh: '/usr/local/bin/gh', proxy: 'http://proxy.invalid:3128' } } });
  assert.equal(ok.feedback.github.repos[0].repo, repo);
  assert.equal(parseManagedConfig(base).feedback, undefined);
  for (const bad of [{ gh: 'gh' }, { proxy: 'not a url' }, { repos: [] }, { repos: [{ ...github.repos[0], repo: 'no-slash' }] },
    { repos: [github.repos[0], github.repos[0]] }, { repos: [{ ...github.repos[0], id: 'Upper' }] }, { token: 'not allowed' }])
    assert.throws(() => parseManagedConfig({ ...base, feedback: { github: { ...github, ...bad } } }), JSON.stringify(bad));
});

test('redaction keeps versions and ordinary words but hides home, accounts, machine, mail, hosts and secrets', () => {
  const redact = createFeedbackRedactor({ home: '/Users/example', username: 'example', hostname: 'Example-Mac.local', hide: ['relay.example.net', 'z'.repeat(40)] });
  for (const [value, expected] of [
    ['/Users/example/project/a.ts', '~/project/a.ts'], ['/home/other/b', '~/b'], ['C:\\Users\\Other\\c', '~\\c'],
    ['用户example的Example-Mac', '用户<已隐藏>的<已隐藏>'], ['Example-Mac.local 上', '<已隐藏> 上'], ['examples 0.4.4 code47 abc1234', 'examples 0.4.4 code47 abc1234'],
    ['Bearer abc.def-123', 'Bearer <密钥>'], [`ghp_${'A1'.repeat(15)}`, '<密钥>'], [`github_pat_${'b2'.repeat(15)}`, '<密钥>'],
    ['a@b.io', '<邮箱>'], ['192.168.1.20:22', '<IP 地址>'], ['wss://relay.example.net/ws', '<网址>'], ['relay.example.net 断开', '<已隐藏> 断开'],
    ['f'.repeat(40), '<长串>'], [`key ${'Gx9'.repeat(16)}`, 'key <长串>'], ['访问https://example.org/a然后失败', '访问<网址>然后失败'], ['/Users/example2的项目', '~的项目'], ['z'.repeat(40), '<已隐藏>'],
  ]) assert.equal(redact(value), expected, value);
});

test('the gh client uses fixed arguments, sends the body on stdin, sets the proxy and maps failures to fixed reasons', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-gh-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const log = path.join(root, 'calls.jsonl'), script = (name, source) => { const file = path.join(root, name); return fs.writeFile(file, `#!/usr/bin/env node\n${source}`, { mode: 0o755 }).then(() => file); };
  const ok = await script('gh-ok', `const fs = require('node:fs'); let input = '';
process.stdin.on('data', chunk => { input += chunk; }).on('end', () => {
  const args = process.argv.slice(2);
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, input, proxy: process.env.HTTPS_PROXY, prompt: process.env.GH_PROMPT_DISABLED }) + '\\n');
  if (args[0] === 'label') { process.stderr.write('label already exists'); process.exit(1); }
  if (args[0] === 'issue' && args[1] === 'list') process.stdout.write(JSON.stringify([{ number: 3, body: 'x <!-- mobicodex-feedback:abc -->' }, { number: 2, body: 'y' }]));
  if (args[0] === 'issue' && args[1] === 'create') process.stdout.write('https://github.com/${repo}/issues/12\\n');
});`);
  const client = ghIssueClient({ gh: ok, proxy: 'http://proxy.invalid:3128' });
  assert.equal(await client.find(repo, '<!-- mobicodex-feedback:abc -->'), 3);
  assert.equal(await client.find(repo, '<!-- mobicodex-feedback:other -->'), undefined);
  assert.equal(await client.create(repo, { title: '手机反馈：标题 `$(echo no)`', body: '正文 $(echo no)\n第二行' }), 12);
  assert.equal(await client.create(repo, { title: 'again', body: 'b' }), 12);
  const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.map(call => call.args.slice(0, 2)), [['issue', 'list'], ['issue', 'list'], ['label', 'create'], ['issue', 'create'], ['issue', 'create']]);
  assert.deepEqual(calls[0].args, ['issue', 'list', '-R', repo, '--label', 'from-phone', '--state', 'all', '--limit', '200', '--json', 'number,body']);
  assert.deepEqual(calls[3].args, ['issue', 'create', '-R', repo, '--title', '手机反馈：标题 `$(echo no)`', '--body-file', '-', '--label', 'from-phone']);
  assert.equal(calls[3].input, '正文 $(echo no)\n第二行');
  for (const call of calls) { assert.equal(call.proxy, 'http://proxy.invalid:3128'); assert.equal(call.prompt, '1'); }
  const auth = await script('gh-auth', `process.stderr.write('To get started with GitHub CLI, please run:  gh auth login'); process.exit(4);`);
  const missingRepo = await script('gh-repo', `process.stderr.write('GraphQL: Could not resolve to a Repository with the name x/y.'); process.exit(1);`);
  const slow = await script('gh-slow', `setTimeout(() => {}, 10000);`);
  const garbage = await script('gh-garbage', `process.stdout.write('not json');`);
  for (const [gh, reason, timeoutMs] of [[auth, 'gh_auth'], [missingRepo, 'gh_repo'], [slow, 'gh_timeout', 300], [path.join(root, 'absent'), 'gh_missing'], [garbage, 'gh_failed']])
    await assert.rejects(ghIssueClient({ gh, timeoutMs }).find(repo, 'm'), error => error instanceof FeedbackIssueError && error.reason === reason, reason);
});
