// Run from any directory: node scripts/capture-readme-screens.mjs
// Only synthetic data and an isolated browser context; never start a Relay.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';
import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = path.join(root, 'apps/mobile/dist');
const output = path.join(root, 'docs/images/screens');
const requireMobile = createRequire(new URL('../apps/mobile/package.json', import.meta.url));
const { chromium } = requireMobile('playwright-core');
const now = '2026-11-16T02:00:00.000Z';
const cwd = '~/code/weather-app';
const threadId = '10000000-0000-4000-8000-000000000001';
const sessionId = '20000000-0000-4000-8000-000000000001';
// Deliberately non-secret markers: the app requires non-empty credentials, but
// page.route handles every API request before it can reach any backend.
const credential = 'synthetic-only';
const thread = { id: threadId, threadName: '完善天气卡片', cwd, source: 'vscode', originator: 'Codex Desktop', updatedAt: '2026-11-16T01:58:00.000Z' };
const threads = [thread, { ...thread, id: '10000000-0000-4000-8000-000000000002', threadName: '添加城市搜索', updatedAt: '2026-11-16T01:42:00.000Z' }];
const message = (id, role, text, kind = 'agentMessage', phase) => ({ id, role, text, kind, phase, turnId: 'demo-turn', timestamp: '2026-11-16T01:58:00.000Z' });
const messages = [
  message('demo-user', 'user', '请完善天气卡片：显示温度和降雨概率，并补上测试。', 'userMessage'),
  message('demo-note', 'assistant', '先检查卡片组件和测试，再补齐天气信息，保持现有布局。', 'agentMessage', 'commentary'),
  ...[
    ['rg --files src', 'src/WeatherCard.tsx\nsrc/WeatherCard.test.tsx'],
    ['pnpm test', 'Tests: 12 passed'],
    ['pnpm build', 'Build completed'],
  ].map(([command, result], index) => message(`demo-tool-${index}`, 'tool', `Command: ${command}\nOutput:\n${result}`, 'commandExecution')),
  message('demo-final', 'assistant', '已补齐温度和降雨概率，空数据时显示占位。\n\n```tsx\n<WeatherCard\n  temperature={24}\n  rainChance={30}\n/>\n```\n\n**验证完成**：12 项测试通过，构建成功。', 'agentMessage', 'final_answer'),
];
const desktop = {
  threadId, status: 'completed', messages, messageCount: messages.length, eventCount: 7,
  updatedAt: thread.updatedAt, changeType: 'snapshot', source: 'desktop-ipc', activeTurnId: null,
  userInputs: [], approvals: [], interactionsAvailable: true,
  control: { transport: 'native', token: credential, activeTurnId: null, canSend: true, canInterrupt: false, submission: null, queue: { available: true, items: [] } },
};
const agents = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'ccdesk', label: 'CC Desk' },
].map(agent => ({ ...agent, sessionApi: 1, state: 'connected', transport: 'synthetic' }));
const sessions = Object.fromEntries(agents.map((agent, index) => [agent.id,
  Array.from({ length: [3, 2, 4][index] }, (_, number) => ({
    id: number === 0 ? sessionId : `20000000-0000-4000-8000-${String(number + 1).padStart(12, '0')}`,
    title: ['检查天气卡片测试', '整理城市列表', '完善加载状态', '检查无障碍标签'][number],
    directory: cwd, updatedAt: `2026-11-16T01:${['55', '48', '36'][index]}:00.000Z`,
  })),
]));
const approval = {
  agentId: 'claude', session: sessions.claude[0], connected: true, status: 'running', activity: 'working',
  updatedAt: now, activeTurnId: 'demo-approval-turn', historyCursor: null, partialText: false,
  messages: [message('approval-user', 'user', '请运行天气卡片的测试，确认修改没有影响现有功能。', 'user_message'),
    message('approval-note', 'assistant', '测试已准备好。运行前需要你确认这次命令。', 'agent_message', 'commentary')],
  questions: [], permissions: [{
    id: 'demo-permission', status: 'pending', action: '运行命令', resources: ['pnpm test'], save: [],
    detail: '工作目录：~/code/weather-app\n验证天气卡片的单元测试。', unavailableReason: null, decisions: ['once', 'reject'],
  }],
  control: { token: credential, canSend: true, canSteer: false, canInterrupt: true }, submission: null,
};
const workItems = [
  ['in_progress', '添加城市搜索', '01:54'],
  ['to_verify', '天气卡片显示降雨概率', '01:58'],
  ['to_verify', '补充空数据状态测试', '01:50'],
  ['done', '统一温度单位格式', '01:30'],
].map(([state, title, time], index) => ({
  uid: `30000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, kind: 'task', revision: 1,
  state, title, createdAt: '2026-11-16T01:00:00.000Z', updatedAt: `2026-11-16T${time}:00.000Z`,
}));

function apiResponse(url, method) {
  const route = url.pathname;
  if (method === 'POST' && route.endsWith('/stream-token')) return { streamToken: credential };
  assert.equal(method, 'GET', `Unexpected write: ${method} ${route}`);
  if (['/api/threads', '/api/live/threads'].includes(route)) return { threads, nextOffset: threads.length, hasMore: false };
  if (route === '/api/connection') return { ok: true };
  if (route === '/api/live/turns') return { turns: [] };
  if (route === '/api/desktop/active') return { thread, source: 'ipc-stream' };
  if (route === '/api/gateway') return { gateway: { kind: 'mobile-codex-gateway', desktopTransport: 'native', tunnel: { enabled: true, state: 'connected' } } };
  if (route === '/api/status') return { ok: true, defaultCwd: cwd, uploadDir: '~/code/weather-app/uploads', activeDesktopThread: thread,
    desktopControl: { ok: true, mode: 'desktop-ipc-follower-control' }, live: { ok: true, mode: 'synthetic' } };
  if (['/api/live/health', '/api/desktop/control/health'].includes(route)) return { ok: true, mode: 'synthetic' };
  if (route === `/api/desktop/threads/${threadId}`) return { thread, messages, cursor: 7, windowStart: 0, generation: 'synthetic-generation', turnStatus: 'completed' };
  if (route === `/api/desktop/threads/${threadId}/delta`) return { messages: [], cursor: 7, generation: 'synthetic-generation', turnStatus: 'completed', truncated: false };
  if (route === '/api/agents') return { agents };
  for (const agent of agents) {
    if (route === `/api/agents/${agent.id}/sessions`) return { sessions: sessions[agent.id], cursor: null };
  }
  if (route === '/api/work-items') return { storeId: 'synthetic-store', storeRevision: 1, items: workItems, nextCursor: null };
  throw new Error(`Missing synthetic response: ${method} ${route}`);
}

async function startServer() {
  const streams = new Set();
  const opened = new Map();
  const errors = [];
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      // page.route rewrites only known EventSource requests here. Keeping the
      // response open exercises the app's real stream-token + SSE connection.
      if (url.pathname.startsWith('/__screens/events/')) {
        const kind = url.pathname.split('/').at(-1);
        assert.ok(['desktop', 'approval', 'work-items'].includes(kind));
        opened.set(kind, (opened.get(kind) ?? 0) + 1);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (kind === 'desktop') res.write(`event: desktop\ndata: ${JSON.stringify(desktop)}\n\n`);
        if (kind === 'approval') res.write(`event: agent-session\ndata: ${JSON.stringify(approval)}\n\n`);
        const ping = () => res.write(`event: ping\ndata: ${JSON.stringify(now)}\n\n`);
        ping();
        streams.add(res);
        const timer = setInterval(ping, 1000);
        res.on('close', () => { clearInterval(timer); streams.delete(res); });
        return;
      }
      assert.ok(!url.pathname.startsWith('/api/'), 'API request escaped page.route');
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = path.resolve(dist, `.${relative}`);
      assert.ok(file.startsWith(`${dist}${path.sep}`), 'Invalid static path');
      const data = await readFile(file);
      res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch (error) {
      errors.push(error.message);
      res.writeHead(404);
      res.end('Synthetic screenshot resource unavailable');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { origin: `http://127.0.0.1:${server.address().port}`, opened, errors,
    async close() {
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    } };
}

async function launchBrowser() {
  if (process.env.README_SCREEN_BROWSER === 'chrome') return chromium.launch({ channel: 'chrome', headless: true });
  const candidates = [chromium.executablePath()];
  const cache = platform() === 'darwin' ? path.join(homedir(), 'Library/Caches/ms-playwright') : path.join(homedir(), '.cache/ms-playwright');
  const installations = await readdir(cache).catch(() => []);
  for (const installation of installations.filter(name => /^chromium-\d+$/u.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
    for (const binary of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-linux/chrome', 'chrome-linux64/chrome']) {
      candidates.push(path.join(cache, installation, binary));
    }
  }
  for (const executablePath of candidates) {
    if (await access(executablePath).then(() => true, () => false)) return chromium.launch({ executablePath, headless: true });
  }
  // Use installed Chrome without downloading a browser or using a personal profile.
  return chromium.launch({ channel: 'chrome', headless: true });
}

async function openScreen(browser, server, name, theme = 'light') {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: theme, isMobile: true, hasTouch: true,
    reducedMotion: 'reduce', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.clock.setFixedTime(new Date(now));
  const errors = [];
  const calls = new Set();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`HTTP ${response.status()} ${new URL(response.url()).pathname}`); });
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    try {
      assert.equal(url.origin, server.origin, 'External request blocked');
      if (url.pathname.startsWith('/api/')) {
        calls.add(`${request.method()} ${url.pathname}`);
        if (url.pathname.endsWith('/events')) {
          assert.equal(url.searchParams.get('streamToken'), credential);
          const kind = url.pathname === `/api/desktop/threads/${threadId}/events` ? 'desktop'
            : url.pathname === `/api/agents/claude/sessions/${sessionId}/events` ? 'approval'
              : url.pathname === '/api/work-items/events' ? 'work-items' : null;
          assert.ok(kind, 'Unknown synthetic stream');
          await route.continue({ url: `${server.origin}/__screens/events/${kind}` });
        } else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(apiResponse(url, request.method())) });
      } else {
        assert.ok(url.pathname === '/' || url.pathname === '/favicon.ico' || url.pathname.startsWith('/assets/'), 'Unexpected browser request');
        await route.continue();
      }
    } catch (error) {
      errors.push(error.message);
      await route.abort('blockedbyclient');
    }
  });
  await page.addInitScript(({ origin, theme, threads, threadId, now, credential }) => {
    localStorage.clear();
    const profile = { id: 'screens', name: '演示工作台', endpoint: origin, token: credential, cacheNamespace: 'synthetic', updatedAt: now };
    localStorage.setItem('connectionProfiles', JSON.stringify([profile]));
    localStorage.setItem('activeConnectionProfileId', profile.id);
    localStorage.setItem('themeMode', theme);
    localStorage.setItem('splitMode', 'auto');
    localStorage.setItem('productRemoteMode', 'codex');
    localStorage.setItem('mobicodexDisplayV1', JSON.stringify({ chatFontScale: 1, dynamicColor: false, showToolCards: true, showToolResultSummary: false }));
    const scope = `${profile.id}:${profile.cacheNamespace}:${origin}`;
    localStorage.setItem(`mobileCodexWorkspaceV1:${scope}`, JSON.stringify({ threads, selectedId: threadId, isNewThread: false }));
  }, { origin: server.origin, theme, threads, threadId, now, credential });
  await page.goto(server.origin, { waitUntil: 'domcontentloaded' });
  await page.getByText('验证完成', { exact: true }).waitFor();
  await page.locator('.workspace-switch .status-dot.ok').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.process-toggle')].some(node => node.textContent.includes('执行完成')));
  assert.ok(calls.has(`POST /api/desktop/threads/${threadId}/stream-token`));
  await page.waitForFunction(() => document.fonts.status === 'loaded');
  return { page, context, errors, calls, name };
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

execFileSync('corepack', ['pnpm', '--filter', '@mobile-codex/mobile', 'build'], { cwd: root, stdio: 'inherit' });
await mkdir(output, { recursive: true });
const server = await startServer();
let browser;
try {
  browser = await launchBrowser();
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
  console.log('All five screenshots captured using synthetic API responses and live local SSE.');
} finally {
  await browser?.close();
  await server.close();
}
