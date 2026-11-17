import { useEffect, useRef, useState } from "react";
import { useBackLayer } from "../../shared/BackLayers";
import { apiGet, buildUrl, toFriendlyFetchError } from "../connection/http";

export type CodexProject = { name: string; cwd: string };

export function NewThreadProjectPicker({ endpoint, token, initialCwd, notice, onChoose, onCancel }: {
  endpoint: string; token: string; initialCwd: string; notice?: string;
  onChoose: (cwd: string) => void; onCancel: () => void;
}) {
  const [projects, setProjects] = useState<CodexProject[]>([]);
  const [cwd, setCwd] = useState("");
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const sheet = useRef<HTMLElement>(null);
  useBackLayer(true, onCancel, 230);
  useEffect(() => {
    const previous = document.activeElement;
    sheet.current?.focus();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    apiGet<{ projects: CodexProject[] }>(buildUrl(endpoint, "/api/projects"), token, controller.signal)
      .then(data => {
        if (controller.signal.aborted) return;
        setProjects(data.projects);
        setCwd(data.projects.some(project => project.cwd === initialCwd) ? initialCwd : "");
      })
      .catch(reason => { if (!controller.signal.aborted) setError(toFriendlyFetchError(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, token, initialCwd, retry]);
  return <div className="voice-scrim project-picker" onClick={event => { if (event.target === event.currentTarget) onCancel(); }} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
    if (event.key !== "Tab") return;
    const controls = Array.from(sheet.current?.querySelectorAll<HTMLElement>("select:not(:disabled), button:not(:disabled)") ?? []);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === sheet.current)) { event.preventDefault(); first?.focus(); }
  }}>
    <section className="voice-sheet intake-sheet" ref={sheet} tabIndex={-1} role="dialog" aria-modal="true" aria-label="选择新会话项目">
      <header><strong>选择新会话项目</strong></header>
      {notice && <p role="alert">{notice}</p>}
      {loading ? <p role="status">正在读取电脑上的项目…</p> : <label>项目
        <select aria-label="新会话项目" value={cwd} onChange={event => setCwd(event.target.value)}>
          <option value="">请选择项目</option>
          {projects.map(project => <option key={project.cwd} value={project.cwd}>{project.name} · {project.cwd}</option>)}
        </select>
      </label>}
      {!loading && !error && projects.length === 0 && <p>电脑上没有可用项目，请先在电脑上打开项目后重试。</p>}
      {error && <p role="alert">{error}</p>}
      <div className="intake-actions">
        <button type="button" disabled={loading || !!error || !cwd} onClick={() => onChoose(cwd)}>在所选项目里新建</button>
        {(error || !projects.length) && <button type="button" disabled={loading} onClick={() => setRetry(value => value + 1)}>重新读取项目</button>}
        <button type="button" onClick={onCancel}>取消</button>
      </div>
    </section>
  </div>;
}
