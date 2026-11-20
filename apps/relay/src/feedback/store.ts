import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sanitizeCaptureImage } from '../capture/image.js';

export const feedbackImageBytes = 5 * 1024 * 1024;
const field = (max: number) => z.string().max(max);
export const feedbackTargetId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);
export const githubRepoName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/);
export const feedbackContextSchema = z.object({
  version: field(80), versionCode: z.number().int().nonnegative(), page: field(80),
  agentId: field(64), sessionId: field(160), lastError: field(200), model: field(120), os: field(120),
}).strict();
export const feedbackSchema = z.object({
  clientId: z.string().uuid().transform(value => value.toLowerCase()), text: z.string().trim().min(1).max(2000), context: feedbackContextSchema,
  screenshot: z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    dataBase64: z.string().min(4).max(4 * Math.ceil(feedbackImageBytes / 3)) }).strict().optional(),
  /** A configured GitHub target; without one the feedback stays in this inbox. */
  target: feedbackTargetId.optional(),
}).strict();
export const feedbackPreviewSchema = z.object({ text: feedbackSchema.shape.text, context: feedbackContextSchema, target: feedbackTargetId }).strict();
export const feedbackStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('received') }).strict(),
  z.object({ state: z.literal('filed'), issue: z.number().int().positive(), repo: githubRepoName.optional() }).strict(),
  z.object({ state: z.literal('fixed'), version: field(80).min(1) }).strict(),
  z.object({ state: z.literal('dismissed'), reason: field(200).min(1) }).strict(),
  /** Written by the gateway only: the GitHub submission failed and will be tried again. */
  z.object({ state: z.literal('retrying'), reason: field(200).min(1) }).strict(),
]);
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;
export type FeedbackContext = z.infer<typeof feedbackContextSchema>;
const receiptSchema = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/), owner: z.string().min(1).max(128),
  clientId: z.string().uuid(), text: z.string().max(2000), context: feedbackContextSchema,
  createdAt: z.string().datetime(), status: feedbackStatusSchema,
  screenshot: z.object({ mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']), size: z.number().int().positive().max(feedbackImageBytes) }).strict().optional(),
  target: feedbackTargetId.optional(),
}).strict();
type Receipt = z.infer<typeof receiptSchema>;
export type FeedbackReceipt = Receipt;
export const feedbackError = (code: string, statusCode = 503) => Object.assign(new Error(code), { statusCode });
export const publicFeedbackReceipt = ({ owner: _owner, ...receipt }: Receipt) => receipt;
/** Finished feedback (filed, fixed or dismissed) is removed this long after its last change (#59). */
export const feedbackRetentionMs = 7 * 24 * 3_600_000;
const waiting = (status: FeedbackStatus) => status.state === 'received' || status.state === 'retrying';
async function writePrivate(file: string, data: string | Buffer) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}

