// CC Desk (C2): the gateway's own read connections against a stand-in service of protocol 17, and writes through
// a stand-in of the patched client's socket. See docs/plans/2026-11-15-c2-ccdesk-gateway.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { CcDeskAdapter } from '../dist/agents/ccDeskAdapter.js';
import { CcDeskConnection } from '../dist/agents/ccDeskConnection.js';
import { CcDeskControl } from '../dist/agents/ccDeskControl.js';
import { ccDeskConfigSchema } from '../dist/agents/ccDeskProtocol.js';
import { parseManagedConfig } from '../dist/gateway/config.js';
import { ccDeskDefaults } from '../dist/gateway/ccDeskSetup.js';

const TOKEN = 't'.repeat(40);
const MAC = randomUUID(), LAPTOP = randomUUID();
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ccd-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1',
  '-keyout', path.join(scratch, 'key.pem'), '-out', path.join(scratch, 'cert.pem')], { stdio: 'ignore' });
const fingerprint = execFileSync('openssl', ['x509', '-in', path.join(scratch, 'cert.pem'), '-noout', '-fingerprint', '-sha256'], { encoding: 'utf8' }).trim().split('=')[1];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label = 'condition') { const end = Date.now() + 4000; while (!predicate()) { if (Date.now() > end) assert.fail(`timeout: ${label}`); await sleep(10); } }

// A stand-in CC Desk service: auth, ready, one subscription per connection, history pages, broadcasts.
async function service({ protocol = 17, visibility = 'shared' } = {}) {
  const server = https.createServer({ key: fs.readFileSync(path.join(scratch, 'key.pem')), cert: fs.readFileSync(path.join(scratch, 'cert.pem')) });
  const wss = new WebSocketServer({ server, path: '/ws' });
  const now = () => new Date().toISOString();
  const state = { sessions: new Map(), events: new Map(), peers: new Set(), frames: [], deviceFrames: 0, auths: 0, renames: 0, leaves: 0, sequence: new Map(), open: new Map() };
  // As the service with PROXY_SESSION_VISIBILITY=device: a computer sees only its own sessions.
  const visible = (peer, session) => visibility !== 'device' || (peer.device && session.device.id === peer.device.id);
  const ready = peer => send(peer, { type: 'ready', protocolVersion: protocol, connectionId: randomUUID(), adapter: 'claude-code', version: '0.3.2',
    sessions: [...state.sessions.values()].filter(session => visible(peer, session)) });
  const session = (id, title, device, extra = {}) => {
    state.sessions.set(id, { id, title, projectPath: `/work/${title}`, device: { id: device, name: device === MAC ? 'Mac' : 'LAPTOP', platform: device === MAC ? 'darwin' : 'win32' },
      permissionMode: 'default', createdAt: now(), updatedAt: now(), activeRun: null, ...extra });
    state.events.set(id, []); state.sequence.set(id, 0);
    return id;
  };
  const send = (peer, message) => peer.socket.send(JSON.stringify(message));
  const record = (sessionId, runId, payload) => {
    const sequence = state.sequence.get(sessionId) + 1; state.sequence.set(sessionId, sequence);
    const event = { sessionId, runId, sequence, createdAt: now(), payload };
    state.events.get(sessionId).push(event);
    for (const peer of state.peers) if (peer.subscription === sessionId) send(peer, { type: 'session.event', event });
    return event;
  };
  const fragment = (sessionId, runId, payload) => { for (const peer of state.peers) if (peer.subscription === sessionId) send(peer, { type: 'session.fragment', sessionId, runId, payload }); };
  const update = (sessionId, changes) => {
    const value = { ...state.sessions.get(sessionId), ...changes, updatedAt: now() }; state.sessions.set(sessionId, value);
    for (const peer of state.peers) if (peer.ready && visible(peer, value)) send(peer, { type: 'session.updated', session: value });
  };
  wss.on('connection', socket => {
    const peer = { socket, ready: false, subscription: null };
    state.peers.add(peer);
    socket.on('close', () => state.peers.delete(peer));
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString()); state.frames.push(message);
      if (message.type === 'auth') {
        state.auths++;
        if (message.token !== TOKEN) { send(peer, { type: 'connection.error', code: 'unauthorized', message: 'no' }); return socket.close(4001); }
        if (message.protocolVersion !== protocol) { send(peer, { type: 'connection.error', code: 'version_mismatch', message: 'no' }); return socket.close(4002); }
        peer.ready = true; peer.name = message.deviceName;
        return ready(peer);
      }
      if (message.type === 'device') {
        state.deviceFrames++;
        peer.device = { id: message.id, name: peer.name, ...(message.platform ? { platform: message.platform } : {}) };
        // The service renames a computer's sessions after the name its latest connection gave.
        for (const value of state.sessions.values())
          if (value.device.id === message.id && value.device.name !== peer.name) { value.device = peer.device; state.renames++; }
        if (visibility === 'device') ready(peer);
        return;
      }
      if (message.type === 'leave') { state.leaves++; return; }
      const known = state.sessions.get(message.sessionId);
      if ((message.type === 'session.subscribe' || message.type === 'session.history') && (!known || !visible(peer, known)))
        return send(peer, { type: 'response', requestId: message.requestId, ok: false, code: 'not_found', message: 'no' });
      const all = state.events.get(message.sessionId) ?? [];
      if (message.type === 'session.subscribe') {
        // As the service: only what follows `afterSequence` when that fits a page, else the last page.
        peer.subscription = message.sessionId;
        const last = all.at(-1)?.sequence ?? 0, after = message.afterSequence ?? 0;
        if (after > last) return send(peer, { type: 'response', requestId: message.requestId, ok: false, code: 'invalid_cursor', message: 'no' });
        const newer = all.filter(event => event.sequence > after), append = after > 0 && newer.length <= 6;
        const events = append ? newer : all.slice(-6);
        send(peer, { type: 'session.snapshot', requestId: message.requestId, session: state.sessions.get(message.sessionId), events, mode: append ? 'append' : 'replace',
          firstSequence: events[0]?.sequence ?? 0, lastSequence: last, hasEarlier: !append && all.length > 6 });
        // The history ends where the run's unfinished output begins.
        const open = state.open.get(message.sessionId);
        if (open) send(peer, { type: 'session.fragment', sessionId: message.sessionId, runId: open.runId, payload: open.payload });
      } else if (message.type === 'session.history') {
        const before = all.filter(event => event.sequence < message.beforeSequence), events = before.slice(-6);
        send(peer, { type: 'session.snapshot', requestId: message.requestId, session: state.sessions.get(message.sessionId), events, mode: 'prepend',
          firstSequence: events[0]?.sequence ?? 0, lastSequence: all.at(-1)?.sequence ?? 0, hasEarlier: before.length > 6 });
      }
      send(peer, { type: 'response', requestId: message.requestId, ok: true, sessionId: message.sessionId });
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, get deviceFrames() { return state.deviceFrames; }, get auths() { return state.auths; }, get renames() { return state.renames; }, get leaves() { return state.leaves; },
    events: state.events, sessions: state.sessions, peers: state.peers, frames: state.frames,
    url: `wss://127.0.0.1:${server.address().port}/ws`, session, record, fragment, update,
    open: (sessionId, runId, payload) => { if (payload) state.open.set(sessionId, { runId, payload }); else state.open.delete(sessionId); },
    close: () => new Promise(resolve => { for (const client of wss.clients) client.terminate(); wss.close(); server.close(resolve); }) };
}

