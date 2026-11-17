import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBackLayer } from "../../shared/BackLayers";
import { maxQuickCommandLength } from "./model";
import "./quick-commands.css";

export function QuickCommandEditor({ initial, onSave, onDelete, onClose }: {
  initial: string; onSave: (text: string) => void; onDelete?: () => void; onClose: () => void;
}) {
  const [text, setText] = useState(initial), [error, setError] = useState("");
  const panel = useRef<HTMLDivElement>(null);
  useBackLayer(true, onClose, 216);
  useEffect(() => {
    const previous = document.activeElement;
    const input = panel.current?.querySelector("textarea");
    input?.focus(); input?.setSelectionRange(input.value.length, input.value.length);
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  function act(action: () => void) {
    try { action(); onClose(); } catch (reason) { setError(reason instanceof Error ? reason.message : "常用指令保存失败"); }
  }
  return createPortal(<div className="quick-command-scrim" onClick={onClose}>
    <div className="quick-command-editor" ref={panel} role="dialog" aria-modal="true" aria-label={onDelete ? "编辑常用指令" : "添加常用指令"}
      onClick={event => event.stopPropagation()} onKeyDown={event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); }
        if (event.key === "Tab") {
          const items = [...(panel.current?.querySelectorAll<HTMLElement>("textarea, button:not(:disabled)") ?? [])];
          const index = items.indexOf(document.activeElement as HTMLElement);
          event.preventDefault(); items[(index + (event.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
        }
      }}>
      <h3>{onDelete ? "编辑常用指令" : "添加常用指令"}</h3>
      <label>指令文字<textarea value={text} maxLength={maxQuickCommandLength} rows={4} onChange={event => setText(event.target.value)} /></label>
      <p className="setting-description">最多 {maxQuickCommandLength} 字；只填入草稿，不会自动发送。</p>
      {error && <p role="alert">{error}</p>}
      <div className="quick-command-actions">
        {onDelete && <button type="button" onClick={() => act(onDelete)}>删除</button>}
        <button type="button" onClick={onClose}>取消</button>
        <button type="button" disabled={!text.trim()} onClick={() => act(() => onSave(text.trim()))}>保存</button>
      </div>
    </div>
  </div>, document.body);
}
