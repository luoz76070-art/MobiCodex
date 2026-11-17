import { useEffect, useRef, useState } from "react";
import { loadQuickCommands, saveQuickCommands } from "./model";
import { useQuickCommands } from "./useQuickCommands";
import { QuickCommandEditor } from "./QuickCommandEditor";
import "./quick-commands.css";

function QuickCommand({ text, disabled, onChoose, onEdit, onPress }: {
  text: string; disabled: boolean; onChoose: () => void; onEdit: () => void; onPress: (cancel: () => void) => void;
}) {
  const press = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  function cancel() { if (press.current) clearTimeout(press.current.timer); press.current = null; }
  useEffect(() => () => { if (press.current) clearTimeout(press.current.timer); }, [disabled, text]);
  return <button type="button" className="quick-command-chip" disabled={disabled} aria-label={`常用指令：${text}`} aria-haspopup="dialog" title={text}
    onPointerDown={event => {
      cancel(); suppressClick.current = false;
      onPress(() => { cancel(); suppressClick.current = true; });
      if (disabled || event.pointerType === "mouse" || !event.isPrimary) return;
      press.current = { x: event.clientX, y: event.clientY, timer: setTimeout(() => {
        cancel(); suppressClick.current = true; onEdit();
      }, 550) };
    }}
    onPointerMove={event => {
      if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 10) {
        cancel(); suppressClick.current = true;
      }
    }}
    onPointerUp={cancel} onPointerCancel={() => { cancel(); suppressClick.current = true; }}
    onPointerLeave={() => { if (press.current) { cancel(); suppressClick.current = true; } }} onBlur={cancel}
    onContextMenu={event => { event.preventDefault(); cancel(); if (!disabled && !suppressClick.current) { suppressClick.current = true; onEdit(); } }}
    onKeyDown={event => {
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault(); cancel(); if (!disabled) onEdit();
      } else if (event.key === "Enter" || event.key === " ") suppressClick.current = false;
    }}
    onClick={() => { if (!disabled && !suppressClick.current) onChoose(); }}>{text}</button>;
}

export function QuickCommands({ disabled, onChoose }: { disabled: boolean; onChoose: (text: string) => void }) {
  const commands = useQuickCommands();
  const [editing, setEditing] = useState<number | null>(null);
  const cancelPress = useRef<(() => void) | null>(null);
  if (!commands.length) return null;
  return <>
    <div className="quick-commands" role="group" aria-label="常用指令" onScrollCapture={() => cancelPress.current?.()}>
      {commands.map((text, index) => <QuickCommand key={`${index}:${text}`} text={text} disabled={disabled} onChoose={() => onChoose(text)} onEdit={() => setEditing(index)} onPress={cancel => { cancelPress.current = cancel; }} />)}
    </div>
    {!disabled && editing !== null && commands[editing] !== undefined && <QuickCommandEditor key={`${editing}:${commands[editing]}`} initial={commands[editing]} onClose={() => setEditing(null)}
      onSave={text => saveQuickCommands(loadQuickCommands().map((command, index) => index === editing ? text : command))}
      onDelete={() => saveQuickCommands(loadQuickCommands().filter((_, index) => index !== editing))} />}
  </>;
}