// A stand-in of the patched client's socket (integrations/cc-desk/control.mjs, protocol of controlVersion 1).
async function controlSocket(url, { writable = true, device = { id: MAC, name: 'Mac' }, answer = command => ({ ok: true, sessionId: command.sessionId }) } = {}) {
  const directory = fs.mkdtempSync(path.join(scratch, 'c')), socketPath = path.join(directory, 'a.sock');
  const commands = [], clients = new Set();
  const server = net.createServer(client => {
    clients.add(client); client.setEncoding('utf8');
    client.write(JSON.stringify({ event: 'state', state: { connected: true, writable, adapter: 'claude-code', protocolVersion: 17, device, controlVersion: 1 } }) + '\n');
    let text = '';
    client.on('data', chunk => {
      text += chunk; let end;
      while ((end = text.indexOf('\n')) >= 0) {
        const request = JSON.parse(text.slice(0, end)); text = text.slice(end + 1);
        commands.push(request.command);
        const reply = answer(request.command);
        if (reply === null) continue;
        client.write(JSON.stringify(reply.error ? { id: request.id, ok: false, error: reply.error } : { id: request.id, ok: true, response: reply }) + '\n');
      }
    });
    client.on('close', () => clients.delete(client));
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  fs.writeFileSync(path.join(directory, 'a.json'), JSON.stringify({ service: url, socket: socketPath, pid: process.pid, controlVersion: 1 }));
  return { directory, commands, push: state => { for (const client of clients) client.write(JSON.stringify({ event: 'state', state }) + '\n'); },
    close: () => new Promise(resolve => { for (const client of clients) client.destroy(); server.close(resolve); }) };
}

function adapter(fake, control, extra = {}, deps = {}) {
  const config = ccDeskConfigSchema.parse({ url: fake.url, fingerprint, deviceId: MAC, ...(control ? { controlDirectory: control.directory } : { controlDirectory: path.join(scratch, 'none') }), ...extra });
  return new CcDeskAdapter(config, { readToken: async () => TOKEN, ...deps });
}
function watcher(instance, id) {
  const seen = []; let disconnected = false;
  return instance.watchSession(id, snapshot => seen.push(snapshot), () => { disconnected = true; })
    .then(close => ({ seen, close, last: () => seen.at(-1), disconnected: () => disconnected }));
}
const op = (snapshot) => ({ controlToken: snapshot.control.token, clientMessageId: randomUUID() });

test('lingering watches reuse the connection and immediately deliver text received while away', async t => {
  const fake = await service(), connections = [];
  const id = fake.session(randomUUID(), 'warm', MAC), run = randomUUID();
  const instance = adapter(fake, null, {}, { lingerMs: 1000, connection: options => {
    const connection = new CcDeskConnection(options); connections.push(connection); return connection;
  } });
  t.after(async () => { await instance.stop(); await fake.close(); });
  const first = await watcher(instance, id), second = await watcher(instance, id);
  first.close();
  assert.equal(connections[0].closed, false, 'another listener still owns the connection');
  second.close();
  const incoming = new Promise(resolve => {
    const received = message => {
      if (message.type !== 'session.event') return;
      connections[0].off('message', received); resolve();
    };
    connections[0].on('message', received);
  });
  fake.record(id, run, { type: 'text.delta', messageId: randomUUID(), text: '后台收到的新回复' });
  await incoming;
  const returned = await watcher(instance, id);
  assert.equal(returned.seen.length, 1, 'current view is delivered before watchSession resolves');
  assert.equal(returned.last().messages.at(-1).text, '后台收到的新回复');
  assert.equal(returned.last().control.token, first.last().control.token);
  assert.equal(connections.length, 1);
  assert.equal(fake.frames.filter(frame => frame.type === 'session.subscribe').length, 1);
  await sleep(1100);
  assert.equal(connections[0].closed, false, 'returning cancels the old linger deadline');
  first.close(); second.close();
  assert.equal(connections[0].closed, false, 'old cancellation functions are idempotent');
  returned.close();
});

test('the last listener starts a deadline; expiry closes the connection and a later watch subscribes anew', async t => {
  const fake = await service();
  const id = fake.session(randomUUID(), 'expires', MAC);
  const instance = adapter(fake, null, {}, { lingerMs: 40 });
  t.after(async () => { await instance.stop(); await fake.close(); });
  const first = await watcher(instance, id);
  first.close();
  assert.equal(fake.peers.size, 1);
  await until(() => fake.peers.size === 0, 'linger expired');
  assert.equal(first.disconnected(), false, 'leaving does not notify an already removed listener');
  const returned = await watcher(instance, id);
  assert.notEqual(returned.last().control.token, first.last().control.token);
  assert.equal(fake.frames.filter(frame => frame.type === 'session.subscribe').length, 2);
});

test('a session read before is followed from where it was: only the events since, nothing twice, the running output once', async t => {
  const fake = await service();
  const id = fake.session(randomUUID(), 'resume', MAC), run = randomUUID(), answer = randomUUID(), more = randomUUID(), tool = randomUUID(), approval = randomUUID();
  const instance = adapter(fake, null, {}, { lingerMs: 20 });
  t.after(async () => { await instance.stop(); await fake.close(); });
  fake.record(id, run, { type: 'message.user', messageId: randomUUID(), text: '先看看' });
  fake.record(id, run, { type: 'text.delta', messageId: answer, text: '第一段' });
  fake.record(id, run, { type: 'tool.requested', toolId: tool, name: 'Bash', input: '{"command":"ls"}' });
  fake.record(id, run, { type: 'approval.requested', approvalId: approval, toolId: tool });
  fake.update(id, { activeRun: { id: run, status: 'awaiting_approval', connectionId: 'c' } });
  const first = await watcher(instance, id);
  assert.equal(first.last().permissions.length, 1);
  fake.fragment(id, run, { type: 'text.delta', messageId: more, text: '正在' });
  await until(() => first.last().messages.some(message => message.text === '正在'), 'live output');
  first.close();
  await until(() => fake.peers.size === 0, 'reader dropped');
  // While nobody reads, the approval is answered and the turn goes on; its newest output is not recorded yet.
  fake.record(id, run, { type: 'approval.resolved', approvalId: approval });
  fake.record(id, run, { type: 'tool.result', toolId: tool, status: 'completed', output: 'a.txt' });
  fake.update(id, { activeRun: { id: run, status: 'running', connectionId: 'c' } });
  fake.open(id, run, { type: 'text.delta', messageId: more, text: '正在写第二段' });
  const returned = await watcher(instance, id);
  assert.deepEqual(fake.frames.filter(frame => frame.type === 'session.subscribe').map(frame => frame.afterSequence), [0, 4]);
  await until(() => returned.last().messages.some(message => message.text === '正在写第二段'), 'running output');
  const view = returned.last(), texts = view.messages.map(message => message.text);
  assert.equal(texts.filter(text => text === '第一段').length, 1);
  assert.ok(texts.includes('先看看'));
  assert.ok(texts.some(text => text.startsWith('Status: completed')));
  assert.ok(!texts.some(text => text.includes('正在正在')), 'output from before the gap is not repeated');
  assert.equal(view.permissions.length, 0);
  assert.equal(view.status, 'running');
  assert.notEqual(view.control.token, first.last().control.token, 'a new reader gets a new control token');
});

test('output right behind the page is applied after it, however the socket groups the frames', async t => {
  const fake = await service();
  const id = fake.session(randomUUID(), 'behind', MAC), run = randomUUID(), more = randomUUID(), sent = ['紧跟着', '紧跟着的输出'];
  // A socket may hand over several frames at once; the output then comes before the page is read.
  class Grouped extends CcDeskConnection {
    emit(name, message, ...rest) {
      const result = super.emit(name, message, ...rest);
      if (name === 'message' && message.type === 'session.snapshot')
        super.emit('message', { type: 'session.fragment', sessionId: id, runId: run, payload: { type: 'text.delta', messageId: more, text: sent.shift() } });
      return result;
    }
  }
  const instance = adapter(fake, null, {}, { lingerMs: 20, connection: options => new Grouped(options) });
  t.after(async () => { await instance.stop(); await fake.close(); });
  fake.record(id, run, { type: 'message.user', messageId: randomUUID(), text: '开始' });
  fake.update(id, { activeRun: { id: run, status: 'running', connectionId: 'c' } });
  const first = await watcher(instance, id);
  await until(() => first.last().messages.some(message => message.text === '紧跟着'), 'output after a fresh page');
  first.close();
  await until(() => fake.peers.size === 0, 'reader dropped');
  fake.record(id, run, { type: 'tool.requested', toolId: randomUUID(), name: 'Read', input: '{"file_path":"a.txt"}' });
  const returned = await watcher(instance, id);
  await until(() => returned.last().messages.some(message => message.text === '紧跟着的输出'), 'output after a resumed page');
  assert.equal(returned.last().messages.length, 3);
});

test('following again reads a full page when too much happened, the service lost that point, or it is too long ago', async t => {
  const fake = await service();
  const id = fake.session(randomUUID(), 'fallback', MAC), run = randomUUID();
  const instance = adapter(fake, null, {}, { lingerMs: 20 }), forgetful = adapter(fake, null, {}, { lingerMs: 20, rememberMs: 0 });
  t.after(async () => { await instance.stop(); await forgetful.stop(); await fake.close(); });
  const say = text => fake.record(id, run, { type: 'message.user', messageId: randomUUID(), text });
  const texts = watch => watch.last().messages.map(message => message.text);
  const leave = async watch => { watch.close(); await until(() => fake.peers.size === 0, 'reader dropped'); };
  const after = count => fake.frames.filter(frame => frame.type === 'session.subscribe').slice(-count).map(frame => frame.afterSequence);
  say('一'); say('二');
  await leave(await watcher(instance, id));
  for (let index = 0; index < 8; index++) say(`新${index}`);
  let returned = await watcher(instance, id);
  assert.deepEqual(after(1), [2]);
  assert.deepEqual(texts(returned), ['新2', '新3', '新4', '新5', '新6', '新7'], 'the last page replaces what was remembered');
  assert.ok(returned.last().historyCursor, 'earlier events stay reachable');
  await leave(returned);
  fake.events.set(id, fake.events.get(id).slice(0, 3));
  returned = await watcher(instance, id);
  assert.deepEqual(after(2), [10, 0], 'a point the service does not know is read afresh');
  assert.deepEqual(texts(returned), ['一', '二', '新0']);
  await leave(returned);
  await leave(await watcher(forgetful, id));
  await watcher(forgetful, id);
  assert.deepEqual(after(2), [0, 0], 'an old memory is not used');
});

test('at capacity only the oldest lingering entry is evicted, even after an entry returns and leaves again', async t => {
  const fake = await service();
  const ids = Array.from({ length: 9 }, (_, index) => fake.session(randomUUID(), `capacity-${index}`, MAC));
  const instance = adapter(fake, null);
  t.after(async () => { await instance.stop(); await fake.close(); });
  const watches = [];
  for (const id of ids.slice(0, 8)) watches.push(await watcher(instance, id));
  await assert.rejects(watcher(instance, ids[8]), { code: 'CCDESK_BUSY', statusCode: 429 });
  watches[0].close(); watches[1].close();
  const returned = await watcher(instance, ids[0]);
  returned.close();
  await watcher(instance, ids[8]);
  await until(() => ![...fake.peers].some(peer => peer.subscription === ids[1]), 'oldest linger evicted');
  assert.ok([...fake.peers].some(peer => peer.subscription === ids[0]), 'most recently parked entry survives');
  assert.ok(watches.slice(2).every(watch => !watch.disconnected()), 'active listeners survive');
  const auths = fake.auths;
  const surviving = await watcher(instance, ids[0]);
  assert.equal(fake.auths, auths, 'surviving linger is reused');
  surviving.close();
  await watcher(instance, ids[1]);
  assert.equal(fake.auths, auths + 1, 'evicted session needs a new connection');
});

test('lingering entries reject every write with the previous control token', async t => {
  const fake = await service(), control = await controlSocket(fake.url);
  const id = fake.session(randomUUID(), 'read-only-while-away', MAC);
  const instance = adapter(fake, control);
  t.after(async () => { await instance.stop(); await control.close(); await fake.close(); });
  const watch = await watcher(instance, id), input = op(watch.last());
  assert.equal(watch.last().control.canSend, true);
  watch.close();
  for (const write of [
    () => instance.sendMessage(id, { ...input, text: 'hello', delivery: 'queue' }),
    () => instance.interruptSession(id, input),
    () => instance.respondPermission(id, randomUUID(), { ...input, decision: 'once' }),
    () => instance.respondQuestion(id, randomUUID(), { ...input, answers: [['yes']] }),
  ]) await assert.rejects(write(), { code: 'CCDESK_STALE_CONTROL' });
  assert.equal(control.commands.length, 0);
});

for (const reason of ['stop', 'connection close']) test(`default linger is unreferenced and cleared on ${reason}`, async t => {
  const fake = await service(), connections = [];
  const id = fake.session(randomUUID(), 'cleanup', MAC);
  const instance = adapter(fake, null, {}, { connection: options => {
    const connection = new CcDeskConnection(options); connections.push(connection); return connection;
  } });
  t.after(async () => { await instance.stop(); await fake.close(); });
  const watch = await watcher(instance, id);
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const cleared = t.mock.method(globalThis, 'clearTimeout');
  watch.close();
  const deadlines = scheduled.mock.calls.filter(call => call.arguments[1] === 600_000);
  assert.equal(deadlines.length, 1, 'ten minutes by default');
  const timer = deadlines[0].result;
  assert.equal(timer.hasRef(), false, 'linger cannot keep the process alive');
  watch.close();
  assert.equal(scheduled.mock.calls.filter(call => call.arguments[1] === 600_000).length, 1, 'duplicate cancellation does not extend the deadline');
  if (reason === 'stop') await instance.stop();
  else connections[0].close();
  assert.ok(cleared.mock.calls.some(call => call.arguments[0] === timer), 'the linger timer is cancelled');
  assert.equal(connections[0].closed, true);
  if (reason === 'stop') await assert.rejects(watcher(instance, id), { code: 'CCDESK_STOPPED' });
  else {
    await watcher(instance, id);
    assert.equal(connections.length, 2, 'closed entry cannot be reused');
  }
});

test('config: wss only, CC Desk fingerprints, managed config accepts the section', () => {
  assert.equal(ccDeskConfigSchema.safeParse({ url: 'ws://127.0.0.1:1/ws' }).success, false);
  assert.equal(ccDeskConfigSchema.safeParse({ url: 'wss://user:pass@host/ws' }).success, false);
  assert.equal(ccDeskConfigSchema.safeParse({ url: 'wss://host:8787/ws', fingerprint: fingerprint }).success, true);
  assert.equal(ccDeskConfigSchema.safeParse({ url: 'wss://host:8787/ws', fingerprint: 'nope' }).success, false);
  assert.equal(ccDeskConfigSchema.safeParse({ url: 'wss://host:8787/ws', token: TOKEN }).success, false, 'the token never goes into the config');
  const base = { version: 1, port: 8787, token: 'a'.repeat(40), managerKey: 'b'.repeat(40), codexHome: '/c', workspace: '/w', desktopTransport: 'native' };
  assert.equal(parseManagedConfig({ ...base, ccdesk: { url: 'wss://host:8787/ws', deviceId: MAC } }).ccdesk.deviceId, MAC);
});

test('defaults come from CC Desk settings without its token', async () => {
  const file = path.join(scratch, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ deviceId: MAC, login: { url: 'wss://h:1/ws', fingerprint: fingerprint, token: 'SECRET-TOKEN', mode: 'remote' } }));
  const defaults = await ccDeskDefaults(file);
  assert.deepEqual(defaults, { url: 'wss://h:1/ws', fingerprint, deviceId: MAC });
  assert.ok(!JSON.stringify(defaults).includes('SECRET'));
});

