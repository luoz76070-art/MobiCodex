import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { navigationModel as m, memoryStorage, withStorage, appNavigationFixture, findElement as find } from './helpers/mobile-navigation-fixture.mjs';

for (const id of ['codex', 'claude', 'deepseek', 'ccdesk']) {
  test(`${id}: back follows only its own branch, one step per event`, () => {
    const f = appNavigationFixture(m.agentSession(id, 'conversation'));
    try {
      const workspace = id === 'codex' ? 'Workspace' : 'AgentWorkspace';
      if (id !== 'codex') find(f.render(), workspace).props.onBack();
      else f.back();
      if (id === 'codex') assert.ok(find(f.render(), 'Picker'));
      else {
        const list = find(f.render(), workspace); assert.equal(list.props.navigation.level, 'agent');
        assert.equal(list.props.navigation.agentId, id); assert.equal(list.props.navigation.sessionId, null);
        assert.equal(find(f.render(), 'Picker'), undefined);
        list.props.onBack(); assert.ok(find(f.render(), 'Picker'));
      }
      assert.equal(f.back().defaultPrevented, false, 'root leaves back to the system');
    } finally { f.stop(); }
  });
  test(`${id}: a settings layer closes without moving the active session`, () => {
    const f = appNavigationFixture(m.agentSession(id, 'conversation'));
    try {
      const type = id === 'codex' ? 'Workspace' : 'AgentWorkspace';
      find(f.render(), type).props.onOpenSettings(); f.render();
      assert.equal(f.back().defaultPrevented, true);
      assert.equal(find(f.render(), 'Settings').props.settingsOpen, false);
      assert.equal(find(f.render(), type).props.navigation.sessionId, 'conversation');
    } finally { f.stop(); }
  });
  test(`${id}: failed save or an active upload consumes back and prevents switch`, () => {
    for (const reason of ['save-failed', 'uploading']) {
      const f = appNavigationFixture(m.agentSession(id, 'conversation'));
      let attempts = 0;
      const protect = event => { attempts++; event.preventDefault(); };
      f.events.addEventListener('product-before-navigate', protect);
      try {
        const type = id === 'codex' ? 'Workspace' : 'AgentWorkspace';
        assert.equal(f.back().defaultPrevented, true, reason);
        assert.equal(find(f.render(), type).props.navigation.sessionId, 'conversation');
        assert.equal(attempts, 1, 'one flush per back');
        find(f.render(), type).props.onOpenAgents();
        assert.equal(find(f.render(), type).props.navigation.sessionId, 'conversation');
        f.events.removeEventListener('product-before-navigate', protect);
        f.back(); assert.notEqual(find(f.render(), type)?.props.navigation.sessionId, 'conversation');
      } finally { f.stop(); }
    }
  });
}

