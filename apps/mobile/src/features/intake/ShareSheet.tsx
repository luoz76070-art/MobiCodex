import { useBackLayer } from "../../shared/BackLayers";
import { useEffect, useRef, useState } from "react";
import { Capacitor } from "@capacitor/core";
import { shareText, type SharePayload } from "./plugin";
import { shareFeedbackOptions } from "./feedback";
import { openFeedback } from "../feedback/model";

export type ShareAction = "current" | "new-task" | "capture";
export function ShareSheet({ payload, currentTitle, onChoose, onCancel }: {
  payload: SharePayload; currentTitle: string | null;
  onChoose: (action: ShareAction, signal: AbortSignal) => Promise<void>; onCancel: () => void;
}) {
  const sheet = useRef<HTMLElement | null>(null), action = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  useEffect(() => {
    const previous = document.activeElement;
    sheet.current?.focus();
    return () => {
      action.current?.abort();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [onCancel]);
  function cancel() { action.current?.abort(); onCancel(); }
  useBackLayer(true, cancel, 220);
  async function choose(value: ShareAction | "feedback") {
    if (action.current) return;
    const controller = new AbortController(); action.current = controller; setBusy(true); setError("");
    try {
      if (value === "feedback") {
        const options = await shareFeedbackOptions(payload, controller.signal);
        if (!controller.signal.aborted) { onCancel(); openFeedback(options); }
      } else await onChoose(value, controller.signal);
    }
    catch (caught) { if (!controller.signal.aborted) setError(caught instanceof Error ? caught.message : "分享内容未能读取，请重试。"); }
    finally { if (!controller.signal.aborted) { action.current = null; setBusy(false); } }
  }
  return <div className="voice-scrim intake-scrim" onClick={event => { if (event.target === event.currentTarget) cancel(); }}>
    <section ref={sheet} tabIndex={-1} className="voice-sheet intake-sheet" role="dialog" aria-modal="true" aria-labelledby="intake-title" onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); cancel(); }
      if (event.key !== "Tab") return;
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
      const first = buttons[0], last = buttons.at(-1);
      if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet.current)) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === sheet.current)) { event.preventDefault(); first?.focus(); }
    }}>
      <header><strong id="intake-title">分享到 MobiCodex</strong></header>
      {shareText(payload) && <p className="intake-text">{shareText(payload)}</p>}
      {payload.images.length > 0 && <div className="intake-images">{payload.images.map((image, index) => <img key={index} src={Capacitor.convertFileSrc(image.path)} alt={image.name} />)}</div>}
      {payload.skipped > 0 && <p>另有 {payload.skipped} 项没收下（只收 9 张以内的图片，单张不超过 25MB）</p>}
      <p>内容只会填进草稿和附件，由你确认后发送。</p>
      <div className="intake-actions">
        <button type="button" className="action-button" disabled={busy || currentTitle === null} onClick={() => void choose("current")}>{currentTitle === null ? "发给当前线程" : `发给当前线程「${currentTitle}」`}</button>
        {currentTitle === null && <p>请先打开一个线程</p>}
        <button type="button" className="action-button" disabled={busy} onClick={() => void choose("new-task")}>开新任务</button>
        <button type="button" className="action-button" disabled={busy} onClick={() => void choose("capture")}>存成事项卡</button>
        <button type="button" className="action-button" disabled={busy} onClick={() => void choose("feedback")}>反馈问题</button>
        <button type="button" className="action-button" onClick={cancel}>取消</button>
      </div>
      {busy && <p role="status">正在准备草稿和附件…</p>}{error && <p role="alert">{error}</p>}
    </section>
  </div>;
}