test('probe, list and capabilities follow the service and the socket', async () => {
  const fake = await service();
  fake.session(randomUUID(), 'older', MAC); await sleep(5);
  const laptop = fake.session(randomUUID(), 'windows-work', LAPTOP); await sleep(5);
  const newest = fake.session(randomUUID(), 'newest', MAC);
  const readOnly = adapter(fake, null);
  const status = await readOnly.probe();
  assert.equal(status.state, 'connected'); assert.deepEqual(status.loadedSessions, { count: 3, hasMore: false });
  assert.equal(status.capabilities.inspectLoadedSessions, true); assert.equal(status.capabilities.sendMessage, false);
  const { sessions } = await readOnly.listSessions();
  assert.deepEqual(sessions.map(s => s.id).slice(0, 1), [newest]);
  assert.match(sessions.find(s => s.id === laptop).title, /（LAPTOP）$/);
  assert.equal((await readOnly.listSessions('windows')).sessions.length, 1);
  await assert.rejects(readOnly.listSessions('', 'x'), { code: 'CCDESK_CURSOR_UNSUPPORTED' });
  const control = await controlSocket(fake.url);
  const writable = adapter(fake, control);
  assert.equal(fake.deviceFrames, 0, 'without the window to copy, the gateway does not say it is a computer');
  assert.equal((await writable.probe()).capabilities.sendMessage, true);
  const signIns = fake.frames.filter(frame => frame.type === 'auth').map(frame => frame.deviceName);
  assert.equal(signIns.at(-1), 'Mac', 'with the window, it signs in under the window\'s own name');
  assert.deepEqual([fake.renames, fake.leaves], [0, 0]);
  await readOnly.stop(); await writable.stop(); await control.close(); await fake.close();
});

