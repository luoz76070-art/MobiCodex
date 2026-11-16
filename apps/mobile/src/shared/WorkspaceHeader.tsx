import { ChevronDown, ChevronLeft, ListTodo, Menu, Settings } from "lucide-react";
import { AgentIcon } from "../features/agents/AgentIcon";

type WorkspaceHeaderProps = {
  agentId: string;
  title: string;
  subtitle: string;
  project?: string;
  connection?: { label: string; state: "idle" | "testing" | "ok" | "error" };
  leading: "menu" | "back";
  leadingLabel: string;
  onLeading: () => void;
  onSwitchAgent?: () => void;
  onOpenItems: () => void;
  onOpenSettings: () => void;
};

export function WorkspaceHeader({ agentId, title, subtitle, project, connection, leading, leadingLabel, onLeading, onSwitchAgent, onOpenItems, onOpenSettings }: WorkspaceHeaderProps) {
  const titleContent = <>
    <span className="agent-glyph"><AgentIcon id={agentId} size={18} /></span>
    <span className="workspace-switch-text">
      <span className="workspace-name"><strong>{title}</strong>{connection && <span className={`status-dot ${connection.state}`} />}</span>
      {project ? <span className="project-chip">{project}</span> : <small>{subtitle}</small>}
    </span>
    {onSwitchAgent && <ChevronDown className="workspace-switch-arrow" size={14} aria-hidden="true" />}
  </>;
  return <header className="topbar workspace-header glass-surface">
    <button type="button" className="icon-button" onClick={onLeading} aria-label={leadingLabel} title={leadingLabel}>
      {leading === "menu" ? <Menu size={22} /> : <ChevronLeft size={21} />}
    </button>
    <div className="workspace-title">{onSwitchAgent
      ? <button type="button" className="workspace-switch" onClick={onSwitchAgent} title="切换 Agent"
        aria-label={`${title}${connection ? `，${connection.label}` : ""}${project ? `，项目 ${project}` : ""}，点按切换 Agent`}>{titleContent}</button>
      : <div className="workspace-switch static">{titleContent}</div>}</div>
    <button type="button" className="icon-button" onClick={onOpenItems} aria-label="事项" title="事项"><ListTodo size={18} /></button>
    <button type="button" className="icon-button" onClick={onOpenSettings} aria-label="设置" title="设置"><Settings size={18} /></button>
  </header>;
}
