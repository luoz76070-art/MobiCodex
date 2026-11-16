import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { seedSyntheticStorage, syntheticApiResponse, syntheticData, startSyntheticServer } from './helpers/synthetic-app.mjs';

// No browser process, real Relay, native bridge or personal browser profile.
const origin = 'http://synthetic.invalid';
const response = (route, method = 'GET') => syntheticApiResponse(new URL(route, origin), method);
const scope = `screens:synthetic:${origin}`;
function storageFixture(initial) {
  const values = new Map();
  const localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  const seed = () => vm.runInNewContext(`(${seedSyntheticStorage.toString()})(${JSON.stringify({ ...syntheticData, origin, theme: 'light', initial })})`, { localStorage, location: { origin } });
  return { values, seed };
}

test('clean startup seeds only a synthetic connection, without legacy/navigation/session state', () => {
  const f = storageFixture('picker');
  assert.equal(f.values.size, 0);
  f.seed();
  assert.equal(f.values.has('productRemoteMode'), false);
  assert.equal([...f.values.keys()].some(key => /Navigation|Workspace|AgentView/u.test(key)), false);
  const [profile] = JSON.parse(f.values.get('connectionProfiles'));
  assert.equal(profile.endpoint, origin);
  assert.equal(profile.token, syntheticData.credential);
});

test('reload preserves the app-written scoped navigation, drafts and changed preferences', () => {
  const f = storageFixture('picker'); f.seed();
  f.values.set(`mobileCodexNavigationV1:${scope}`, JSON.stringify({ version: 1, level: 'session', agentId: 'claude', sessionId: syntheticData.sessionId }));
  f.values.set('synthetic-draft', 'keep my draft');
  f.values.set('themeMode', 'dark');
  const before = [...f.values];
  f.seed();
  assert.deepEqual([...f.values], before);
});

test('README seed retains the original Codex conversation, theme and legacy migration path', () => {
  const f = storageFixture('codex-session'); f.seed();
  assert.equal(f.values.get('productRemoteMode'), 'codex');
  assert.equal(f.values.get('themeMode'), 'light');
  assert.deepEqual(JSON.parse(f.values.get(`mobileCodexWorkspaceV1:${scope}`)), {
    threads: syntheticData.threads, selectedId: syntheticData.threadId, isNewThread: false,
  });
  const before = [...f.values]; f.seed(); assert.deepEqual([...f.values], before);
});

test('CC Desk sessions, snapshot, stream token and attention key share the exact same target', () => {
  const session = response('/api/agents/ccdesk/sessions').sessions[0];
  const snapshot = response(`/api/agents/ccdesk/sessions/${session.id}`);
  assert.equal(snapshot.agentId, 'ccdesk');
  assert.equal(snapshot.connected, true);
  assert.deepEqual(snapshot.session, session);
  const item = response('/api/attention').items[0];
  assert.equal(item.key, `agent:ccdesk:${session.id}`);
  assert.equal(syntheticData.attentionNotification.title, session.title);
  assert.ok(Array.isArray(item.requests));
  assert.deepEqual(response(`/api/agents/ccdesk/sessions/${session.id}/stream-token`, 'POST'), { streamToken: syntheticData.credential });
});

test('unmodeled requests and write operations fail rather than reaching a real backend', () => {
  for (const [route, method] of [['/api/missing', 'GET'], ['/api/agents/claude/sessions/missing/stream-token', 'POST'], ['/api/work-items', 'POST']]) {
    assert.throws(() => response(route, method));
  }
});

test('static server serves built assets and keeps all modeled SSE streams alive with real event data', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'synthetic-app-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  await writeFile(path.join(temp, 'index.html'), '<main>synthetic</main>');
  await mkdir(path.join(temp, 'assets'));
  await writeFile(path.join(temp, 'assets', 'test.js'), '/* synthetic */');
  const server = await startSyntheticServer({ distDirectory: temp });
  t.after(() => server.close());
  assert.equal(await (await fetch(server.origin)).text(), '<main>synthetic</main>');
  assert.match((await fetch(`${server.origin}/assets/test.js`)).headers.get('content-type'), /javascript/u);
  for (const [kind, event, identity] of [
    ['desktop', 'desktop', syntheticData.threadId], ['approval', 'agent-session', syntheticData.sessionId],
    ['ccdesk', 'agent-session', syntheticData.ccdesk.session.id], ['work-items', 'ping', syntheticData.now],
  ]) {
    const controller = new AbortController();
    try {
      const result = await fetch(`${server.origin}/__screens/events/${kind}`, { signal: controller.signal });
      assert.equal(result.headers.get('content-type'), 'text/event-stream');
      const reader = result.body.getReader();
      let text = '';
      while (!text.includes('event: ping')) {
        const { value, done } = await reader.read();
        assert.equal(done, false);
        text += new TextDecoder().decode(value);
      }
      assert.ok(text.includes(`event: ${event}`));
      assert.ok(text.includes(identity));
      assert.equal(server.opened.get(kind), 1);
    } finally { controller.abort(); }
  }
  assert.deepEqual(server.errors, []);
});