test('connection failures: token, protocol, certificate (no token sent), missing keychain item', async () => {
  const fake = await service();
  const wrong = new CcDeskAdapter(ccDeskConfigSchema.parse({ url: fake.url, fingerprint }), { readToken: async () => 'w'.repeat(40) });
  assert.equal((await wrong.probe()).errorCode, 'CCDESK_AUTH_FAILED');
  const auths = fake.auths;
  const pinned = new CcDeskAdapter(ccDeskConfigSchema.parse({ url: fake.url, fingerprint: 'AB'.repeat(32) }), { readToken: async () => TOKEN });
  assert.equal((await pinned.probe()).errorCode, 'CCDESK_CERT_MISMATCH');
  assert.equal(fake.auths, auths, 'no auth frame reached a service with the wrong certificate');
  const unpinned = new CcDeskAdapter(ccDeskConfigSchema.parse({ url: fake.url }), { readToken: async () => TOKEN });
  assert.equal((await unpinned.probe()).errorCode, 'CCDESK_CERT_MISMATCH', 'a self-signed service without a fingerprint is refused');
  const missing = new CcDeskAdapter(ccDeskConfigSchema.parse({ url: fake.url, fingerprint }), { readToken: async () => { throw Object.assign(new Error('x'), { code: 'CCDESK_TOKEN_MISSING' }); } });
  assert.equal((await missing.probe()).errorCode, 'CCDESK_TOKEN_MISSING');
  await fake.close();
  const newer = await service({ protocol: 25 });
  const old = new CcDeskAdapter(ccDeskConfigSchema.parse({ url: newer.url, fingerprint }), { readToken: async () => TOKEN });
  assert.equal((await old.probe()).errorCode, 'CCDESK_PROTOCOL_UNSUPPORTED');
  await newer.close();
});

