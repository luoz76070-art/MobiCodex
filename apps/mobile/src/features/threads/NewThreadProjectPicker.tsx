import { useEffect, useRef, useState } from "react";
import { useBackLayer } from "../../shared/BackLayers";
import { apiGet, buildUrl, toFriendlyFetchError } from "../connection/http";

export type CodexProject = { name: string; cwd: string };

// One entry point for new sessions: tap a project to start there. The current project is listed first and marked,
// but nothing is chosen until the user taps a row.
export function NewThreadProjectPicker({ endpoint, token, initialCwd, notice, onChoose, onCancel }: {
  endpoint: string; token: string; initialCwd: string; notice?: string;
  onChoose: (cwd: string) => void; onCancel: () => void;
}) {
  const [projects, setProjects] = useState<CodexProject[]>([]);
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
        const current = data.projects.filter(project => project.cwd === initialCwd);
        setProjects([...current, ...data.projects.filter(project => project.cwd !== initialCwd)]);
      })
      .catch(reason => { if (!controller.signal.aborted) setError(toFriendlyFetchError(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [endpoint, token, initialCwd, retry]);
  return <div className="voice-scrim project-picker" onClick={event => { if (event.target === event.currentTarget) onCancel(); }} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
    if (event.key !== "Tab") return;
    const controls = Array.from(sheet.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet.current)) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || document.activeElement === sheet.current)) { event.preventDefault(); first?.focus(); }
  }}>
    <section className="voice-sheet intake-sheet" ref={sheet} tabIndex={-1} role="dialog" aria-modal="true" aria-label="选择新会话项目">
      <header><strong>在哪个项目里新建？</strong></header>
      {notice && <p role="alert">{notice}</p>}
      {loading && <p role="status">正在读取电脑上的项目…</p>}
      {!loading && !error && projects.length > 0 && <div className="project-choice-list" role="list">
        {projects.map(project => <button type="button" role="listitem" key={project.cwd} className="project-choice" data-cwd={project.cwd}
          aria-current={project.cwd === initialCwd ? "true" : undefined} onClick={() => onChoose(project.cwd)}>
          <strong>{project.name}</strong>
          {project.cwd === initialCwd && <em>当前项目</em>}
          <small title={project.cwd}><bdi dir="ltr">{project.cwd}</bdi></small>
        </button>)}
      </div>}
      {!loading && !error && projects.length === 0 && <p>电脑上没有可用项目，请先在电脑上打开项目后重试。</p>}
      {error && <p role="alert">{error}</p>}
      <div className="intake-actions">
        {(error || (!loading && !projects.length)) && <button type="button" onClick={() => setRetry(value => value + 1)}>重新读取项目</button>}
        <button type="button" onClick={onCancel}>取消</button>
      </div>
    </section>
  </div>;
}
