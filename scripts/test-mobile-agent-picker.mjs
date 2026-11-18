import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-picker-'));
test.after(() => fs.rm(dir, { recursive: true, force: true }));
await build({
  stdin: { contents: "export * from './apps/mobile/src/features/agents/agentSummary.ts'; export { AgentPickRow } from './apps/mobile/src/features/agents/AgentPickRow.tsx'; export { AgentSessionRow } from './apps/mobile/src/features/agents/AgentSessionRow.tsx'; export { formatListTime } from './apps/mobile/src/shared/format.ts'; export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server';", resolveDir: process.cwd(), loader: 'ts' },
  outfile: path.join(dir, 'picker.cjs'), bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', nodePaths: [path.resolve('apps/mobile/node_modules')],
});
const m = createRequire(import.meta.url)(path.join(dir, 'picker.cjs'));
const source = await fs.readFile('apps/mobile/src/features/agents/AgentPicker.tsx', 'utf8');
const now = Date.parse('2026-11-14T12:00:00+08:00');

test('summary keeps the latest valid activity and whether more sessions exist', () => {
  const summary = m.summarizeSessions([{ updatedAt: '2026-11-14T03:00:00Z' }, { updatedAt: 'nonsense' }, { updatedAt: '2026-11-14T03:55:00Z' }], true);
  assert.deepEqual(summary, { status: 'online', count: 3, more: true, updatedAt: '2026-11-14T03:55:00Z' });
  assert.equal(m.summarizeSessions([], false).updatedAt, null);
});
test('relative activity buckets', () => {
  const ago = ms => new Date(now - ms).toISOString();
  assert.equal(m.relativeActivity(ago(10_000), now), '刚刚');
  assert.equal(m.relativeActivity(ago(5 * 60_000), now), '5 分钟前');
  assert.equal(m.relativeActivity(ago(3 * 3600_000), now), '3 小时前');
  assert.equal(m.relativeActivity(ago(30 * 3600_000), now), '昨天');
  assert.equal(m.relativeActivity(ago(4 * 86400_000), now), '4 天前');
  assert.equal(m.relativeActivity('2026-10-02T04:00:00Z', now), '10月2日');
  assert.equal(m.relativeActivity('2025-10-02T04:00:00Z', now), '2025年10月2日');
  assert.equal(m.relativeActivity(null, now), ''); assert.equal(m.relativeActivity('bad', now), '');
  assert.equal(m.relativeActivity(new Date(now + 60_000).toISOString(), now), '刚刚', 'clock skew never shows the future');
});
test('summary line for each state', () => {
  const online = m.summarizeSessions([{ updatedAt: new Date(now - 5 * 60_000).toISOString() }, { updatedAt: new Date(now - 86400_000 * 3).toISOString() }], false);
  assert.equal(m.summaryLine(online, false, now), '2 个会话 · 最近活动 5 分钟前');
  assert.equal(m.summaryLine({ ...online, more: true }, true, now), '近 30 天 2+ 个会话 · 最近活动 5 分钟前');
  assert.equal(m.summaryLine(m.summarizeSessions([], false), true, now), '近 30 天还没有会话');
  assert.equal(m.summaryLine(m.summarizeSessions([], false), false, now), '还没有会话');
  assert.equal(m.summaryLine(m.checkingSummary), ''); assert.equal(m.summaryLine(undefined), '');
  assert.match(m.summaryLine(m.offlineSummary), /连不上/);
});
test('picker row shows icon, name, status and meta', () => {
  const html = m.renderToStaticMarkup(m.createElement(m.AgentPickRow, { id: 'claude', label: 'Claude Code', description: '说明', now,
    summary: m.summarizeSessions([{ updatedAt: new Date(now - 120_000).toISOString() }], false), onOpen() {} }));
  assert.match(html, /^<button type="button" class="agent-session-row agent-pick-row"><span class="agent-glyph"><svg[^>]*lucide-feather/);
  assert.match(html, /<strong>Claude Code<\/strong><span class="agent-pick-status online">在线<\/span>/);
  assert.match(html, /<small class="agent-pick-meta"><span>1 个会话<\/span> · <span>最近活动 2 分钟前<\/span><\/small>/);
  const checking = m.renderToStaticMarkup(m.createElement(m.AgentPickRow, { id: 'x', label: 'X', description: 'd', summary: undefined, onOpen() {} }));
  assert.match(checking, /agent-pick-status checking">检测中/); assert.doesNotMatch(checking, /agent-pick-meta/);
});
test('#39 list time: 刚刚, HH:mm today, 昨天, MM-DD this year, the year before that', () => {
  const at = (...parts) => new Date(...parts).toISOString(), now = new Date(2026, 10, 18, 9, 5).getTime();
  assert.equal(m.formatListTime(at(2026, 10, 18, 9, 4, 30), now), '刚刚');
  assert.equal(m.formatListTime(at(2026, 10, 18, 0, 3), now), '00:03');
  assert.equal(m.formatListTime(at(2026, 10, 17, 23, 29), now), '昨天');
  assert.equal(m.formatListTime(at(2026, 10, 17, 0, 0), now), '昨天');
  assert.equal(m.formatListTime(at(2026, 10, 16, 23, 59), now), '11-16');
  assert.equal(m.formatListTime(at(2026, 0, 2, 8, 0), now), '01-02');
  assert.equal(m.formatListTime(at(2025, 11, 31, 8, 0), now), '2025-12-31');
  assert.equal(m.formatListTime('', now), ''); assert.equal(m.formatListTime('bad', now), '');
});
test('#39 session row: one-line title, muted time line, where it is open', () => {
  const now = new Date(2026, 10, 18, 9, 5).getTime();
  const row = session => m.renderToStaticMarkup(m.createElement(m.AgentSessionRow, { session: { id: 's', directory: '/w', updatedAt: new Date(2026, 10, 18, 8, 7).toISOString(), ...session }, now, onOpen() {} }));
  const html = row({ title: '  第一行\n\n第二行\t很长 ', desktopOpen: true });
  assert.match(html, /^<button type="button" class="agent-session-row agent-session-item"><span class="agent-session-title">第一行 第二行 很长<\/span><span class="agent-session-meta"><time dateTime="[^"]+">08:07<\/time><span class="desktop">电脑上开着<\/span><\/span><\/button>$/);
  assert.match(row({ title: ' \n ' }), /agent-session-title">未命名会话</);
  assert.doesNotMatch(row({ title: 'x' }), /<strong>|电脑上开着/);
  const css = readFileSync('apps/mobile/src/styles.css', 'utf8');
  assert.match(css, /\.agent-session-title \{[^}]*overflow: hidden; text-overflow: ellipsis; white-space: nowrap;[^}]*font-weight: 500;/);
  assert.match(css, /\.agent-session-meta \{[^}]*color: var\(--muted\); font-size: var\(--font-size-12\)/);
  const workspace = readFileSync('apps/mobile/src/features/agents/AgentWorkspace.tsx', 'utf8');
  assert.match(workspace, /\{session => <AgentSessionRow key=\{session.id\} session=\{session\}/, 'every Agent list uses the same row');
  assert.doesNotMatch(workspace, /toLocaleString\(\)/);
});
test('picker lists Codex and other Agents through the same navigation callback', () => {
  assert.match(source, /const available = \[codexAgent, \.\.\.availableAgents\(data.agents\)\]/);
  assert.match(source, /controller.current\?\.abort\(\)/);
  assert.match(source, /\?range=recent/);
  assert.match(source, /agents.map\(agent => <AgentPickRow/);
  assert.match(source, /onOpen={\(\) => onSelect\(agent.id\)}/);
  assert.match(source, /leading="none"/);
  assert.doesNotMatch(source, /onBack|返回 Codex/);
});