test('a followed session: history page, streaming without duplicates, tools, final answer, last turn', async () => {
  const fake = await service();
  const id = fake.session(randomUUID(), 'work', MAC), run1 = randomUUID();
  const message1 = randomUUID(), reply1 = randomUUID();
  fake.record(id, run1, { type: 'message.user', messageId: message1, text: '第一句', scenario: 'chat' });
  fake.record(id, run1, { type: 'run.status', status: 'running', connectionId: 'c' });
  fake.record(id, run1, { type: 'text.delta', messageId: reply1, text: '你好' });
  fake.record(id, run1, { type: 'run.status', status: 'completed', connectionId: 'c' });
  const instance = adapter(fake, null);
  const watch = await watcher(instance, id);
  let snapshot = watch.last();
  assert.deepEqual(snapshot.messages.map(m => [m.kind, m.text]), [['user_message', '第一句'], ['agent_message', '你好']]);
  assert.equal(snapshot.messages[1].phase, 'final_answer'); assert.equal(snapshot.lastTurn.status, 'completed');
  assert.equal(snapshot.status, 'idle'); assert.equal(snapshot.historyCursor, null);

  const run2 = randomUUID(), reply2 = randomUUID(), tool = 'toolu_1';
  fake.update(id, { activeRun: { id: run2, status: 'running', connectionId: 'c' } });
  fake.record(id, run2, { type: 'message.user', messageId: randomUUID(), text: '列一下文件', scenario: 'chat' });
  fake.record(id, run2, { type: 'tool.requested', toolId: tool, name: 'Bash', input: JSON.stringify({ command: 'ls -la' }), target: 'Linux' });
  fake.fragment(id, run2, { type: 'tool.output', toolId: tool, stream: 'stdout', text: 'a.txt\n' });
  fake.record(id, run2, { type: 'tool.result', toolId: tool, status: 'completed', output: 'a.txt\nb.txt\n', exitCode: 0 });
  fake.fragment(id, run2, { type: 'text.delta', messageId: reply2, text: '有两个' });
  fake.fragment(id, run2, { type: 'text.delta', messageId: reply2, text: '文件' });
  await until(() => watch.last().messages.some(m => m.text === '有两个文件'), 'live text');
  snapshot = watch.last();
  assert.equal(snapshot.status, 'running'); assert.equal(snapshot.activeTurnId, run2); assert.equal(snapshot.activity, 'outputting');
  const call = snapshot.messages.find(m => m.kind === 'function_call');
  assert.equal(call.text, 'Tool: Bash\nCommand: ls -la');
  assert.match(snapshot.messages.find(m => m.kind === 'function_call_output').text, /Status: completed\na\.txt\nb\.txt/);
  fake.record(id, run2, { type: 'text.delta', messageId: reply2, text: '有两个文件' });
  fake.fragment(id, run2, { type: 'text.delta', messageId: reply2, text: '。' });
  await until(() => watch.last().messages.some(m => m.text === '有两个文件。'), 'recorded plus new fragment');
  fake.record(id, run2, { type: 'text.delta', messageId: reply2, text: '。' });
  fake.record(id, run2, { type: 'run.status', status: 'completed', connectionId: 'c' });
  fake.update(id, { activeRun: null });
  await until(() => watch.last().status === 'idle', 'run ended');
  snapshot = watch.last();
  assert.equal(snapshot.messages.find(m => m.id === `a:${reply2}`).text, '有两个文件。', 'recorded text replaces its fragments exactly once');
  assert.equal(snapshot.messages.find(m => m.id === `a:${reply2}`).phase, 'final_answer');
  assert.equal(snapshot.historyCursor, null, 'everything was loaded when the session was opened');
  watch.close(); await instance.stop();

  const later = adapter(fake, null);
  const reopened = await watcher(later, id);
  snapshot = reopened.last();
  assert.equal(snapshot.historyCursor, String(fake.events.get(id).at(-6).sequence), 'older events are behind the cursor');
  assert.ok(!snapshot.messages.some(m => m.text === '第一句'));
  assert.equal(snapshot.messages.find(m => m.id === `a:${reply2}`).text, '有两个文件。');
  const page = await later.readHistory(id, snapshot.historyCursor);
  assert.deepEqual(page.messages.map(m => m.text), ['第一句', '你好']);
  assert.equal(page.cursor, null);
  await assert.rejects(later.readHistory(id, 'abc'), { code: 'CCDESK_INPUT_INVALID' });
  reopened.close(); await later.stop(); await fake.close();
});

