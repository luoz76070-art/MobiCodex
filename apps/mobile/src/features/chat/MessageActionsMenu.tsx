import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useBackLayer } from "../../shared/BackLayers";
import "./message-actions.css";

export function MessageActionsMenu({ onClose, onCopy, onFeedback }: {
  onClose: () => void; onCopy: () => void; onFeedback: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  useEffect(() => { menu.current?.querySelector<HTMLButtonElement>("button")?.focus(); }, []);
  useBackLayer(true, onClose, 212);
  return createPortal(<div className="message-menu-scrim" onClick={event => {
    event.stopPropagation(); if (event.target === event.currentTarget) onClose();
  }} onPointerDown={event => event.stopPropagation()}>
    <div ref={menu} className="message-menu" role="menu" aria-label="消息操作" onKeyDown={event => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      let next: number;
      if (event.key === "ArrowDown" || (event.key === "Tab" && !event.shiftKey)) next = (index + 1) % buttons.length;
      else if (event.key === "ArrowUp" || event.key === "Tab") next = (index - 1 + buttons.length) % buttons.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = buttons.length - 1;
      else return;
      event.preventDefault(); buttons[next]?.focus();
    }}>
      <button type="button" role="menuitem" onClick={() => { onClose(); onCopy(); }}>复制</button>
      <button type="button" role="menuitem" onClick={() => { onClose(); onFeedback(); }}>反馈这条</button>
      <button type="button" role="menuitem" onClick={onClose}>取消</button>
    </div>
  </div>, document.body);
}
