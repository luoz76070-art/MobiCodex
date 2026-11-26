// Run outside the sandbox: node scripts/check-navigation-flow.mjs
// Drives the built app's real React UI. No Relay, native bridge or real sessions.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildSyntheticApp, startSyntheticServer, launchSyntheticBrowser, openSyntheticPage, syntheticData } from './helpers/synthetic-app.mjs';

const output = '/tmp/mobicodex-nav-flow';
const claudeSession = syntheticData.sessions.claude[0];
let server, browser, screen, sequence = 0, passed = 0, skipped = 0;
const header = () => screen.page.locator('.workspace-header');
const title = () => header().locator('.workspace-name strong');
const pickerRow = name => screen.page.locator('.agent-pick-row').filter({ has: screen.page.getByText(name, { exact: true }) });
const sessionRows = () => screen.page.locator('.agent-session-list .agent-session-row:not(.agent-pick-row)');

async function currentTitle() {
  return screen ? title().innerText({ timeout: 1500 }).catch(() => '（顶栏不可用）') : '（页面未启动）';
}
async function screenshot(name) {
  if (!screen || screen.page.isClosed()) return;
  await screen.page.screenshot({ path: path.join(output, `${String(sequence).padStart(2, '0')}-${name}.png`),
    fullPage: false, animations: 'disabled', caret: 'hide' });
}
async function assertHealthy() {
  assert.deepEqual(screen.errors, [], 'Browser/API errors');
  assert.deepEqual(server.errors, [], 'Static/SSE errors');
  const notices = await screen.page.locator('.system-notice').allTextContents();
  assert.doesNotMatch(notices.join('\n'), /未连接|离线|恢复连接|无法连接|失败|未知/u);
}
async function step(name, run) {
  sequence++;
  try {
    await run();
    await assertHealthy();
    await screenshot(name);
    passed++;
    console.log(`✓ ${name} | 顶栏：${await currentTitle()}`);
  } catch (error) {
    await screenshot(`${name}-失败`).catch(() => {});
    console.error(`✗ ${name} | 顶栏：${await currentTitle()} | ${error.message}`);
    throw error;
  }
}
async function assertNavigation(level, agentId, sessionId = null) {
  // Observe the production app's persisted state; never write or force navigation.
  await screen.page.waitForFunction(({ key, expected }) => {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null');
    return value?.version === 1 && value.level === expected.level && value.agentId === expected.agentId && value.sessionId === expected.sessionId;
  }, { key: `mobileCodexNavigationV1:${screen.scope}`, expected: { level, agentId, sessionId } });
}
async function assertHeader(expectedTitle, leading) {
  await screen.page.waitForFunction(value => document.querySelector('.workspace-header .workspace-name strong')?.textContent === value, expectedTitle);
  const labels = await header().getByRole('button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  if (!leading) assert.deepEqual(labels, ['事项', '设置']);
  else {
    assert.equal(labels.length, 4);
    assert.equal(labels[0], leading);
    assert.match(labels[1], /点按切换 Agent$/u);
    assert.deepEqual(labels.slice(2), ['事项', '设置']);
    assert.equal(await header().locator('.workspace-switch-arrow').count(), 1);
  }
  assert.equal(await header().getByRole('button', { name: '事项', exact: true }).isVisible(), true);
  assert.equal(await header().getByRole('button', { name: '设置', exact: true }).isVisible(), true);
}
async function assertPicker() {
  await assertNavigation('picker', null);
  await assertHeader('选择 Agent', null);
  await pickerRow('Claude Code').waitFor();
  assert.equal(await header().getByRole('button', { name: /返回/u }).count(), 0);
}
async function assertClaudeList() {
  await assertNavigation('agent', 'claude');
  await assertHeader('Claude Code', '返回 Agent 列表');
  await sessionRows().first().waitFor();
  assert.equal(await screen.page.locator('.agent-chat').count(), 0);
}
async function assertClaudeSession() {
  await assertNavigation('session', 'claude', claudeSession.id);
  await assertHeader(claudeSession.title, '打开会话列表');
  await screen.page.locator('.agent-chat').waitFor();
  await screen.page.getByRole('region', { name: 'Claude Code 权限请求' }).waitFor();
  await screen.page.waitForFunction(() => {
    const button = [...document.querySelectorAll('.agent-permission button')].find(node => node.textContent === '允许一次');
    return button && !button.disabled;
  });
}
async function productBack(expectedPrevented = true) {
  const result = await screen.page.evaluate(() => {
    const event = new Event('product-back', { cancelable: true });
    const dispatched = window.dispatchEvent(event);
    return { prevented: event.defaultPrevented, dispatched };
  });
  assert.deepEqual(result, { prevented: expectedPrevented, dispatched: !expectedPrevented });
}

try {
  await mkdir(output, { recursive: true });
  buildSyntheticApp();
  server = await startSyntheticServer();
  browser = await launchSyntheticBrowser();
  screen = await openSyntheticPage(browser, server); // Fresh context; no navigation/legacy keys seeded.
  await step('a-选择Agent', assertPicker);
  await step('b-Claude会话列表', async () => {
    await pickerRow('Claude Code').click();
    await assertClaudeList();
  });
  await step('b-Claude会话', async () => {
    await sessionRows().first().click();
    await assertClaudeSession();
    assert.ok(screen.calls.has(`POST /api/agents/claude/sessions/${claudeSession.id}/stream-token`));
  });
  await step('c-会话内全局设置', async () => {
    await header().getByRole('button', { name: '设置', exact: true }).click();
    await screen.page.locator('.settings-sheet.open').waitFor();
    await assertClaudeSession();
  });
  await step('c-返回仅关闭设置', async () => {
    await productBack();
    await screen.page.locator('.settings-sheet.open').waitFor({ state: 'detached' });
    await assertClaudeSession();
  });
  // #56: inside a session the top-left button opens this Agent's list as a drawer, like Codex.
  const drawer = () => screen.page.locator('.agent-session-drawer.open');
  const drawerRow = name => drawer().locator('.agent-session-row').filter({ has: screen.page.getByText(name, { exact: true }) });
  await step('c-会话内打开会话列表', async () => {
    await header().getByRole('button', { name: '打开会话列表', exact: true }).click();
    await drawerRow('整理城市列表').waitFor();
    await assertClaudeSession();
  });
  await step('c-返回先关会话列表', async () => {
    await productBack();
    await drawer().waitFor({ state: 'detached' });
    await assertClaudeSession();
  });
  await step('c-会话列表里切换会话', async () => {
    await header().getByRole('button', { name: '打开会话列表', exact: true }).click();
    await drawerRow('整理城市列表').click();
    await assertNavigation('session', 'claude', syntheticData.sessions.claude[1].id);
    await screen.page.getByText('城市列表已按拼音排序。').waitFor();
    assert.equal(await drawer().count(), 0, 'switching closes the drawer');
  });
  await step('c-切回原会话', async () => {
    await header().getByRole('button', { name: '打开会话列表', exact: true }).click();
    await drawerRow(claudeSession.title).click();
    await assertClaudeSession();
  });
  await step('d-返回会话列表', async () => { await productBack(); await assertClaudeList(); });
  await step('d-返回选择Agent', async () => { await productBack(); await assertPicker(); });
  await step('d-根页不拦截返回', async () => { await productBack(false); await assertPicker(); });
  await step('e-Codex工作台', async () => {
    await pickerRow('Codex').click();
    await assertNavigation('agent', 'codex');
    await assertHeader('MobiCodex', '打开线程列表');
    await screen.page.locator('.codex-shell .thread-sidebar.open').waitFor();
  });
  await step('e-Codex直接返回选择Agent', async () => { await productBack(); await assertPicker(); });
  await step('f-刷新恢复选择Agent', async () => { await screen.page.reload({ waitUntil: 'domcontentloaded' }); await assertPicker(); });
  // Also exercise a non-default destination: a broken restore must not pass just
  // because both a reset and a successful restore happen to show the picker.
  await step('f-准备会话恢复', async () => {
    await pickerRow('Claude Code').click(); await assertClaudeList();
    await sessionRows().first().click(); await assertClaudeSession();
  });
  await step('f-刷新恢复原会话', async () => {
    await screen.page.reload({ waitUntil: 'domcontentloaded' });
    await assertClaudeSession();
  });
  await step('f-冷启动进入选择Agent', async () => {
    // Opening the app gives a fresh WebView: sessionStorage is empty, the saved page and drafts stay.
    await screen.page.evaluate(() => sessionStorage.clear());
    await screen.page.reload({ waitUntil: 'domcontentloaded' });
    await assertPicker();
  });

  // attention.ts only registers Attention.open on native platforms. App has no
  // exported window notification entry in web builds. Do not invent one or use
  // a picker click/localStorage write as a pretend notification success.
  sequence++; skipped++;
  await screenshot('g-通知入口跳过');
  console.log(`- 跳过 g：网页端无可用 Attention.open，也未暴露同一通知入口；未验证通知跳转。合成目标：${syntheticData.attentionNotification.key} | 顶栏：${await currentTitle()}`);
  console.log(`完成：${passed} 项通过，${skipped} 项跳过。截图：${output}`);
} catch (error) {
  console.error(`✗ 导航检查失败 | 顶栏：${await currentTitle()} | ${error.message}`);
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } finally { await server?.close(); }
}
