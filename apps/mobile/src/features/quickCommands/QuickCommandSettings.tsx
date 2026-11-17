import { useState } from "react";
import { defaultQuickCommands, loadQuickCommands, maxQuickCommands, saveQuickCommands } from "./model";
import { useQuickCommands } from "./useQuickCommands";
import { QuickCommandEditor } from "./QuickCommandEditor";

export function QuickCommandSettings() {
  const commands = useQuickCommands();
  const [editing, setEditing] = useState<number | "new" | null>(null), [error, setError] = useState("");
  function save(next: readonly string[]) {
    try { saveQuickCommands(next); setError(""); } catch (reason) { setError(reason instanceof Error ? reason.message : "常用指令保存失败"); }
  }
  function move(index: number, offset: number) {
    const next = [...commands];
    [next[index], next[index + offset]] = [next[index + offset], next[index]];
    save(next);
  }
  return <section className="settings-section quick-command-settings" aria-label="常用指令设置">
    <h3>常用指令</h3>
    <p className="setting-description">所有 Agent 共用，仅保存在这台手机。点击填入草稿；长按或右键可编辑。最多 {maxQuickCommands} 条，每条最多 500 字。</p>
    <ol>{commands.map((text, index) => <li key={`${index}:${text}`}>
      <button type="button" className="quick-command-text" aria-label={`编辑常用指令：${text}`} onClick={() => setEditing(index)}>{text}</button>
      <div className="quick-command-actions">
        <button type="button" aria-label={`上移常用指令：${text}`} disabled={index === 0} onClick={() => move(index, -1)}>上移</button>
        <button type="button" aria-label={`下移常用指令：${text}`} disabled={index === commands.length - 1} onClick={() => move(index, 1)}>下移</button>
        <button type="button" aria-label={`删除常用指令：${text}`} onClick={() => save(commands.filter((_, i) => i !== index))}>删除</button>
      </div>
    </li>)}</ol>
    <div className="quick-command-actions">
      <button type="button" disabled={commands.length >= maxQuickCommands} onClick={() => setEditing("new")}>添加指令</button>
      <button type="button" onClick={() => save(defaultQuickCommands)}>恢复默认</button>
    </div>
    {error && <p role="alert">{error}</p>}
    {editing !== null && (editing === "new" || commands[editing] !== undefined) && <QuickCommandEditor initial={editing === "new" ? "" : commands[editing]} onClose={() => setEditing(null)}
      onSave={text => {
        const current = loadQuickCommands();
        if (editing === "new" && current.length >= maxQuickCommands) throw new Error("最多保存 20 条常用指令");
        saveQuickCommands(editing === "new" ? [...current, text] : current.map((command, index) => index === editing ? text : command));
      }} onDelete={editing === "new" ? undefined : () => saveQuickCommands(loadQuickCommands().filter((_, index) => index !== editing))} />}
  </section>;
}
