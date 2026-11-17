import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { Navigation } from '../../app/navigation';
import { appVersionName, appVersionCode } from '../../app/config';
import { isKelivoHost } from '../product/host';
import { productVersionLabel, productVersionCode } from '../product/identity';
import { useBackLayer } from '../../shared/BackLayers';
import { apiGet, apiPost, buildUrl } from '../connection/http';
import { relayAuthorization } from '../connection/authorization';
import { VoiceInput } from '../voice/VoiceInput';
import { useCaptureVoice } from '../capture/useCaptureVoice';
import { collectFeedbackContext, feedbackOpenEvent, feedbackScreenshot, feedbackStatusText, validateFeedbackInput, type FeedbackContext, type FeedbackInput, type FeedbackItem, type OpenFeedbackOptions } from './model';
import { lastFeedbackError, observeFeedbackErrors } from './lastError';
import { createFeedbackSender, feedbackQueueStorage, type QueuedFeedback } from './queue';
import './feedback.css';

type Props = { scope: string; endpoint: string; token: string; navigation: Navigation; page: string };
export function FeedbackHost({ scope, endpoint, token, navigation, page }: Props) {
  const [opened, setOpened] = useState<{ options: OpenFeedbackOptions; context: FeedbackContext } | null>(null);
  const [queued, setQueued] = useState<QueuedFeedback[]>([]), [revision, setRevision] = useState(0), [storageError, setStorageError] = useState(''), [deliveryError, setDeliveryError] = useState('');
  const storage = useMemo(feedbackQueueStorage, []);
  useEffect(() => observeFeedbackErrors(scope, document.body, [token]), [scope, token]);
  useEffect(() => {
    const open = (event: Event) => {
      const options = (event as CustomEvent<OpenFeedbackOptions>).detail ?? {};
      setOpened({ options, context: collectFeedbackContext({ version: isKelivoHost ? productVersionLabel.replace(/^v/, '') : appVersionName,
        versionCode: isKelivoHost ? productVersionCode : appVersionCode, page, agentId: navigation.agentId ?? '', sessionId: navigation.sessionId ?? '',
        lastError: lastFeedbackError(scope), ...options.context }, navigator.userAgent) });
    };
    window.addEventListener(feedbackOpenEvent, open);
    return () => window.removeEventListener(feedbackOpenEvent, open);
  }, [scope, navigation, page]);
  useEffect(() => {
    const controller = new AbortController(), authorization = relayAuthorization(endpoint, token);
    const active = () => !controller.signal.aborted && !authorization.isRevoked() && Boolean(endpoint && token) && navigator.onLine !== false;
    const refresh = () => { void storage.list(scope).then(items => { if (!controller.signal.aborted) { setQueued(items); setStorageError(''); } }, () => { if (!controller.signal.aborted) setStorageError('反馈存储不可用，无法保存待发内容。'); }); };
    const instance = createFeedbackSender({ scope, storage, active, post: input => apiPost<FeedbackItem>(buildUrl(endpoint, '/api/feedback'), token, input, controller.signal),
      changed: () => { if (!controller.signal.aborted) { refresh(); setRevision(value => value + 1); } } });
    const resume = () => { refresh(); if (active() && !document.hidden) void instance.flush().then(() => { if (!controller.signal.aborted) setDeliveryError(''); }, error => {
      if (!controller.signal.aborted) setDeliveryError([400, 413, 422].includes((error as { status?: number }).status ?? 0)
        ? '电脑拒收了某条反馈的格式或截图，已保留原记录；请核对或联系电脑端处理。' : (error as { status?: number }).status === 429 ? '每台设备每小时最多 20 条，已保存，稍后自动补发。' : '尚未送达电脑，已保存，连接恢复后自动补发。');
    }); };
    const timer = window.setInterval(resume, 30_000);
    const detach = authorization.subscribe(() => controller.abort());
    window.addEventListener('mobicodex-feedback-retry', resume); window.addEventListener('online', resume); document.addEventListener('visibilitychange', resume); resume();
    return () => { detach(); controller.abort(); clearInterval(timer); window.removeEventListener('mobicodex-feedback-retry', resume); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume); };
  }, [scope, endpoint, token, storage]);
  async function submit(input: FeedbackInput) {
    validateFeedbackInput(input);
    await storage.add({ scope, input, createdAt: new Date().toISOString() });
    // Persistence is the acceptance boundary; a later refresh failure must not invite editing an already queued UUID.
    void storage.list(scope).then(setQueued).catch(() => {});
    window.dispatchEvent(new Event('mobicodex-feedback-retry'));
  }
  return opened && <FeedbackSheet scope={scope} endpoint={endpoint} token={token} options={opened.options} context={opened.context}
    queued={queued} revision={revision} storageError={storageError} deliveryError={deliveryError} submit={submit} close={() => setOpened(null)} />;
}

