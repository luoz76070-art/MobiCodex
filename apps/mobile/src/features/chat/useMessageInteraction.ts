import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type FocusEvent, type KeyboardEvent } from "react";

const interactive = "a, button, input, textarea, select, summary, [role=button]";
function usesNativeSelection(target: EventTarget) { return target instanceof Element && Boolean(target.closest("pre, code, .code-block, table")); }
function isInteractive(target: EventTarget) { return target instanceof Element && Boolean(target.closest(interactive)); }

/** Only a stationary touch/pen press opens actions; selection and scrolling remain native. */
export function useMessageInteraction(identity: string, onCopy: () => void | boolean | Promise<void | boolean>) {
  const [revealed, setRevealed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const origin = useRef<HTMLElement | null>(null);
  const [feedback, setFeedback] = useState("");
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const generation = useRef(0);
  const copying = useRef(false);
  const held = useRef(false);
  function cancelPress() { if (press.current) clearTimeout(press.current.timer); press.current = null; }
  function closeMenu() { setMenuOpen(false); origin.current?.focus(); }
  useEffect(() => {
    return () => { generation.current++; cancelPress(); };
  }, [identity]);
  async function copy() {
    if (copying.current) return;
    copying.current = true;
    const current = generation.current;
    setFeedback("");
    try {
      const copied = await onCopy();
      if (current === generation.current) setFeedback(copied === false ? "复制失败，请重试" : "已复制");
    } catch {
      if (current === generation.current) setFeedback("复制失败，请重试");
    } finally { copying.current = false; }
  }
  return {
    revealed, feedback, copy, menuOpen, closeMenu,
    handlers: {
      onFocus: () => setRevealed(true),
      onBlur: (event: FocusEvent<HTMLElement>) => { cancelPress(); if (!event.currentTarget.contains(event.relatedTarget)) { setRevealed(false); setFeedback(""); } },
      onClick: (event: MouseEvent<HTMLElement>) => { if (!isInteractive(event.target) && !held.current) setRevealed(true); held.current = false; },
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10") || event.key === "Enter" || event.key === " ") {
          event.preventDefault(); origin.current = event.currentTarget; setMenuOpen(true);
        }
      },
      onPointerDown: (event: PointerEvent<HTMLElement>) => {
        cancelPress(); held.current = false;
        if (!event.isPrimary || event.pointerType === "mouse" || isInteractive(event.target) || usesNativeSelection(event.target)) return;
        origin.current = event.currentTarget;
        press.current = { x: event.clientX, y: event.clientY, timer: setTimeout(() => {
          press.current = null;
          if (window.getSelection()?.toString()) return;
          held.current = true; setRevealed(true); setMenuOpen(true);
        }, 550) };
      },
      onPointerMove: (event: PointerEvent<HTMLElement>) => {
        if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) cancelPress();
      },
      onPointerUp: cancelPress,
      onPointerCancel: cancelPress,
      onPointerLeave: cancelPress,
      onContextMenu: (event: MouseEvent<HTMLElement>) => { if (!isInteractive(event.target) && !usesNativeSelection(event.target) && (press.current || held.current)) event.preventDefault(); },
    },
  };
}