/** A single gateway owns the inbox. Read receipts afresh so human status edits are immediately visible. */
export class FeedbackStore {
  private writes: Promise<unknown> = Promise.resolve();
  readonly directory: string;
  constructor(dataDirectory: string, private now = Date.now) { this.directory = path.join(dataDirectory, 'feedback'); }
  private async prepare() {
    await fs.mkdir(path.dirname(this.directory), { recursive: true, mode: 0o700 });
    await fs.mkdir(this.directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(this.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw feedbackError('feedback_store_unavailable');
    await fs.chmod(this.directory, 0o700);
  }
  private async receipts() {
    await this.prepare();
    const receipts: Receipt[] = [];
    for (const name of await fs.readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = path.join(this.directory, name), stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) throw feedbackError('feedback_store_unavailable');
      let receipt: Receipt;
      try { receipt = receiptSchema.parse(JSON.parse(await fs.readFile(file, 'utf8'))); }
      catch { throw feedbackError('feedback_store_unavailable'); }
      if (`${receipt.id}.json` !== name) throw feedbackError('feedback_store_unavailable');
      receipts.push(receipt);
    }
    return receipts;
  }
  async list(owner: string, guard: () => void) {
    const entries = await this.receipts(); guard();
    return entries.filter(entry => entry.owner === owner).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(publicFeedbackReceipt);
  }
  save(raw: unknown, owner: string, guard: () => void) {
    const input = feedbackSchema.parse(raw);
    const run = this.writes.then(async () => {
      guard(); const entries = await this.receipts(); guard();
      const existing = entries.find(entry => entry.owner === owner && entry.clientId === input.clientId);
      if (existing) return publicFeedbackReceipt(existing); // A lost response must not consume quota or rewrite a human status edit.
      if (entries.filter(entry => entry.owner === owner && Date.parse(entry.createdAt) > this.now() - 3_600_000).length >= 20) throw feedbackError('feedback_rate_limited', 429);
      let image: ReturnType<typeof sanitizeCaptureImage> | undefined;
      if (input.screenshot) {
        const base64 = input.screenshot.dataBase64;
        if (base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw feedbackError('feedback_invalid_image', 400);
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.length > feedbackImageBytes) throw feedbackError('feedback_image_too_large', 413);
        if (bytes.toString('base64') !== base64) throw feedbackError('feedback_invalid_image', 400);
        try { image = sanitizeCaptureImage(bytes, input.screenshot.mimeType); }
        catch { throw feedbackError('feedback_invalid_image', 422); }
      }
      const id = createHash('sha256').update(JSON.stringify([owner, input.clientId])).digest('hex');
      const receipt: Receipt = { id, owner, clientId: input.clientId, text: input.text, context: input.context,
        createdAt: new Date(this.now()).toISOString(), status: { state: 'received' }, ...(input.target ? { target: input.target } : {}),
        ...(image ? { screenshot: { mimeType: image.mimeType, size: image.data.length } } : {}) };
      const temp = path.join(this.directory, `.tmp-${randomUUID()}`);
      const extension = image?.mimeType === 'image/jpeg' ? 'jpg' : image?.mimeType === 'image/webp' ? 'webp' : 'png';
      const imagePath = path.join(this.directory, `${id}.${extension}`);
      let committed = false, wroteImage = false;
      try {
        if (image) {
          // No receipt exists for this ID: replace only an orphan from an interrupted write.
          await fs.rm(imagePath, { force: true });
          wroteImage = true; await writePrivate(imagePath, image.data);
        }
        await writePrivate(temp, JSON.stringify(receipt, null, 2) + '\n');
        guard(); await fs.rename(temp, path.join(this.directory, `${id}.json`)); committed = true;
        return publicFeedbackReceipt(receipt);
      } finally {
        await fs.rm(temp, { force: true });
        if (wroteImage && !committed) await fs.rm(imagePath, { force: true });
      }
    });
    this.writes = run.catch(() => {}); return run;
  }
  /** Receipts that chose a GitHub target and are still waiting for the gateway to file them. */
  async pending() { return (await this.receipts()).filter(entry => entry.target && waiting(entry.status)); }
  async get(id: string) { return (await this.receipts()).find(entry => entry.id === id); }
  /** A status the gateway itself reached. A receipt a person already triaged is left alone. */
  transition(id: string, status: FeedbackStatus) {
    const run = this.writes.then(async () => {
      const current = (await this.receipts()).find(entry => entry.id === id);
      if (!current || !waiting(current.status)) return false;
      const temp = path.join(this.directory, `.tmp-${randomUUID()}`);
      try {
        await writePrivate(temp, JSON.stringify(receiptSchema.parse({ ...current, status }), null, 2) + '\n');
        await fs.rename(temp, path.join(this.directory, `${id}.json`));
        return true;
      } finally { await fs.rm(temp, { force: true }); }
    });
    this.writes = run.catch(() => {}); return run;
  }
  /** Removes finished receipts, and their screenshots, untouched for `maxAgeMs`. Waiting ones always stay. */
  prune(maxAgeMs = feedbackRetentionMs) {
    const run = this.writes.then(async () => {
      const cutoff = this.now() - maxAgeMs;
      let removed = 0;
      for (const entry of await this.receipts()) {
        if (waiting(entry.status)) continue;
        const file = path.join(this.directory, `${entry.id}.json`);
        // A status edit rewrites the file, so its modification time is the last change.
        if (Math.max(Date.parse(entry.createdAt), (await fs.lstat(file)).mtimeMs) > cutoff) continue;
        for (const extension of ['png', 'jpg', 'webp']) await fs.rm(path.join(this.directory, `${entry.id}.${extension}`), { force: true });
        await fs.rm(file, { force: true });
        removed++;
      }
      return removed;
    });
    this.writes = run.catch(() => {}); return run;
  }
  async drain() { await this.writes; }
}
