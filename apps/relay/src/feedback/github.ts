import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { feedbackTargetId, githubRepoName, publicFeedbackReceipt, type FeedbackContext, type FeedbackStore } from './store.js';

export const feedbackConfigSchema = z.object({
  github: z.object({
    repos: z.array(z.object({ id: feedbackTargetId, repo: githubRepoName, label: z.string().trim().min(1).max(40), public: z.boolean() }).strict())
      .min(1).max(10).refine(repos => new Set(repos.map(repo => repo.id)).size === repos.length, { message: 'duplicate feedback target id' }),
    /** Absolute path of the GitHub CLI; the gateway may run without the login shell's PATH. */
    gh: z.string().refine(value => path.isAbsolute(value)).optional(),
    /** HTTPS proxy for gh only, when this computer reaches GitHub through one. */
    proxy: z.string().url().optional(),
  }).strict().optional(),
}).strict();
export type FeedbackConfig = z.infer<typeof feedbackConfigSchema>;
export type FeedbackGithubConfig = NonNullable<FeedbackConfig['github']>;
export type FeedbackTarget = FeedbackGithubConfig['repos'][number];

export type FeedbackRedactor = (value: string) => string;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const currentUser = () => { try { return os.userInfo().username; } catch { return ''; } };
/** Hide what identifies this computer or grants access before anything leaves for GitHub. */
export function createFeedbackRedactor(options: { home?: string; username?: string; hostname?: string; hide?: Array<string | undefined> } = {}): FeedbackRedactor {
  const home = options.home ?? os.homedir();
  const host = options.hostname ?? os.hostname();
  const words = [...new Set([options.username ?? currentUser(), host, host.replace(/\.local$/i, '')])].filter(word => word.length >= 4).sort((a, b) => b.length - a.length);
  const literals = [...new Set((options.hide ?? []).filter((value): value is string => Boolean(value && value.length >= 4)))].sort((a, b) => b.length - a.length);
  return value => {
    // ASCII-only character classes: Chinese text often follows a link or path without a space.
    let text = value.replace(/\b(?:https?|wss?):\/\/[\w.~:/?#[\]@!$&()*+,;=%-]+/gi, url => /^https:\/\/(?:www\.)?github\.com\//i.test(url) ? url : '<网址>');
    if (home.length > 1) text = text.replace(new RegExp(`${escapeRegExp(home)}(?![\\w.-])`, 'g'), '~');
    for (const literal of literals) text = text.split(literal).join('<已隐藏>');
    text = text
      .replace(/(?:\/Users|\/home)\/[\w.-]+/g, '~')
      .replace(/\b[A-Za-z]:\\Users\\[\w.-]+/g, '~')
      .replace(/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer <密钥>')
      .replace(/\b(?:sk-[\w-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|AKIA[0-9A-Z]{16})/g, '<密钥>')
      .replace(/[\w.%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<邮箱>')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '<IP 地址>')
      .replace(/\b[a-f0-9]{32,}\b/gi, '<长串>')
      .replace(/[A-Za-z0-9+/_-]{40,}={0,2}/g, match => /\d/.test(match) && /[A-Za-z]/.test(match) ? '<长串>' : match);
    for (const word of words) text = text.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(word)}(?![A-Za-z0-9])`, 'gi'), '<已隐藏>');
    return text;
  };
}

export const feedbackIssueMarker = (id: string) => `<!-- mobicodex-feedback:${id} -->`;
const cell = (value: string) => value.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
/** The preview shows exactly this title and body; the submitter only appends the invisible marker. */
export function renderFeedbackIssue(input: { text: string; context: FeedbackContext }, redact: FeedbackRedactor) {
  // A zero-width space after @ keeps an issue from notifying whoever the text happens to name.
  const clean = (value: string) => redact(value).replace(/@(?=[A-Za-z0-9_-])/g, '@​');
  const text = clean(input.text.trim());
  const first = Array.from((text.split('\n').map(line => line.trim()).find(Boolean) ?? '').replace(/\s+/g, ' '));
  const title = `手机反馈：${first.length > 60 ? `${first.slice(0, 59).join('')}…` : first.join('')}`;
  const c = input.context;
  const rows = ([['版本', c.version ? `${c.version}（code${c.versionCode}）` : ''], ['页面', c.page], ['Agent', c.agentId],
    ['手机', [c.model, c.os].filter(Boolean).join(' · ')], ['最近错误', c.lastError]] as const).filter(([, value]) => value)
    .map(([name, value]) => `| ${name} | ${cell(clean(value))} |`);
  const body = [text, '', ...(rows.length ? ['| 项目 | 内容 |', '| --- | --- |', ...rows, ''] : []),
    '> 从 MobiCodex 手机端「反馈问题」提交。提交前已隐藏本机路径、用户名、邮箱、网址、IP 地址和密钥。'].join('\n');
  return { title, body };
}

export type FeedbackIssueClient = {
  /** The issue an earlier attempt already filed for this marker, if any. */
  find(repo: string, marker: string): Promise<number | undefined>;
  create(repo: string, issue: { title: string; body: string }): Promise<number>;
};
type IssueFailure = 'gh_missing' | 'gh_auth' | 'gh_repo' | 'gh_network' | 'gh_timeout' | 'gh_failed';
export class FeedbackIssueError extends Error { constructor(readonly reason: IssueFailure) { super(reason); } }
const failureText: Record<IssueFailure, string> = {
  gh_missing: '电脑上找不到 gh 命令', gh_auth: '电脑上的 gh 没登录 GitHub，或没有这个仓库的权限', gh_repo: '找不到这个仓库，或没有权限',
  gh_network: '电脑连不上 GitHub', gh_timeout: '连接 GitHub 超时', gh_failed: '提交没成功',
};
/** Short, fixed wording: raw gh output can name hosts or accounts and never reaches the phone. */
export const feedbackIssueReason = (error: unknown) => failureText[error instanceof FeedbackIssueError ? error.reason : 'gh_failed'];
function classify(stderr: string): IssueFailure {
  if (/Could not resolve to a Repository|repository not found|HTTP 404/i.test(stderr)) return 'gh_repo';
  if (/auth login|not logged|authentication|HTTP 40[13]|permission|token/i.test(stderr)) return 'gh_auth';
  if (/could not resolve host|dial tcp|connection (?:refused|reset)|time(?:d)? ?out|TLS|proxy|EOF|network/i.test(stderr)) return 'gh_network';
  return 'gh_failed';
}
export const feedbackIssueLabel = 'from-phone';

/** Runs gh with fixed arguments; the body goes through stdin, never the command line. */
export function ghIssueClient(options: { gh?: string; proxy?: string; timeoutMs?: number } = {}): FeedbackIssueClient {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1',
    PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')].filter(Boolean).join(path.delimiter),
    ...(options.proxy ? { HTTPS_PROXY: options.proxy, https_proxy: options.proxy } : {}) };
  const run = (args: string[], input = '') => new Promise<string>((resolve, reject) => {
    const child = spawn(options.gh ?? 'gh', args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.timeoutMs ?? 60_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { if (out.length < 8_000_000) out += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { if (err.length < 16_000) err += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(new FeedbackIssueError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'gh_missing' : 'gh_failed')); });
    child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new FeedbackIssueError(timedOut ? 'gh_timeout' : classify(err))); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
  });
  const listed = z.array(z.object({ number: z.number().int().positive(), body: z.string() }).passthrough());
  const labelled = new Set<string>();
  return {
    async find(repo, marker) {
      let issues: z.infer<typeof listed>;
      try { issues = listed.parse(JSON.parse(await run(['issue', 'list', '-R', repo, '--label', feedbackIssueLabel, '--state', 'all', '--limit', '200', '--json', 'number,body']))); }
      catch (error) { throw error instanceof FeedbackIssueError ? error : new FeedbackIssueError('gh_failed'); }
      return issues.find(issue => issue.body.includes(marker))?.number;
    },
    async create(repo, issue) {
      if (!labelled.has(repo)) {
        // Best effort: an existing label makes this fail, and a truly missing one fails the create below.
        await run(['label', 'create', feedbackIssueLabel, '-R', repo, '--color', '1d76db', '--description', 'MobiCodex 手机端「反馈问题」提交']).catch(() => {});
        labelled.add(repo);
      }
      const out = await run(['issue', 'create', '-R', repo, '--title', issue.title, '--body-file', '-', '--label', feedbackIssueLabel], issue.body);
      const match = /\/issues\/(\d+)\s*$/m.exec(out);
      if (!match) throw new FeedbackIssueError('gh_failed');
      return Number(match[1]);
    },
  };
}

/** Files receipts that chose a GitHub target; retries until filed or a person triages them. */
export function createFeedbackSubmitter(options: { store: FeedbackStore; targets: Map<string, FeedbackTarget>; client: FeedbackIssueClient; redact: FeedbackRedactor;
  firstSweepMs?: number; sweepMs?: number }) {
  const running = new Map<string, Promise<void>>();
  let stopped = false, first: NodeJS.Timeout | undefined, every: NodeJS.Timeout | undefined;
  async function submit(id: string) {
    const receipt = await options.store.get(id);
    if (!receipt?.target || (receipt.status.state !== 'received' && receipt.status.state !== 'retrying')) return;
    const target = options.targets.get(receipt.target);
    if (!target) { await options.store.transition(id, { state: 'retrying', reason: '电脑上的网关没有配置这个仓库' }); return; }
    try {
      const marker = feedbackIssueMarker(id), issue = renderFeedbackIssue(receipt, options.redact);
      // Always look first: a lost response or a crash after creating must not file the same feedback twice.
      const number = await options.client.find(target.repo, marker) ?? await options.client.create(target.repo, { title: issue.title, body: `${issue.body}\n\n${marker}\n` });
      await options.store.transition(id, { state: 'filed', issue: number, repo: target.repo });
    } catch (error) {
      if (!stopped) await options.store.transition(id, { state: 'retrying', reason: feedbackIssueReason(error) });
    }
  }
  function kick(id: string) {
    const current = running.get(id);
    if (current || stopped) return current ?? Promise.resolve();
    const run = submit(id).catch(() => {}).finally(() => running.delete(id));
    running.set(id, run); return run;
  }
  async function sweep() {
    if (stopped) return;
    for (const receipt of await options.store.pending().catch(() => [])) await kick(receipt.id);
  }
  return {
    kick, sweep,
    /** Waits for the submission up to `ms`, then returns the receipt as it stands. */
    async settle(id: string, ms: number) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([kick(id), new Promise<void>(resolve => { timer = setTimeout(resolve, ms); })]);
      clearTimeout(timer);
      const receipt = await options.store.get(id);
      return receipt && publicFeedbackReceipt(receipt);
    },
    start() {
      first = setTimeout(() => {
        void sweep(); every = setInterval(() => void sweep(), options.sweepMs ?? 600_000); every.unref();
      }, options.firstSweepMs ?? 5_000);
      first.unref();
    },
    async stop() { stopped = true; clearTimeout(first); clearInterval(every); await Promise.allSettled(running.values()); },
  };
}
