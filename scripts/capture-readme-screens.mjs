// Run from any directory: node scripts/capture-readme-screens.mjs
// Only synthetic data and an isolated browser context; never start a Relay.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSyntheticApp, startSyntheticServer, launchSyntheticBrowser, openSyntheticPage, syntheticData } from './helpers/synthetic-app.mjs';

const output = fileURLToPath(new URL('../docs/images/screens/', import.meta.url));
const { threadId, sessionId } = syntheticData;

async function openScreen(browser, server, name, theme = 'light') {
  const screen = await openSyntheticPage(browser, server, { name, theme, initial: 'codex-session' });
  const { page, calls } = screen;
  await page.getByText('验证完成', { exact: true }).waitFor();
  await page.locator('.workspace-switch .status-dot.ok').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.process-toggle')].some(node => node.textContent.includes('执行完成')));
  assert.ok(calls.has(`POST /api/desktop/threads/${threadId}/stream-token`));
  return screen;
}

async function assertClean(screen, server) {
  const { page, errors } = screen;
  await page.evaluate(() => document.fonts.ready);
  const text = await page.locator('body').innerText();
  assert.doesNotMatch(text, /未连接|离线|正在恢复连接|无法连接|连接失败|准备连接|读取线程中/u);
  assert.doesNotMatch(text, /\/Users\/|\/home\/|[\w.+-]+@[\w.-]+\.[a-z]+|https?:\/\/|\b(?:\d{1,3}\.){3}\d{1,3}\b|synthetic-only|Bearer\s/iu);
  assert.deepEqual(errors, [], 'Browser errors');
  assert.deepEqual(server.errors, [], 'Static/SSE server errors');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390, 'Horizontal page overflow');
}

async function assertInFrame(locator) {
  const box = await locator.boundingBox();
  assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 391 && box.y + box.height <= 845,
    'Required content is outside the screenshot');
  const viewport = await locator.evaluate(element => {
    const parent = element.closest('.messages-viewport');
    if (!parent) return null;
    const box = parent.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom };
  });
  if (viewport) assert.ok(box.y >= viewport.top && box.y + box.height <= viewport.bottom + 1,
    'Message content is clipped by its viewport or composer');
}

async function capture(screen, server) {
  await screen.page.locator('body').click({ position: { x: 1, y: 1 } });
  await assertClean(screen, server);
  const image = await screen.page.screenshot({ type: 'jpeg', quality: 85, fullPage: false, animations: 'disabled', caret: 'hide', scale: 'device' });
  assert.ok(image.length <= 400_000, `${screen.name} exceeds 400 KB`);
  await writeFile(path.join(output, screen.name), image);
  console.log(`${screen.name}: ${(image.length / 1024).toFixed(1)} KiB, 1170×2532, verified`);
}