test('writes: send, confirm, interrupt, approvals and questions go through the socket', async () => {
  const fake = await service();
  const id = fake.session(randomUUID(), 'work', MAC);
  const control = await controlSocket(fake.url);
  const instance = adapter(fake, control);
  const watch = await watcher(instance, id);
  let snapshot = watch.last();
  assert.deepEqual([snapshot.control.canSend, snapshot.control.canInterrupt], [true, false]);
  const send = op(snapshot);
  const delivery = await instance.sendMessage(id, { ...send, text: '手机发的', delivery: 'queue' });
  assert.equal(delivery.delivery, 'submitted');
  assert.deepEqual(control.commands.at(-1), { type: 'message.send', sessionId: id, text: '手机发的', requestId: send.clientMessageId });
  const run = randomUUID();
  fake.record(id, run, { type: 'message.user', messageId: send.clientMessageId, text: '手机发的', scenario: 'chat' });
  fake.record(id, run, { type: 'run.status', status: 'running', connectionId: 'c' });
  await until(() => watch.last().submission?.delivery === 'confirmed' && watch.last().status === 'running', 'confirmed');
  snapshot = watch.last();
  assert.deepEqual([snapshot.control.canSteer, snapshot.control.canInterrupt], [true, true]);

  fake.record(id, run, { type: 'tool.requested', toolId: 't1', name: 'Bash', input: JSON.stringify({ command: 'rm -rf build' }), target: 'Linux' });
  const approvalId = randomUUID();
  fake.record(id, run, { type: 'approval.requested', approvalId, toolId: 't1' });
  await until(() => watch.last().permissions.length === 1, 'permission card');
  const permission = watch.last().permissions[0];
  assert.deepEqual([permission.id, permission.action, permission.decisions, permission.unavailableReason], [approvalId, 'Bash', ['once', 'reject'], null]);
  assert.match(permission.detail, /Command: rm -rf build/);
  await assert.rejects(instance.respondPermission(id, approvalId, { ...op(watch.last()), decision: 'always' }), { code: 'CCDESK_DECISION_UNAVAILABLE' });
  const allow = op(watch.last());
  await instance.respondPermission(id, approvalId, { ...allow, decision: 'once' });
  assert.deepEqual(control.commands.at(-1), { type: 'approval.reply', requestId: allow.clientMessageId, sessionId: id, runId: run, approvalId, allowed: true });
  await until(() => watch.last().permissions[0]?.status === 'submitted', 'submitted');
  fake.record(id, run, { type: 'approval.resolved', approvalId, allowed: true });
  await until(() => !watch.last().permissions.length, 'resolved');

  const questionId = randomUUID();
  fake.record(id, run, { type: 'tool.requested', toolId: 't2', name: 'AskUserQuestion', target: 'Linux',
    input: JSON.stringify({ questions: [{ question: '用哪种方案？', header: '方案', multiSelect: false, options: [{ label: 'A', description: '快' }, { label: 'B', description: '稳' }] },
      { question: '要哪些检查？', header: '检查', multiSelect: true, options: [{ label: '测试', description: '' }, { label: '构建', description: '' }] }] }) });
  fake.record(id, run, { type: 'approval.requested', approvalId: questionId, toolId: 't2' });
  await until(() => watch.last().questions.length === 1, 'question card');
  const question = watch.last().questions[0];
  assert.deepEqual(question.questions.map(q => [q.question, q.multiple, q.options.map(o => o.label)]), [['用哪种方案？', false, ['A', 'B']], ['要哪些检查？', true, ['测试', '构建']]]);
  await assert.rejects(instance.respondQuestion(id, questionId, { ...op(watch.last()), answers: [['A', 'B'], ['测试']] }), { code: 'CCDESK_INVALID_ANSWER' });
  const answer = op(watch.last());
  await instance.respondQuestion(id, questionId, { ...answer, answers: [['B'], ['测试', '构建']] });
  assert.deepEqual(control.commands.at(-1), { type: 'approval.reply', requestId: answer.clientMessageId, sessionId: id, runId: run, approvalId: questionId, allowed: true,
    answers: { '用哪种方案？': 'B', '要哪些检查？': '测试, 构建' } });

  const stop = op(watch.last());
  await instance.interruptSession(id, stop);
  assert.deepEqual(control.commands.at(-1), { type: 'run.cancel', sessionId: id, runId: run, requestId: stop.clientMessageId });
  fake.record(id, run, { type: 'run.status', status: 'cancelled', connectionId: 'c' });
  await until(() => watch.last().submission?.action === 'interrupt' && watch.last().submission.delivery === 'confirmed', 'interrupt confirmed');
  assert.equal(watch.last().lastTurn.status, 'interrupted');
  await assert.rejects(instance.sendMessage(id, { controlToken: randomUUID(), clientMessageId: randomUUID(), text: 'x', delivery: 'queue' }), { code: 'CCDESK_STALE_CONTROL' });
  assert.deepEqual([fake.renames, fake.leaves], [0, 0], 'no session renamed, no runs ended by a leave');
  watch.close(); await instance.stop(); await control.close(); await fake.close();
});

