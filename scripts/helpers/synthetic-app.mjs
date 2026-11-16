// Shared synthetic browser environment. Importing this module starts nothing.
// Only synthetic data and an isolated browser context; never start a Relay.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir, platform } from 'node:os';
import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const dist = path.join(root, 'apps/mobile/dist');
const requireMobile = createRequire(new URL('../../apps/mobile/package.json', import.meta.url));
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
const ccdeskSession = { ...sessions.ccdesk[0], id: '40000000-0000-4000-8000-000000000001', title: '核对城市搜索结果' };
sessions.ccdesk[0] = ccdeskSession;
const attentionNotification = { key: `agent:ccdesk:${ccdeskSession.id}`, title: ccdeskSession.title };
const attentionItems = [{ ...attentionNotification, running: true, requests: [] }];
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
const ccdesk = {
  ...approval, agentId: 'ccdesk', session: ccdeskSession, status: 'idle', activeTurnId: null, permissions: [],
  messages: [message('desk-user', 'user', '请核对城市搜索的空结果提示。', 'user_message'),
    message('desk-result', 'assistant', '已核对城市搜索，空结果会显示清晰提示。', 'agent_message', 'final_answer')],
  control: { token: credential, canSend: true, canSteer: false, canInterrupt: false },
};

export const syntheticData = { now, credential, threadId, sessionId, threads, desktop, agents, sessions, approval, ccdesk, workItems, attentionNotification, attentionItems };

export function buildSyntheticApp() {
  execFileSync('corepack', ['pnpm', '--filter', '@mobile-codex/mobile', 'build'], { cwd: root, stdio: 'inherit' });
}

function streamKind(route) {
  return route === `/api/desktop/threads/${threadId}/events` ? 'desktop'
    : route === `/api/agents/claude/sessions/${sessionId}/events` ? 'approval'
      : route === `/api/agents/ccdesk/sessions/${ccdeskSession.id}/events` ? 'ccdesk'
        : route === '/api/work-items/events' ? 'work-items' : null;
}

export function syntheticApiResponse(url, method) {
  const route = url.pathname;
  if (method === 'POST' && route.endsWith('/stream-token') && streamKind(route.replace(/\/stream-token$/u, '/events'))) return { streamToken: credential };
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
  if (route === '/api/attention') return { items: attentionItems };
  if (route === `/api/agents/ccdesk/sessions/${ccdeskSession.id}`) return ccdesk;
  for (const agent of agents) {
    if (route === `/api/agents/${agent.id}/sessions`) return { sessions: sessions[agent.id], cursor: null };
  }
  if (route === '/api/work-items') return { storeId: 'synthetic-store', storeRevision: 1, items: workItems, nextCursor: null };
  throw new Error(`Missing synthetic response: ${method} ${route}`);
}

export async function startSyntheticServer({ distDirectory = dist } = {}) {
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
        assert.ok(['desktop', 'approval', 'ccdesk', 'work-items'].includes(kind));
        opened.set(kind, (opened.get(kind) ?? 0) + 1);
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (kind === 'desktop') res.write(`event: desktop\ndata: ${JSON.stringify(desktop)}\n\n`);
        if (kind === 'approval') res.write(`event: agent-session\ndata: ${JSON.stringify(approval)}\n\n`);
        if (kind === 'ccdesk') res.write(`event: agent-session\ndata: ${JSON.stringify(ccdesk)}\n\n`);
        const ping = () => res.write(`event: ping\ndata: ${JSON.stringify(now)}\n\n`);
        ping();
        streams.add(res);
        const timer = setInterval(ping, 1000);
        res.on('close', () => { clearInterval(timer); streams.delete(res); });
        return;
      }
      assert.ok(!url.pathname.startsWith('/api/'), 'API request escaped page.route');
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const file = path.resolve(distDirectory, `.${relative}`);
      assert.ok(file.startsWith(`${distDirectory}${path.sep}`), 'Invalid static path');
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

export async function launchSyntheticBrowser() {
  const { chromium } = requireMobile('playwright-core');
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

// Runs before the real app. A fresh context supplies clean storage; reloads must
// keep the app's own navigation and draft records, rather than reseed them.
export function seedSyntheticStorage({ origin, theme, initial, threads, threadId, now, credential }) {
  if (location.origin !== origin || localStorage.getItem('syntheticAppInitialized') === '1') return;
  const profile = { id: 'screens', name: '演示工作台', endpoint: origin, token: credential, cacheNamespace: 'synthetic', updatedAt: now };
  localStorage.setItem('connectionProfiles', JSON.stringify([profile]));
  localStorage.setItem('activeConnectionProfileId', profile.id);
  localStorage.setItem('themeMode', theme);
  localStorage.setItem('splitMode', 'auto');
  localStorage.setItem('mobicodexDisplayV1', JSON.stringify({ chatFontScale: 1, dynamicColor: false, showToolCards: true, showToolResultSummary: false }));
  if (initial === 'codex-session') {
    localStorage.setItem('productRemoteMode', 'codex');
    const scope = `${profile.id}:${profile.cacheNamespace}:${origin}`;
    localStorage.setItem(`mobileCodexWorkspaceV1:${scope}`, JSON.stringify({ threads, selectedId: threadId, isNewThread: false }));
  }
  localStorage.setItem('syntheticAppInitialized', '1');
}

export async function openSyntheticPage(browser, server, { name = 'synthetic-app', theme = 'light', initial = 'picker' } = {}) {
  assert.ok(['picker', 'codex-session'].includes(initial), 'Unknown initial synthetic screen');
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
    locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: theme, isMobile: true, hasTouch: true,
    reducedMotion: 'reduce', serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.clock.setFixedTime(new Date(now));
    const errors = [], calls = new Set();
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
            assert.equal(request.method(), 'GET');
            assert.equal(url.searchParams.get('streamToken'), credential);
            const kind = streamKind(url.pathname);
            assert.ok(kind, 'Unknown synthetic stream');
            await route.continue({ url: `${server.origin}/__screens/events/${kind}` });
          } else {
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(syntheticApiResponse(url, request.method())) });
          }
        } else {
          assert.ok(url.pathname === '/' || url.pathname === '/favicon.ico' || url.pathname.startsWith('/assets/'), 'Unexpected browser request');
          await route.continue();
        }
      } catch (error) {
        errors.push(error.message);
        await route.abort('blockedbyclient').catch(() => {});
      }
    });
    await page.addInitScript(seedSyntheticStorage, { origin: server.origin, theme, initial, threads, threadId, now, credential });
    await page.goto(server.origin, { waitUntil: 'domcontentloaded' });
    await page.locator('.workspace-header').waitFor();
    await page.evaluate(() => document.fonts.ready);
    return { page, context, errors, calls, name, scope: `screens:synthetic:${server.origin}` };
  } catch (error) {
    await context.close();
    throw error;
  }
}
