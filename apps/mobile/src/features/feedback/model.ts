import { redactFeedbackError } from './lastError';
export type FeedbackContext = { version: string; versionCode: number; page: string; agentId: string; sessionId: string; lastError: string; model: string; os: string };
/** `target` names a GitHub repo the computer offers; without it the feedback stays in the computer's inbox. */
export type FeedbackInput = { clientId: string; text: string; context: FeedbackContext; target?: string };
export type FeedbackStatus = { state: 'received' } | { state: 'filed'; issue: number; repo?: string } | { state: 'fixed'; version: string }
  | { state: 'dismissed'; reason: string } | { state: 'retrying'; reason: string };
/** Entries from older builds may still mention a screenshot kept on the computer. */
export type FeedbackItem = FeedbackInput & { id: string; createdAt: string; status: FeedbackStatus; screenshot?: { mimeType: string; size: number } };
export type FeedbackTarget = { id: string; label: string; repo: string; public: boolean };
export type FeedbackPreview = { target: FeedbackTarget; title: string; body: string };
export type OpenFeedbackOptions = { text?: string; context?: Partial<FeedbackContext>; notice?: string };
export const feedbackOpenEvent = 'mobicodex-open-feedback';
/** Reused by settings, message and share actions. Never sends automatically. */
export function openFeedback(options: OpenFeedbackOptions = {}) { window.dispatchEvent(new CustomEvent(feedbackOpenEvent, { detail: options })); }
const clip = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : '';
export function parseFeedbackUserAgent(ua: string): { model: string; os: string } {
  const android = /Android\s+([\d.]+)(?:;\s*([^)]*))?/i.exec(ua);
  if (android) {
    const pieces = (android[2] ?? '').split(';').map(part => part.trim()).filter(part => part && !/^(?:wv|[a-z]{2}(?:[-_][a-z]{2})?)$/i.test(part));
    return { os: `Android ${android[1]}`.slice(0, 120), model: (pieces.at(-1) ?? '').split(/\s+Build\//i)[0].slice(0, 120) || '未知机型' };
  }
  const ios = /(?:iPhone|CPU) OS ([\d_]+)/i.exec(ua);
  if (ios) return { model: /iPad/i.test(ua) ? 'iPad' : 'iPhone', os: `iOS ${ios[1].replaceAll('_', '.')}` };
  return { model: '浏览器（机型未知）', os: /Windows NT ([\d.]+)/i.test(ua) ? `Windows ${/Windows NT ([\d.]+)/i.exec(ua)![1]}`
    : /Mac OS X ([\d_]+)/i.test(ua) ? `macOS ${/Mac OS X ([\d_]+)/i.exec(ua)![1].replaceAll('_', '.')}` : /Linux/i.test(ua) ? 'Linux' : '未知系统' };
}
export function collectFeedbackContext(input: Partial<FeedbackContext>, ua: string): FeedbackContext {
  const device = parseFeedbackUserAgent(ua);
  return { version: clip(input.version, 80), versionCode: Number.isSafeInteger(input.versionCode) && input.versionCode! >= 0 ? input.versionCode! : 0,
    page: clip(input.page, 80), agentId: clip(input.agentId, 64), sessionId: clip(input.sessionId, 160),
    lastError: redactFeedbackError(input.lastError ?? ''), model: clip(input.model ?? device.model, 120), os: clip(input.os ?? device.os, 120) };
}
export function feedbackStatusText(status: FeedbackStatus, target?: string): string {
  switch (status.state) {
    case 'received': return target ? '正在提交到 GitHub' : '已收到';
    case 'retrying': return `还没提交上，电脑会自动重试：${status.reason}`;
    case 'filed': return `已提交 #${status.issue}`;
    case 'fixed': return `已修复，在 ${status.version}`;
    case 'dismissed': return `未采纳：${status.reason}`;
  }
}
/** Only a filed issue with a well-formed repo becomes a link. */
export function feedbackIssueUrl(status: FeedbackStatus): string {
  return status.state === 'filed' && status.repo && /^[\w.-]+\/[\w.-]+$/.test(status.repo) ? `https://github.com/${status.repo}/issues/${status.issue}` : '';
}
export function validateFeedbackInput(input: FeedbackInput) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.clientId) || !input.text.trim() || input.text.length > 2000) throw new Error('请填写问题描述，最多 2000 字。');
  if (input.target !== undefined && !/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.target)) throw new Error('要提交到的仓库无效，请重新选择。');
}
const targetKey = (scope: string) => `mobicodexFeedbackTarget:${scope}`;
/** The last choice per paired computer; '' means "keep it on the computer". */
export function rememberedFeedbackTarget(scope: string): string | null {
  try { return window.localStorage?.getItem(targetKey(scope)) ?? null; } catch { return null; }
}
export function rememberFeedbackTarget(scope: string, target: string) {
  try { window.localStorage?.setItem(targetKey(scope), target); } catch { /* Not remembering is harmless. */ }
}
/** A remembered repo wins while the computer still offers it; otherwise the first one offered. */
export function chooseFeedbackTarget(targets: FeedbackTarget[], remembered: string | null): string {
  if (remembered === '' || (remembered && targets.some(target => target.id === remembered))) return remembered;
  return targets[0]?.id ?? '';
}