test('read only: another computer, no socket, a rejected or lost relay', async () => {
  const fake = await service();
  const laptop = fake.session(randomUUID(), 'windows', LAPTOP), mine = fake.session(randomUUID(), 'mine', MAC);
  const control = await controlSocket(fake.url, { answer: command => command.text === 'lost' ? { error: { code: 'timeout', message: 'x' } } : command.text === 'busy' ? { ok: false, code: 'run_active', message: 'x' } : { ok: true } });
  const instance = adapter(fake, control);
  const other = await watcher(instance, laptop);
  assert.deepEqual([other.last().control.canSend, other.last().control.canInterrupt], [false, false]);
  await assert.rejects(instance.sendMessage(laptop, { ...op(other.last()), text: 'x', delivery: 'queue' }), { code: 'CCDESK_OTHER_DEVICE' });
  const watch = await watcher(instance, mine);
  await assert.rejects(instance.sendMessage(mine, { ...op(watch.last()), text: 'busy', delivery: 'queue' }), { code: 'CCDESK_RUN_ACTIVE' });
  await until(() => watch.last().operationError?.code === 'rejected', 'rejected shown');
  const lost = await instance.sendMessage(mine, { ...op(watch.last()), text: 'lost', delivery: 'queue' });
  assert.equal(lost.delivery, 'uncertain');
  watch.close(); other.close(); await instance.stop(); await control.close();

  const fresh = adapter(fake, null);
  const runId = randomUUID(), approvalId = randomUUID();
  fake.update(mine, { activeRun: { id: runId, status: 'awaiting_approval', connectionId: 'c' } });
  fake.record(mine, runId, { type: 'tool.requested', toolId: 't', name: 'Write', input: JSON.stringify({ file_path: '/work/mine/a.txt' }), target: 'Linux' });
  fake.record(mine, runId, { type: 'approval.requested', approvalId, toolId: 't' });
  const readOnly = await watcher(fresh, mine);
  assert.match(readOnly.last().permissions[0].unavailableReason, /没有开启手机控制/);
  assert.equal(readOnly.last().control.canSend, false);
  await assert.rejects(fresh.respondPermission(mine, approvalId, { ...op(readOnly.last()), decision: 'once' }), { code: 'CCDESK_CONTROL_UNAVAILABLE' });
  readOnly.close(); await fresh.stop(); await fake.close();
});

