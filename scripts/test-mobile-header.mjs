import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'header-'));
test.after(() => fs.rm(dir, { recursive: true, force: true }));
await build({
  stdin: { contents: "export { WorkspaceHeader } from './apps/mobile/src/shared/WorkspaceHeader.tsx'; export * from './apps/mobile/src/shared/pullRefresh.ts'; export { AgentIcon } from './apps/mobile/src/features/agents/AgentIcon.tsx'; export { PullToRefresh } from './apps/mobile/src/shared/PullToRefresh.tsx'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server';", resolveDir: process.cwd(), loader: 'ts' },
  outfile: path.join(dir, 'header.cjs'), bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', nodePaths: [path.resolve('apps/mobile/node_modules')],
});
const m = createRequire(import.meta.url)(path.join(dir, 'header.cjs'));
const app = await fs.readFile('apps/mobile/src/app/App.tsx', 'utf8'), agents = await fs.readFile('apps/mobile/src/features/agents/AgentWorkspace.tsx', 'utf8');
const between = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

test('pull-to-refresh fires only past the threshold, from the top, with one finger', () => {
  const pull = m.createPullTracker();
  pull.start(0, 100); assert.equal(pull.move(0, 100 + m.pullRefreshThreshold * 2), m.pullRefreshThreshold); assert.equal(pull.end(), true);
  pull.start(0, 100); assert.equal(pull.move(0, 1000), 96, 'capped'); assert.equal(pull.end(), true);
  pull.start(0, 100); pull.move(0, 150); assert.equal(pull.end(), false, 'short pull');
  pull.start(20, 100); assert.equal(pull.move(20, 400), 0); assert.equal(pull.end(), false, 'not at top');
  pull.start(0, 100); pull.move(0, 300); assert.equal(pull.move(5, 320), 0); assert.equal(pull.end(), false, 'list scrolled away');
  pull.start(0, 100, 2); pull.move(0, 400); assert.equal(pull.end(), false, 'pinch');
  pull.start(0, 100); pull.move(0, 400); pull.cancel(); assert.equal(pull.end(), false, 'cancelled');
  pull.start(0, 100); assert.equal(pull.move(0, 50), 0, 'pushing up is not a pull');
});
test('PullToRefresh renders the list container untouched until pulled', () => {
  const html = m.renderToStaticMarkup(m.createElement(m.PullToRefresh, { className: 'thread-list', label: 'Codex 线程列表', onRefresh() {} }, m.createElement('p', null, 'row')));
  assert.equal(html, '<div class="thread-list" aria-label="Codex 线程列表"><p>row</p></div>');
});
test('each Agent has its own neutral icon; unknown falls back to a robot', () => {
  const svg = id => m.renderToStaticMarkup(m.createElement(m.AgentIcon, { id, size: 18 }));
  const classes = ['codex', 'claude', 'deepseek', 'opencode', 'other'].map(id => svg(id).match(/lucide-([a-z-]+)/g).at(-1));
  assert.equal(new Set(classes).size, 5, classes.join());
  assert.match(svg('other'), /lucide-bot/); assert.match(svg('codex'), /aria-hidden="true"/);
});
test('shared top bar has exactly four controls in the same order for every Agent', () => {
  for (const agentId of ['codex', 'claude', 'deepseek', 'opencode', 'ccdesk']) {
    const html = m.renderToStaticMarkup(m.createElement(m.WorkspaceHeader, {
      agentId, title: '一个很长的会话名称', subtitle: '同一连接', project: 'weather-app',
      leading: agentId === 'codex' ? 'menu' : 'back', leadingLabel: agentId === 'codex' ? '打开线程列表' : '返回 Agent 列表',
      onLeading() {}, onSwitchAgent() {}, onOpenItems() {}, onOpenSettings() {},
      ...(agentId === 'codex' ? { connection: { label: '已连接', state: 'ok' } } : {}),
    }));
    assert.equal((html.match(/<button/g) ?? []).length, 4);
    const labels = [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map(match => match[1]);
    assert.equal(labels[0], agentId === 'codex' ? '打开线程列表' : '返回 Agent 列表');
    assert.match(labels[1], /点按切换 Agent/); assert.deepEqual(labels.slice(2), ['事项', '设置']);
    assert.match(html, /workspace-switch-arrow/); assert.match(html, /class="project-chip">weather-app/);
    assert.doesNotMatch(html, /刷新线程|RefreshCcw/);
    if (agentId === 'codex') assert.match(html, /<strong>[^<]+<\/strong><span class="status-dot ok"/);
  }
  assert.match(app, /<WorkspaceHeader agentId="codex"[^]*?onSwitchAgent={onOpenAgents}[^]*?onOpenSettings={onOpenSettings}/);
  assert.match(app, /workspaceProject = selected\?\.cwd \? projectGroupLabel\(selected\.cwd\)/);
  assert.doesNotMatch(app, /workspaceReady/);
});
test('the Agent picker retains the same four slots, without a redundant switch button', () => {
  const html = m.renderToStaticMarkup(m.createElement(m.WorkspaceHeader, { agentId: '', title: '选择 Agent', subtitle: '同一连接',
    leading: 'back', leadingLabel: '返回 Codex', onLeading() {}, onOpenItems() {}, onOpenSettings() {} }));
  assert.equal((html.match(/<button/g) ?? []).length, 3);
  assert.match(html, /workspace-switch static/); assert.doesNotMatch(html, /workspace-switch-arrow/);
});
test('shared narrow header reserves action widths and truncates the title without Agent branches', async () => {
  const css = await fs.readFile('apps/mobile/src/styles.css', 'utf8');
  assert.match(css, /\.workspace-header \{[^}]*grid-template-columns: 44px minmax\(0, 1fr\) 44px 44px/);
  assert.match(css, /\.workspace-header > \.icon-button \{[^}]*width: 44px; height: 44px/);
  assert.match(css, /\.workspace-name strong \{[^}]*text-overflow: ellipsis; white-space: nowrap/);
  assert.doesNotMatch(css, /\.agent-workspace \.topbar|\[data-agent[^}]*workspace-header/);
});
test('refresh moved to pull-to-refresh (with a fallback in the thread drawer); settings reachable from the drawer', () => {
  assert.match(app, /<PullToRefresh className="thread-list" label="Codex 线程列表" onRefresh={\(\) => loadThreads\(\)}>/);
  const drawer = between(app, '<div className="sidebar-actions">', 'sidebar-close');
  assert.match(drawer, /aria-label="刷新线程"/); assert.match(drawer, /onOpenSettings\(\)[^]*aria-label="设置"/);
});
test('Agent top bar uses the shared controls, retains back and switch guards and list refresh', () => {
  assert.match(agents, /<WorkspaceHeader agentId={agent\?\.id \?\? ""}[^]*?onLeading={back} onSwitchAgent={agent \? switchAgent : undefined} onOpenItems={onCapture} onOpenSettings={onOpenSettings}/);
  assert.doesNotMatch(agents, /<header className="topbar/);
  assert.match(agents, /<PullToRefresh className="agent-session-list" onRefresh={\(\) => agent \? loadSessions\(agent\) : loadAgents\(\)}>/);
  assert.match(agents, /function switchAgent\(\) {\s*if \(!agent \|\| !window\.dispatchEvent\(new Event\(productBeforeNavigate/);
});
