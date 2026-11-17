import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRelayServer } from '../dist/server/createRelayServer.js';
import { FeedbackStore, feedbackImageBytes } from '../dist/feedback/store.js';
import { defaultGatewayConfigPath } from '../dist/gateway/config.js';
import { png, jpeg, webp } from './fixtures/capture.mjs';
const context = { version: '0.3.1', versionCode: 42, page: '会话', agentId: 'ccdesk', sessionId: 'synthetic-session', lastError: '连接中断', model: '测试手机', os: 'Android 16' };
const input = (extra = {}) => ({ clientId: randomUUID(), text: '返回会话时没有恢复原来的位置', context, ...extra });
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'feedback-'));
  const dataDirectory = path.join(root, 'private-data'), workspace = path.join(root, 'project');
  await fs.mkdir(workspace);
  const app = await createRelayServer({ logger: false, config: { host: 'localhost', port: 0, token: 'synthetic-admin', codexHome: path.join(root, 'no-sessions'), defaultCwd: workspace, dataDirectory },
    services: { desktopControl: { stop: async () => {} }, liveTurns: { stop: async () => {} } } });
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