type SheetProps = Pick<Props, 'scope' | 'endpoint' | 'token'> & {
  options: OpenFeedbackOptions; context: FeedbackContext; queued: QueuedFeedback[]; revision: number; storageError: string; deliveryError?: string;
  submit: (input: FeedbackInput) => Promise<void>; close: () => void;
};
export function FeedbackSheet({ scope, endpoint, token, options, context, queued, revision, storageError, deliveryError, submit, close }: SheetProps) {
  const [text, setText] = useState(options.text ?? ''), [screenshot, setScreenshot] = useState<File | undefined>(options.screenshot);
  const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false), lock = useRef(false), mounted = useRef(true);
  const [notice, setNotice] = useState(''), [error, setError] = useState(''), [listError, setListError] = useState(''), [items, setItems] = useState<FeedbackItem[]>([]);
  const sheet = useRef<HTMLElement>(null), fileInput = useRef<HTMLInputElement>(null);
  const recovery = useCaptureVoice(scope, endpoint, token, value => setText(current => current ? `${current}\n${value}` : value));
  useBackLayer(true, () => { if (!lock.current) close(); }, 215);
  useEffect(() => {
    mounted.current = true; const previous = document.activeElement; sheet.current?.focus();
    return () => { mounted.current = false; if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      if (!endpoint || !token || navigator.onLine === false) { setListError('连接电脑后可查看处理状态。'); return; }
      try {
        const result = await apiGet<{ items: FeedbackItem[] }>(buildUrl(endpoint, '/api/feedback'), token, controller.signal);
        if (!controller.signal.aborted) { setItems(result.items); setListError(''); }
      } catch { if (!controller.signal.aborted) setListError('暂时无法读取处理状态，已保留待发反馈。'); }
    }
    const visible = () => { if (!document.hidden) void refresh(); };
    const timer = window.setInterval(visible, 30_000);
    window.addEventListener('mobicodex-feedback-retry', visible); window.addEventListener('online', visible); document.addEventListener('visibilitychange', visible); void refresh();
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener('mobicodex-feedback-retry', visible); window.removeEventListener('online', visible); document.removeEventListener('visibilitychange', visible); };
  }, [endpoint, token, revision]);
  async function send() {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const input: FeedbackInput = { clientId, text: text.trim(), context, ...(screenshot ? { screenshot: await feedbackScreenshot(screenshot) } : {}) };
      validateFeedbackInput(input); await submit(input);
      if (mounted.current) { setText(''); setScreenshot(undefined); setClientId(crypto.randomUUID()); setNotice('反馈已保存，送达与处理进度见下方。离线时会自动补发。'); }
    } catch (caught) { if (mounted.current) setError(caught instanceof Error ? caught.message : '未能保存反馈，请保持面板打开后重试。'); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  const fields: Array<[keyof FeedbackContext, string]> = [['version', '版本'], ['versionCode', '版本号'], ['page', '页面'], ['agentId', 'Agent'], ['sessionId', '会话'], ['lastError', '最近出错原因'], ['model', '机型'], ['os', '系统']];
  return createPortal(<div className="voice-scrim feedback-scrim" onClick={event => { if (event.target === event.currentTarget && !busy) close(); }}>
    <section ref={sheet} className="voice-sheet feedback-sheet" role="dialog" aria-modal="true" aria-label="反馈问题" tabIndex={-1} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) close(); }
      if (event.key === 'Tab') {
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled), input:not(:disabled)')], first = controls[0], last = controls.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === sheet.current)) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header><strong>反馈问题</strong><button type="button" className="icon-button" aria-label="关闭反馈" disabled={busy} onClick={close}><X size={18} /></button></header>
      <p className="setting-description">内容先存到电脑的本地收件箱，不会直接发布到 GitHub。请检查文字和截图中是否有个人信息。</p>
      <label>一句话描述<textarea aria-label="问题描述" value={text} maxLength={2000} rows={3} disabled={busy} onChange={event => setText(event.target.value)} /></label>
      {!busy && <VoiceInput endpoint={endpoint} token={token} draft={text} onDraft={setText} scope={scope} thread={`feedback:${clientId}`} recovery={recovery} capture />}
      <label>附一张截图（可选，最多 5MiB）<input ref={fileInput} key={clientId} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={event => { setScreenshot(event.target.files?.[0]); setError(''); }} /></label>
      {screenshot && <p>{screenshot.name}<button type="button" className="text-button" disabled={busy} onClick={() => { setScreenshot(undefined); if (fileInput.current) fileInput.current.value = ''; }}>移除截图</button></p>}
      <details open><summary>自动附带的信息</summary><dl className="feedback-context">{fields.map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{String(context[key]) || '无'}</dd></div>)}</dl></details>
      <button type="button" className="action-button" disabled={busy || !text.trim() || text.length > 2000} onClick={() => void send()}>{busy ? '正在保存…' : '提交反馈'}</button>
      {notice && <p role="status">{notice}</p>}{(error || storageError) && <p role="alert">{error || storageError}</p>}
      <section aria-label="我的反馈"><h3>我的反馈</h3><button type="button" className="text-button" onClick={() => window.dispatchEvent(new Event('mobicodex-feedback-retry'))}>刷新状态 / 重试补发</button>
        {listError && <p role="status">{listError}</p>}{queued.length > 0 && deliveryError && <p role="status">{deliveryError}</p>}
        {queued.filter(entry => !items.some(item => item.clientId === entry.input.clientId)).map(entry => <p key={entry.input.clientId}>{entry.input.text.slice(0, 80)} · 待发送（已保存在手机）</p>)}
        {items.map(item => <p key={item.id}>{item.text.slice(0, 80)} · {feedbackStatusText(item.status)}</p>)}
        {!queued.length && !items.length && !listError && <p>还没有反馈。</p>}
      </section>
    </section>
  </div>, document.body);
}
