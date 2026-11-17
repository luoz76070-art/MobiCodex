import { useEffect, useRef, useState } from "react";
import type { AgentModel, AgentPermissionMode, AgentSessionSettings } from "./types";

type Settings = AgentSessionSettings & { models: AgentModel[] };
const modes: { value: AgentPermissionMode; label: string }[] = [
  { value: "default", label: "默认 · 需要时审批" }, { value: "plan", label: "计划 · 先探索和规划" }, { value: "acceptEdits", label: "接受编辑 · 自动接受文件编辑" },
];

/** Shared Agent controls, offered only when the snapshot advertises an owned process. */
export function AgentSessionControls({ settings, disabled, load, onMode, onModel }: {
  settings: AgentSessionSettings; disabled: boolean; load: (signal: AbortSignal) => Promise<Settings>;
  onMode: (mode: AgentPermissionMode) => Promise<boolean>; onModel: (model: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false), [catalog, setCatalog] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [mode, setMode] = useState(settings.permissionMode), [model, setModel] = useState(settings.model ?? "");
  const [saving, setSaving] = useState(false), lock = useRef(false), controller = useRef<AbortController | null>(null), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; controller.current?.abort(); }; }, []);
  const locked = disabled || loading || saving;
  async function refresh() {
    if (!alive.current) return;
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setLoading(true); setError("");
    try {
      const next = await load(current.signal);
      if (current.signal.aborted) return;
      setCatalog(next); setMode(next.permissionMode); setModel(next.models.some(item => item.value === next.model) ? next.model! : "");
    } catch { if (!current.signal.aborted) { setCatalog(null); setError("无法读取当前设置，请重新打开后重试。"); } }
    finally { if (!current.signal.aborted) setLoading(false); }
  }
  async function save(change: () => Promise<boolean>) {
    if (locked || lock.current) return;
    lock.current = true; setSaving(true); setError("");
    try { if (await change() && alive.current && !controller.current?.signal.aborted) await refresh(); }
    finally { lock.current = false; if (alive.current) setSaving(false); }
  }
  return <details className="agent-capabilities agent-session-controls" open={open} onToggle={event => {
    const next = event.currentTarget.open; if (next === open) return;
    setOpen(next); if (next && !disabled) void refresh();
    else { controller.current?.abort(); setLoading(false); }
  }}>
    <summary>权限模式与模型</summary>
    {disabled && <p>连接恢复后可查看设置；仅在会话进程运行时可切换。</p>}
    {loading && <p role="status">正在读取会话设置…</p>}
    {catalog && <>
      <label className="quota-choice"><span>权限模式</span><select aria-label="权限模式" disabled={locked} value={mode} onChange={event => setMode(event.target.value as AgentPermissionMode)}>
        {modes.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
      </select></label>
      <button type="button" className="action-button" disabled={locked || mode === catalog.permissionMode} onClick={() => void save(() => onMode(mode))}>切换权限模式</button>
      <p>当前模型：{catalog.model ?? "Claude Code 默认模型"}</p>
      <label className="quota-choice"><span>模型</span><select aria-label="模型" disabled={locked} value={model} onChange={event => setModel(event.target.value)}>
        <option value="">{catalog.model ? "选择模型" : "当前默认模型（未手动切换）"}</option>
        {catalog.models.map(item => <option key={item.value} value={item.value}>{item.displayName}</option>)}
      </select></label>
      {catalog.models.find(item => item.value === model)?.description && <p>{catalog.models.find(item => item.value === model)!.description}</p>}
      <button type="button" className="action-button" disabled={locked || !model || model === catalog.model} onClick={() => void save(() => onModel(model))}>切换模型</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </details>;
}