buildSyntheticApp();
await mkdir(output, { recursive: true });
const server = await startSyntheticServer();
let browser;
try {
  browser = await launchSyntheticBrowser();
  for (const theme of ['light', 'dark']) {
    const screen = await openScreen(browser, server, theme === 'light' ? 'codex-session.jpg' : 'codex-session-dark.jpg', theme);
    const { page } = screen;
    // The entire small conversation fits; keep its beginning in the frame.
    await page.locator('.messages-viewport').evaluate(element => { element.scrollTop = 0; });
    assert.equal(await page.locator('.process-toggle').getAttribute('aria-expanded'), 'false');
    await assertInFrame(page.locator('.from-user').first());
    await assertInFrame(page.getByText('验证完成', { exact: true }));
    await assertInFrame(page.locator('.code-block').first());
    assert.equal(await page.locator('.project-chip').first().innerText(), 'weather-app');
    await capture(screen, server);
    await screen.context.close();
  }
  const picker = await openScreen(browser, server, 'agent-picker.jpg');
  await picker.page.getByRole('button', { name: /点按切换 Agent/u }).click();
  await picker.page.getByText('选择 Agent', { exact: true }).waitFor();
  await picker.page.waitForFunction(() => document.querySelectorAll('.agent-pick-status.online').length === 4);
  for (const label of ['Codex', 'Claude Code', 'DeepSeek', 'CC Desk']) {
    const row = picker.page.locator('.agent-pick-row').filter({ has: picker.page.getByText(label, { exact: true }) });
    assert.match(await row.innerText(), /\d+ 个会话.*最近活动/u);
    await assertInFrame(row);
  }
  await capture(picker, server);
  await picker.context.close();

  // Compact session list (#39): a realistic multi-project list, served only to this page.
  const base = Date.parse(syntheticData.now), ago = minutes => new Date(base - minutes * 60_000).toISOString();
  const listSessions = [
    ['给天气卡片加降雨概率，并补上测试', 'weather-app', 0.2, true], ['核对城市搜索结果', 'weather-app', 25],
    ['修复登录页在横屏时的布局', 'weather-app', 60 * 20], ['发布前检查清单', 'weather-app', 60 * 30],
    ['支付回调失败时按指数退避重试', 'shop-api', 60 * 24 * 3], ['补充订单接口的单元测试', 'shop-api', 60 * 24 * 5],
    ['整理接口文档', 'shop-api', 60 * 24 * 40], ['写本周周报', 'notes', 90],
    ['整理读书笔记', 'notes', 60 * 24 * 2], ['下周的发布安排', 'notes', 60 * 24 * 8],
  ].map(([title, project, minutes, desktopOpen], index) => ({
    id: `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, title, directory: `~/code/${project}`,
    updatedAt: ago(minutes), ...(desktopOpen ? { desktopOpen } : {}),
  }));
  const list = await openScreen(browser, server, 'session-list.jpg');
  await list.page.route('**/api/agents/ccdesk/sessions*', route => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: listSessions, cursor: null }),
  }));
  await list.page.getByRole('button', { name: /点按切换 Agent/u }).click();
  await list.page.locator('.agent-pick-row').filter({ has: list.page.getByText('CC Desk', { exact: true }) }).click();
  const rows = list.page.locator('.agent-session-list .agent-session-row');
  await rows.nth(listSessions.length - 1).waitFor({ state: 'attached' });
  const visibleRows = await rows.evaluateAll(nodes => nodes.filter(node => {
    const box = node.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight;
  }).length);
  assert.ok(visibleRows >= 8, `Only ${visibleRows} session rows fit on screen`);
  await list.page.getByText('电脑上开着').first().waitFor();
  await capture(list, server);
  await list.context.close();

  const permissions = await openScreen(browser, server, 'approval.jpg');
  await permissions.page.getByRole('button', { name: /点按切换 Agent/u }).click();
  await permissions.page.locator('.agent-pick-row').filter({ has: permissions.page.getByText('Claude Code', { exact: true }) }).click();
  await permissions.page.getByRole('button', { name: /检查天气卡片测试/u }).click();
  const card = permissions.page.getByRole('region', { name: 'Claude Code 权限请求' });
  await card.waitFor();
  await permissions.page.getByRole('button', { name: '允许一次', exact: true }).waitFor({ state: 'visible' });
  assert.equal(await permissions.page.getByRole('button', { name: '允许一次', exact: true }).isEnabled(), true);
  await permissions.page.locator('.agent-chat .messages-viewport').evaluate(element => { element.scrollTop = 0; });
  await assertInFrame(card);
  assert.ok(permissions.calls.has(`POST /api/agents/claude/sessions/${sessionId}/stream-token`));
  await capture(permissions, server);
  await permissions.context.close();

  const items = await openScreen(browser, server, 'work-items.jpg');
  await items.page.getByRole('button', { name: '事项', exact: true }).click();
  await items.page.getByRole('dialog', { name: '事项', exact: true }).waitFor();
  // The actual app has status tabs rather than a combined list. Keep that UI:
  // four items in total, two waiting verification, with all state counts shown.
  for (const [label, count, title] of [
    ['进行中', 1, '添加城市搜索'], ['完成', 1, '统一温度单位格式'], ['待验证', 2, '天气卡片显示降雨概率'],
  ]) {
    const tab = items.page.getByRole('tab', { name: new RegExp(`^${label}\\s*${count}$`, 'u') });
    await tab.click();
    await items.page.getByRole('button', { name: new RegExp(title, 'u') }).waitFor();
  }
  assert.equal(await items.page.locator('.work-items-row').count(), 2);
  await assertInFrame(items.page.getByRole('dialog', { name: '事项', exact: true }));
  assert.ok(items.calls.has('POST /api/work-items/stream-token'));
  await capture(items, server);
  await items.context.close();
  for (const kind of ['desktop', 'approval', 'work-items']) assert.ok(server.opened.get(kind) > 0, `SSE not exercised: ${kind}`);
  console.log('All six screenshots captured using synthetic API responses and live local SSE.');
} finally {
  try { await browser?.close(); } finally { await server.close(); }
}
