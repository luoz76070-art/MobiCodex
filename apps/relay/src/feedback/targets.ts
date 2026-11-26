import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { feedbackError, feedbackTargetId, githubRepoName } from './store.js';
import { FeedbackIssueError, type FeedbackRepoInfo, type FeedbackTarget } from './github.js';

/** Fixed (gateway.json) and added repos together. */
export const feedbackTargetLimit = 10;
export const feedbackTargetLabel = z.string().trim().min(1).max(40).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const addedSchema = z.object({ id: feedbackTargetId, repo: githubRepoName, label: feedbackTargetLabel, public: z.boolean(), addedAt: z.string().datetime() }).strict();
const fileSchema = z.object({ version: z.literal(1), repos: z.array(addedSchema).max(feedbackTargetLimit) }).strict();
type Added = z.infer<typeof addedSchema>;
export type ListedFeedbackTarget = FeedbackTarget & { removable: boolean };
export type FeedbackRepoLookup = (repo: string) => Promise<FeedbackRepoInfo>;

/** Accepts `owner/name`, a github.com link (extra path is ignored) or an SSH remote. */
export function normalizeFeedbackRepo(value: unknown): string {
  if (typeof value !== 'string') throw feedbackError('feedback_repo_invalid', 400);
  const text = value.trim();
  const link = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s?#]+)\/([^/\s?#]+)/iu.exec(text) ?? /^git@github\.com:([^/\s]+)\/([^/\s]+)$/iu.exec(text);
  const [owner, name] = link ? [link[1], link[2]] : text.split('/').length === 2 ? text.split('/') : ['', ''];
  const repo = `${owner}/${name.replace(/\.git$/iu, '')}`;
  if (!githubRepoName.safeParse(repo).success || repo.split('/').some(part => /^\.+$/u.test(part))) throw feedbackError('feedback_repo_invalid', 400);
  return repo;
}

/** What the gh lookup found that rules the repo out; GitHub's own wording never reaches the phone. */
const lookupFailure: Record<FeedbackIssueError['reason'], [string, number]> = {
  gh_missing: ['feedback_gh_missing', 503], gh_auth: ['feedback_gh_auth', 503], gh_repo: ['feedback_repo_not_found', 409],
  gh_network: ['feedback_gh_network', 503], gh_timeout: ['feedback_gh_timeout', 503], gh_failed: ['feedback_gh_failed', 503],
};
/** Filing adds the `from-phone` label, and finding an earlier attempt relies on it, so read access is not enough. */
const labelPermissions = new Set(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE']);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Repos the phone may file to: fixed ones from gateway.json plus ones added from the phone or the CLI.
 * Added repos live in this computer's data directory only, so a fresh install offers none.
 * Read afresh on every use, so the CLI and a running gateway see each other's changes at once.
 */
export class FeedbackTargets {
  readonly file: string;
  private writes: Promise<unknown> = Promise.resolve();
  constructor(private dataDirectory: string, private fixed: FeedbackTarget[] = [], private now = () => new Date()) {
    this.file = path.join(dataDirectory, 'feedback-targets.json');
  }
  private async added(): Promise<Added[]> {
    let raw: string;
    try {
      const stat = await fs.lstat(this.file);
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('not a private file');
      raw = await fs.readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw feedbackError('feedback_targets_unavailable');
    }
    try { return fileSchema.parse(JSON.parse(raw)).repos; } catch { throw feedbackError('feedback_targets_unavailable'); }
  }
  async list(): Promise<ListedFeedbackTarget[]> {
    const added = await this.added(), fixedIds = new Set(this.fixed.map(target => target.id));
    return [...this.fixed.map(target => ({ ...target, removable: false })),
      ...added.filter(target => !fixedIds.has(target.id)).map(({ addedAt: _addedAt, ...target }) => ({ ...target, removable: true }))];
  }
  async get(id: string): Promise<FeedbackTarget | undefined> {
    const found = (await this.list()).find(target => target.id === id);
    return found && { id: found.id, repo: found.repo, label: found.label, public: found.public };
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.writes.then(work); this.writes = run.catch(() => undefined); return run;
  }
  private static vacancy(targets: ListedFeedbackTarget[], repo: string) {
    if (targets.some(target => same(target.repo, repo))) throw feedbackError('feedback_target_exists', 409);
    if (targets.length >= feedbackTargetLimit) throw feedbackError('feedback_target_limit', 409);
  }
  /** Checks the repo with gh first: it must exist, take issues and let this account label them. */
  async add(input: { repo: unknown; label?: unknown }, lookup: FeedbackRepoLookup): Promise<ListedFeedbackTarget> {
    const repo = normalizeFeedbackRepo(input.repo);
    const named = input.label === undefined || (typeof input.label === 'string' && !input.label.trim()) ? undefined : feedbackTargetLabel.safeParse(input.label);
    if (named && !named.success) throw feedbackError('feedback_label_invalid', 400);
    FeedbackTargets.vacancy(await this.list(), repo);
    let info: FeedbackRepoInfo;
    try { info = await lookup(repo); }
    catch (error) {
      const [code, status] = lookupFailure[error instanceof FeedbackIssueError ? error.reason : 'gh_failed'];
      throw feedbackError(code, status);
    }
    // A renamed repo answers with its current name, which is what gets saved.
    if (!githubRepoName.safeParse(info.repo).success) throw feedbackError('feedback_gh_failed');
    if (!info.issues) throw feedbackError('feedback_repo_issues_disabled', 409);
    if (!labelPermissions.has(info.permission)) throw feedbackError('feedback_repo_permission', 409);
    return this.serial(async () => {
      const targets = await this.list(), added = await this.added();
      FeedbackTargets.vacancy(targets, info.repo);
      const taken = new Set(targets.map(target => target.id));
      const base = info.repo.split('/')[1].toLowerCase().replace(/[^a-z0-9-]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 36) || 'repo';
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      const entry: Added = { id, repo: info.repo, label: named?.data ?? info.repo.split('/')[1].slice(0, 40), public: info.public, addedAt: this.now().toISOString() };
      await this.write([...added, entry]);
      return { id, repo: entry.repo, label: entry.label, public: entry.public, removable: true };
    });
  }
  /** Feedback already filed keeps its issue link; feedback still waiting for this repo says it is gone. */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      if (this.fixed.some(target => target.id === id)) throw feedbackError('feedback_target_fixed', 409);
      const added = await this.added();
      if (!added.some(target => target.id === id)) throw feedbackError('feedback_unknown_target', 404);
      await this.write(added.filter(target => target.id !== id));
    });
  }
  private async write(repos: Added[]) {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(this.dataDirectory, { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, `${JSON.stringify({ version: 1, repos }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await fs.rename(temporary, this.file);
    } catch { throw feedbackError('feedback_targets_unavailable'); }
    finally { await fs.rm(temporary, { force: true }); }
  }
}