test('a stop whose answer was lost is settled by however the run ends; long sessions keep the last 240 messages', async () => {
  const fake = await service();
  const id = fake.session(randomUUID(), 'work', MAC), run = randomUUID();
  fake.update(id, { activeRun: { id: run, status: 'running', connectionId: 'c' } });
  for (let index = 0; index < 130; index++) {
    fake.record(id, run, { type: 'message.user', messageId: randomUUID(), text: `第 ${index} 句`, scenario: 'chat' });
    fake.record(id, run, { type: 'text.delta', messageId: randomUUID(), text: `回复 ${index}` });
  }
  const control = await controlSocket(fake.url, { answer: command => command.type === 'run.cancel' ? { error: { code: 'timeout', message: 'x' } } : { ok: true } });
  const instance = adapter(fake, control);
  const watch = await watcher(instance, id);
  assert.equal(watch.last().messages.length, 6, 'the service sends the latest page');
  for (let index = 0; index < 250; index++) fake.record(id, run, { type: 'text.delta', messageId: randomUUID(), text: `更多 ${index}` });
  await until(() => watch.last().messages.at(-1)?.text === '更多 249', 'live events');
  assert.equal(watch.last().messages.length, 240);
  assert.equal(watch.last().historyCursor, String(fake.events.get(id).at(-240).sequence));
  const stop = await instance.interruptSession(id, op(watch.last()));
  assert.equal(stop.delivery, 'uncertain');
  await until(() => watch.last().submission?.delivery === 'uncertain', 'uncertain shown');
  fake.record(id, run, { type: 'run.status', status: 'completed', connectionId: 'c' });
  fake.update(id, { activeRun: null });
  await until(() => watch.last().submission?.delivery === 'confirmed' && watch.last().status === 'idle', 'settled');
  assert.equal(watch.last().control.canSend, true);
  watch.close(); await instance.stop(); await control.close(); await fake.close();
});

test('a service that shows each computer its own sessions: read as the window, go when it goes', async () => {
  const fake = await service({ visibility: 'device' });
  const mine = fake.session(randomUUID(), 'mine', MAC); await sleep(5);
  fake.session(randomUUID(), 'also-mine', MAC);
  fake.session(randomUUID(), 'windows', LAPTOP);
  const blind = adapter(fake, null);
  await assert.rejects(blind.listSessions(), { code: 'CCDESK_CONTROL_UNAVAILABLE' }, 'without the window nothing is visible, and the phone is told why');
  await assert.rejects(blind.watchSession(mine, () => {}, () => {}), { code: 'CCDESK_CONTROL_UNAVAILABLE' });
  await blind.stop();

  const control = await controlSocket(fake.url);
  const instance = adapter(fake, control);
  assert.deepEqual((await instance.probe()).loadedSessions, { count: 2, hasMore: false });
  assert.deepEqual((await instance.listSessions()).sessions.map(s => s.title).sort(), ['also-mine', 'mine']);
  const watch = await watcher(instance, mine);
  assert.equal(watch.last().control.canSend, true);
  const run = randomUUID();
  fake.record(mine, run, { type: 'message.user', messageId: randomUUID(), text: '看得到', scenario: 'chat' });
  await until(() => watch.last().messages.some(m => m.text === '看得到'), 'live event');
  assert.deepEqual([fake.renames, fake.leaves], [0, 0], 'the service renamed nothing; no leave');
  assert.ok(fake.frames.filter(frame => frame.type === 'device').every(frame => frame.id === MAC && !('platform' in frame)), 'the device frame is the window\'s, as it sent it');

  control.push({ connected: false, writable: false, controlVersion: 1 });
  await until(() => watch.disconnected(), 'the reader goes with the window');
  await until(() => ![...fake.peers].some(peer => peer.device), 'no connection is left holding the computer');
  assert.equal(fake.leaves, 0);
  await instance.stop(); await control.close(); await fake.close();
});

test('the socket client picks the live description of the same service', async () => {
  const control = await controlSocket('wss://example.test:8787/ws');
  fs.writeFileSync(path.join(control.directory, 'stale.json'), JSON.stringify({ service: 'wss://example.test:8787/ws', socket: path.join(control.directory, 'gone.sock'), pid: 99999999, controlVersion: 1 }));
  const other = new CcDeskControl({ service: 'wss://elsewhere.test/ws', directory: control.directory });
  await other.refresh(); assert.equal(other.writable, false); other.stop();
  const same = new CcDeskControl({ service: 'wss://example.test:8787/ws/', directory: control.directory });
  await same.refresh(); assert.equal(same.writable, true);
  same.stop(); await control.close();
});
