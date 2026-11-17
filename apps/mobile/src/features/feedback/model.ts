import { fileToBase64 } from '../chat/attachments';
import { redactFeedbackError } from './lastError';
export type FeedbackContext = { version: string; versionCode: number; page: string; agentId: string; sessionId: string; lastError: string; model: string; os: string };
export type FeedbackInput = { clientId: string; text: string; context: FeedbackContext; screenshot?: { mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; dataBase64: string } };
export type FeedbackStatus = { state: 'received' } | { state: 'filed'; issue: number } | { state: 'fixed'; version: string } | { state: 'dismissed'; reason: string };
export type FeedbackItem = Omit<FeedbackInput, 'screenshot'> & { id: string; createdAt: string; status: FeedbackStatus; screenshot?: { mimeType: string; size: number } };
export type OpenFeedbackOptions = { text?: string; screenshot?: File; context?: Partial<FeedbackContext> };
export const feedbackOpenEvent = 'mobicodex-open-feedback';
/** Reused by settings now, and by message/share actions in the next PR. Never sends automatically. */
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
export function feedbackStatusText(status: FeedbackStatus): string {
  switch (status.state) {
    case 'received': return '已收到';
    case 'filed': return `已提交 #${status.issue}`;
    case 'fixed': return `已修复，在 ${status.version}`;
    case 'dismissed': return `未采纳：${status.reason}`;
  }
}
export function validateFeedbackInput(input: FeedbackInput) {
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(input.clientId) || !input.text.trim() || input.text.length > 2000) throw new Error('请填写问题描述，最多 2000 字。');
  if (input.screenshot && (!['image/png', 'image/jpeg', 'image/webp'].includes(input.screenshot.mimeType) || input.screenshot.dataBase64.length > 4 * Math.ceil(5 * 1024 * 1024 / 3))) throw new Error('截图仅支持 5MiB 以内的 PNG、JPEG、WebP。');
}
export async function feedbackScreenshot(file: File): Promise<FeedbackInput['screenshot']> {
  if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('截图最多 5MiB。');
  const b = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const mimeType = b.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i) => b[i] === v) ? 'image/png'
    : b[0] === 255 && b[1] === 216 && b[2] === 255 ? 'image/jpeg'
      : new TextDecoder().decode(b.slice(0,4)) === 'RIFF' && new TextDecoder().decode(b.slice(8,12)) === 'WEBP' ? 'image/webp' : null;
  if (!mimeType) throw new Error('请选择有效的 PNG、JPEG、WebP 截图。');
  return { mimeType, dataBase64: await fileToBase64(file) };
}
