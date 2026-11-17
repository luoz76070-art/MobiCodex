import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRelayServer } from '../dist/server/createRelayServer.js';
import { LiveTurnController } from '../dist/codex/liveTurnController.js';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synthetic-projects-'));
  const home = path.join(root, 'codex'), fallback = path.join(root, 'default');
  const a = path.join(root, 'project-a'), b = path.join(root, 'project-ab'), c = path.join(root, 'desktop-project');
  await Promise.all([home, fallback, a, b, c].map(cwd => fs.mkdir(cwd)));
  const rows = [], pages = [], calls = [];
  const store = { close() {}, getThreadSummary: async () => null,
    async listThreads(limit, offset, query, since) { pages.push({ limit, offset, query, since }); return rows.slice(offset, offset + limit); } };
  const client = Object.assign(new EventEmitter(), { start: async () => {}, stop: async () => {}, isConnected: () => true,
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: randomUUID(), cwd: params.cwd, source: 'appServer', updatedAt: 1, preview: '', path: null } };
      if (method === 'turn/start') return { turn: { id: randomUUID(), status: 'inProgress' } };
      return {};
    } });
  const liveTurns = new LiveTurnController(fallback, () => client);
  const app = await createRelayServer({ logger: false,
    config: { host: '127.0.0.1', port: 0, token: 'synthetic-project-admin', codexHome: home, defaultCwd: fallback },
    services: { store, liveTurns, live: { stop: async () => {} },
      desktopControl: { stop: async () => {}, messageQueue: { stop: async () => {} }, onStreamSnapshot: () => () => {}, followThread: () => () => {}, getStreamSnapshot: () => null },
      agentGateway: { stop: async () => {}, snapshot: () => [], sessions: () => ({}) } },
  });
  t.after(async () => { await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const request = (method, url, payload) => app.inject({ method, url, payload, headers: { authorization: 'Bearer synthetic-project-admin' } });
  const state = value => fs.writeFile(path.join(home, '.codex-global-state.json'), typeof value === 'string' ? value : JSON.stringify(value));
  const list = async () => { const response = await request('GET', '/api/projects'); assert.equal(response.statusCode, 200); return response.json().projects; };
  const send = payload => request('POST', '/api/live/turns', { message: 'synthetic task', clientMessageId: randomUUID(), ...payload });
  return { root, home, fallback, a, b, c, rows, pages, calls, app, request, state, list, send };
}

test('projects merge every all-time thread page, desktop roots and default; canonical duplicates and missing/non-directories are omitted', async t => {
  const f = await fixture(t);
  f.rows.push(...Array.from({ length: 200 }, () => ({ cwd: f.a })), { cwd: f.b, updatedAt: '2000-01-01T00:00:00Z' });
  const alias = path.join(f.root, 'alias'); await fs.symlink(f.a, alias);
  const file = path.join(f.root, 'file'); await fs.writeFile(file, 'synthetic');
  await f.state({ 'local-projects': { project: { rootPaths: [f.c, alias, null] }, changed: 1 },
    'electron-saved-workspace-roots': [f.a, file, path.join(f.root, 'gone')],
    'electron-owner-value:electron-saved-workspace-roots:synthetic': [f.b, f.fallback] });
  assert.deepEqual(await f.list(), (await Promise.all([f.a, f.b, f.c, f.fallback].map(cwd => fs.realpath(cwd)))).sort().map(cwd => ({ name: path.basename(cwd), cwd })));
  assert.deepEqual(f.pages.map(page => page.offset), [0, 200]);
  assert.ok(f.pages.every(page => page.query === '' && page.since === 0));
  assert.equal((await f.app.inject({ url: '/api/projects' })).statusCode, 401);
});

test('optional desktop state tolerates absence, invalid JSON and changed schemas', async t => {
  const f = await fixture(t), expected = [{ name: 'default', cwd: await fs.realpath(f.fallback) }];
  assert.deepEqual(await f.list(), expected);
  for (const state of ['{', null, [], { 'local-projects': 'changed', 'electron-saved-workspace-roots': {} }, { 'local-projects': { broken: null, future: { rootPaths: 3 } } }]) {
    await f.state(state); assert.deepEqual(await f.list(), expected);
  }
  await f.state({ 'local-projects': [{ rootPaths: [f.a] }] });
  assert.equal((await f.list()).length, 2);
});

test('new thread rejects relative, unknown, prefix, nested, file, missing and escaping symlink cwd before any app-server request', async t => {
  const f = await fixture(t); f.rows.push({ cwd: f.a });
  const nested = path.join(f.a, 'nested'); await fs.mkdir(nested);
  const file = path.join(f.a, 'file'); await fs.writeFile(file, 'synthetic');
  const escape = path.join(f.a, 'escape'); await fs.symlink(f.b, escape);
  for (const cwd of ['project-a', '.', null, f.b, nested, file, path.join(f.a, 'gone'), escape]) {
    const response = await f.send({ cwd });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'unknown_project');
    assert.equal(f.calls.length, 0, 'rejected before thread/start or client initialization');
  }
});

test('known aliases are canonicalized, removed projects are rejected, and omitted cwd keeps the default', async t => {
  const f = await fixture(t); f.rows.push({ cwd: f.a });
  const alias = path.join(f.root, 'alias'); await fs.symlink(f.a, alias);
  const sent = await f.send({ cwd: alias }); assert.equal(sent.statusCode, 200);
  assert.equal(f.calls.find(call => call.method === 'thread/start').params.cwd, await fs.realpath(f.a));
  await fs.rmdir(f.a);
  const count = f.calls.length;
  assert.equal((await f.send({ cwd: f.a })).json().error, 'unknown_project');
  assert.equal(f.calls.length, count);
  assert.equal((await f.send({})).statusCode, 200);
  assert.equal(f.calls.filter(call => call.method === 'thread/start').at(-1).params.cwd, f.fallback);
  // Existing-thread continuation is not a new-project admission.
  assert.equal((await f.send({ threadId: 'synthetic-existing-thread', cwd: f.b })).statusCode, 200);
  assert.equal(f.calls.filter(call => call.method === 'thread/start').length, 2);
});