test('layers dismiss in paint order, then drawer, then navigation; consumed events cannot fall through', () => {
  const f = appNavigationFixture(m.agentSession('claude', 'conversation'));
  try {
    const layers = f.render().props.value, closed = [];
    const removeDrawer = layers.add(38, () => { closed.push('drawer'); removeDrawer(); });
    const removeShare = layers.add(220, () => { closed.push('share'); removeShare(); });
    const removeImage = layers.add(1000, () => { closed.push('image'); removeImage(); });
    let lowerListener = 0; f.events.addEventListener('product-back', () => { lowerListener++; });
    f.back(); assert.deepEqual(closed, ['image']); assert.equal(find(f.render(), 'AgentWorkspace').props.navigation.level, 'session');
    f.back(); assert.deepEqual(closed, ['image', 'share']);
    f.back(); assert.deepEqual(closed, ['image', 'share', 'drawer']);
    f.back(); assert.equal(find(f.render(), 'AgentWorkspace').props.navigation.level, 'agent');
    assert.equal(lowerListener, 0);
    f.back(); f.back(); assert.equal(lowerListener, 1, 'root propagates');
  } finally { f.stop(); }
});
test('latest equal-height layer wins; unmounted layers do not intercept back', () => {
  const layers = m.createBackLayers(), closed = [];
  const first = layers.add(50, () => closed.push('first'));
  const last = layers.add(50, () => closed.push('last'));
  layers.dismiss(); assert.deepEqual(closed, ['last']); last(); layers.dismiss(); assert.deepEqual(closed, ['last', 'first']); first();
  assert.equal(layers.dismiss(), false);
});
test('root with a sheet dismisses just the sheet; bare root does not even flush workspace state', () => {
  const f = appNavigationFixture(); let flushes = 0;
  f.events.addEventListener('product-before-navigate', () => { flushes++; });
  try {
    find(f.render(), 'Picker').props.onOpenItems(); f.render();
    find(f.render(), 'Items').props.onNew(); f.render();
    f.back(); assert.equal(find(f.render(), 'Capture').props.open, false); assert.equal(find(f.render(), 'Items').props.open, true);
    f.back(); assert.equal(find(f.render(), 'Items').props.open, false); assert.ok(find(f.render(), 'Picker'));
    assert.equal(f.back().defaultPrevented, false); assert.equal(flushes, 0);
  } finally { f.stop(); }
});
test('picker chooses Codex through the same route callback as all other Agents', () => {
  for (const agentId of ['codex', 'claude', 'deepseek', 'ccdesk']) {
    const f = appNavigationFixture();
    try {
      find(f.render(), 'Picker').props.onSelect(agentId);
      const workspace = find(f.render(), agentId === 'codex' ? 'Workspace' : 'AgentWorkspace');
      assert.deepEqual(workspace.props.navigation, m.agentList(agentId));
    } finally { f.stop(); }
  }
});
test('legacy views migrate into versioned, scoped navigation without writing legacy keys or removing drafts', () => {
  for (const [mode, view, cache, expected] of [
    ['agent', { agentId: 'ccdesk', sessionId: 'session' }, {}, m.agentSession('ccdesk', 'session')],
    ['agent', { agentId: 'claude', sessionId: null }, {}, m.agentList('claude')],
    ['codex', {}, { threads: [{ id: 'old', threadName: '合成线程' }], selectedId: 'old' }, m.agentSession('codex', 'old')],
    ['codex', {}, { isNewThread: true }, m.agentSession('codex', '__new_thread__')],
    ['codex', {}, {}, m.agentList('codex')],
    ['agent', { agentId: '../invalid', sessionId: 'x' }, {}, m.agentPicker()],
    ['unknown', {}, {}, m.agentPicker()],
  ]) {
    const entries = [['productRemoteMode', mode], ['mobileCodexAgentViewV1:test:fixed:', JSON.stringify(view)], ['mobileCodexWorkspaceV1:test:fixed:', JSON.stringify(cache)], ['synthetic-draft', 'keep me']];
    const f = appNavigationFixture(null, entries);
    try {
      assert.deepEqual(JSON.parse(f.storage.get(`mobileCodexNavigationV1:${f.scope}`)), expected);
      for (const [key, value] of entries) assert.equal(f.storage.get(key), value);
    } finally { f.stop(); }
  }
});
test('valid scoped navigation overrides old keys; invalid records and versions go to the root', () => {
  const storage = memoryStorage([['productRemoteMode', 'codex']]);
  withStorage(storage, () => {
    m.saveNavigation('one', m.agentSession('deepseek', 'first')); m.saveNavigation('two', m.agentList('ccdesk'));
    assert.deepEqual(m.loadNavigation('one'), m.agentSession('deepseek', 'first'));
    assert.deepEqual(m.loadNavigation('two'), m.agentList('ccdesk'));
    assert.deepEqual(m.loadNavigation('new-scope', false), m.agentPicker());
    for (const bad of ['{', JSON.stringify({ version: 2, level: 'session', agentId: 'codex', sessionId: 'x' }), JSON.stringify({ version: 1, level: 'session', agentId: 'ccdesk', sessionId: '' })]) {
      storage.setItem('mobileCodexNavigationV1:bad', bad); assert.deepEqual(m.loadNavigation('bad'), m.agentPicker());
    }
  });
});
test('#42 a fresh WebView is a cold start; a reload in the same process continues it', () => {
  const session = memoryStorage();
  assert.equal(m.continuesLaunch(session), false, 'first load after opening the app');
  assert.equal(m.continuesLaunch(session), true, 'hot update or refresh keeps sessionStorage');
  assert.equal(m.continuesLaunch({ getItem() { throw new Error('blocked'); }, setItem() {} }), false);
  assert.equal(m.continuesLaunch(), false, 'no sessionStorage counts as a cold start');
  withStorage(memoryStorage(), () => {
    m.saveNavigation('one', m.agentSession('deepseek', 'first'));
    assert.deepEqual(m.initialNavigation('one', false), m.agentPicker());
    assert.deepEqual(m.initialNavigation('one', true), m.agentSession('deepseek', 'first'));
  });
});
test('#42 cold start shows the picker and keeps cached Codex state and drafts', t => {
  const cache = ['mobileCodexWorkspaceV1:test:fixed:', JSON.stringify({ threads: [{ id: 'old', threadName: '合成线程' }], selectedId: 'old' })];
  const draft = ['synthetic-draft', 'keep me'];
  const f = appNavigationFixture(m.agentSession('claude', 'previous'), [cache, draft], { coldStart: true }); t.after(() => f.stop());
  assert.ok(find(f.render(), 'Picker'));
  assert.equal(find(f.render(), 'AgentWorkspace'), undefined);
  assert.equal(f.storage.get(cache[0]), cache[1]);
  assert.equal(f.storage.get(draft[0]), draft[1]);
  find(f.render(), 'Picker').props.onSelect('codex'); f.render();
  assert.equal(find(f.render(), 'Workspace').props.navigation.agentId, 'codex');
});
for (const [name, options, expected] of [
  ['notification', { coldNotification: { agentId: 'ccdesk', sessionId: 'notified', title: '合成提醒' } }, m.agentSession('ccdesk', 'notified')],
  ['thread shortcut', { coldShortcut: { target: 'thread', key: 'agent:deepseek:recent' } }, m.agentSession('deepseek', 'recent')],
]) {
  test(`#42 a cold start from a ${name} still goes straight to its target`, async t => {
    const f = appNavigationFixture(m.agentSession('claude', 'previous'), [], { coldStart: true, ...options }); t.after(() => f.stop());
    await f.settle();
    assert.deepEqual(find(f.render(), 'AgentWorkspace').props.navigation, expected);
  });
}
test('connection changes restore each scope before rendering, never persist the outgoing page to the incoming scope', () => {
  const f = appNavigationFixture(m.agentSession('claude', 'original'));
  const next = { id: 'second', cacheNamespace: 'fixed', endpoint: '', token: '', name: '另一合成连接' };
  f.storage.set('mobileCodexNavigationV1:second:fixed:', JSON.stringify(m.agentList('ccdesk')));
  try {
    const originalWorkspace = find(f.render(), 'AgentWorkspace');
    find(f.render(), 'Settings').props.onApply(next); f.render();
    assert.deepEqual(find(f.render(), 'AgentWorkspace').props.navigation, m.agentList('ccdesk'));
    originalWorkspace.props.onOpenAgents(); assert.deepEqual(find(f.render(), 'AgentWorkspace').props.navigation, m.agentList('ccdesk'), 'stale callbacks cannot navigate another connection');
    find(f.render(), 'Settings').props.onApply({ ...next, id: 'third' }); f.render(); assert.ok(find(f.render(), 'Picker'));
    find(f.render(), 'Settings').props.onApply({ ...next, id: 'test' }); f.render();
    assert.deepEqual(find(f.render(), 'AgentWorkspace').props.navigation, m.agentSession('claude', 'original'));
  } finally { f.stop(); }
});
test('all external destinations use the unified entry path, including CC Desk thread shortcuts', async t => {
  const f = appNavigationFixture(m.agentSession('claude', 'previous')); t.after(() => f.stop());
  f.notify({ agentId: 'ccdesk', sessionId: 'notified', title: '合成提醒' }); await f.settle();
  assert.deepEqual(find(f.render(), 'AgentWorkspace').props.navigation, m.agentSession('ccdesk', 'notified'));
  find(f.render(), 'Capture').props.onOpenTarget({ agentId: 'deepseek', sessionId: 'handed-off', title: '', cwd: '' }); await f.settle();
  assert.deepEqual(find(f.render(), 'AgentWorkspace').props.navigation, m.agentSession('deepseek', 'handed-off'));
  f.intake.onShortcut({ target: 'thread', key: 'agent:ccdesk:thread' }); await f.settle();
  assert.deepEqual(find(f.render(), 'AgentWorkspace').props.navigation, m.agentSession('ccdesk', 'thread'));
  f.intake.onShortcut({ target: 'thread', key: 'desktop:test' }); await f.settle();
  assert.deepEqual(find(f.render(), 'Workspace').props.navigation, m.agentSession('codex', 'test'));
});
test('a delayed external target cannot move a different connection or a manually changed page', async t => {
  let finish;
  const f = appNavigationFixture(m.agentSession('claude', 'original'), [], { readAgents: () => new Promise(resolve => { finish = resolve; }) });
  t.after(() => f.stop());
  f.notify({ agentId: 'ccdesk', sessionId: 'late', title: '' }); f.render();
  find(f.render(), 'AgentWorkspace').props.onOpenAgents(); f.render();
  finish({ agents: [{ id: 'ccdesk', sessionApi: 1 }] }); await f.settle();
  assert.ok(find(f.render(), 'Picker')); assert.match(find(f.render(), 'Notice').props.children[0], /页面已变化/);
  f.retry();
  find(f.render(), 'Settings').props.onApply({ id: 'second', cacheNamespace: 'fixed', endpoint: '', token: '', name: '合成连接' }); f.render();
  finish({ agents: [{ id: 'ccdesk', sessionApi: 1 }] }); await f.settle();
  assert.ok(find(f.render(), 'Picker')); assert.equal(find(f.render(), 'Notice'), undefined);
});
test('there is no compatibility adapter or navigation cast that widens server handoff support', async () => {
  const app = await fs.readFile('apps/mobile/src/app/App.tsx', 'utf8');
  const navigation = await fs.readFile('apps/mobile/src/app/navigation.ts', 'utf8');
  assert.doesNotMatch(navigation + app, /externalNavigation|openExternal|as HandoffTarget/);
  assert.match(app, /const openSessionTarget = useCallback/);
});
test('Codex list refresh cannot auto-select a thread, and both workspaces retain production leave guards', async () => {
  const app = await fs.readFile('apps/mobile/src/app/App.tsx', 'utf8');
  const agents = await fs.readFile('apps/mobile/src/features/agents/AgentWorkspace.tsx', 'utf8');
  assert.doesNotMatch(app, /openThread\(mergedThreads\[0\]|selectLatest:|setAgentMode|localStorage.setItem\("productRemoteMode"/);
  assert.doesNotMatch(agents, /saveAgentView\(|loadAgentView\(|返回 Codex/);
  assert.match(app, /uploadBusyRef.current \|\| persistWorkspaceCache\(\).status === "input-failed"/);
  assert.match(agents, /if \(!flush\(\)\) { event.preventDefault\(\)/);
  assert.match(agents, /if \(uploadScope.current\) { event.preventDefault\(\)/);
  assert.match(app, /useBackLayer\(sidebarOpen && navigation.level === "session"/);
});

test('pending shares stay in their connection scope and are not handed to a different Relay workspace', async t => {
  const f = appNavigationFixture(m.agentSession('claude', 'original')); t.after(() => f.stop());
  const protect = event => event.preventDefault(); f.events.addEventListener('product-before-navigate', protect);
  f.intake.onShare({ id: 'scoped-share', images: [], text: '合成说明' }); await f.settle();
  f.events.removeEventListener('product-before-navigate', protect);
  const settings = find(f.render(), 'Settings');
  settings.props.onApply({ id: 'second', cacheNamespace: 'fixed', endpoint: '', token: '', name: '另一合成连接' }); await f.settle();
  assert.ok(find(f.render(), 'Picker')); assert.equal(find(f.render(), 'Notice'), undefined); assert.deepEqual(f.cleared, []);
  find(f.render(), 'Picker').props.onSelect('codex'); await f.settle();
  assert.equal(find(f.render(), 'Workspace').props.intakeShare, null);
  settings.props.onApply({ id: 'test', cacheNamespace: 'fixed', endpoint: '', token: '', name: '合成连接' }); await f.settle();
  assert.equal(find(f.render(), 'Workspace').props.intakeShare.id, 'scoped-share'); assert.deepEqual(f.cleared, []);
});
