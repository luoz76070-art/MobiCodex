import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronRight, Folder } from "lucide-react";
import { loadProjectGroups, saveProjectGroups } from "./projectPreferences";

type Group<T> = { key: string; label: string; detail: string; items: T[] };

export function ProjectGroups<T>({ scope, agentId, groups, search, children, onNewThread }: {
  scope: string; agentId: string; groups: Group<T>[]; search: string; children: (item: T) => ReactNode;
  onNewThread?: (cwd: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(() => loadProjectGroups(scope, agentId));
  useEffect(() => { saveProjectGroups(scope, agentId, collapsed); }, [scope, agentId, collapsed]);
  function toggle(key: string) {
    setCollapsed(current => {
      const next = { ...current };
      if (next[key]) delete next[key]; else next[key] = true;
      return Object.fromEntries(Object.entries(next).slice(-256));
    });
  }
  return <>{groups.map(group => <ProjectGroup key={group.key} group={group} search={search.trim()} collapsed={Boolean(collapsed[group.key])} onToggle={() => toggle(group.key)} onNewThread={onNewThread}>{() => group.items.map(children)}</ProjectGroup>)}</>;
}

function ProjectGroup({ group, search, collapsed, onToggle, children, onNewThread }: {
  group: Group<unknown>; search: string; collapsed: boolean; onToggle: () => void; children: () => ReactNode;
  onNewThread?: (cwd: string) => void;
}) {
  const id = useId();
  const [searchCollapsed, setSearchCollapsed] = useState(false);
  useEffect(() => { setSearchCollapsed(false); }, [search]);
  const expanded = search ? !searchCollapsed : !collapsed;
  return <section className="thread-group">
    <button type="button" className="thread-group-label" aria-expanded={expanded} aria-controls={id}
      aria-label={`${expanded ? "收起" : "展开"}项目 ${group.label}${group.detail ? `（${group.detail}）` : ""}`}
      onClick={() => search ? setSearchCollapsed(current => !current) : onToggle()}>
      <ChevronRight size={16} className={expanded ? "project-chevron expanded" : "project-chevron"} aria-hidden="true" />
      <Folder size={16} aria-hidden="true" />
      <span className="project-name" title={group.key === "__uncategorized__" ? group.label : group.key}><span>{group.label}</span>{group.detail && <small>{group.detail}</small>}</span>
      <em title="已加载会话数">{group.items.length}</em>
    </button>
    {onNewThread && group.key !== "__uncategorized__" && <button type="button" className="text-action project-new-thread" onClick={() => onNewThread(group.key)}>在这个项目里新建</button>}
    <div id={id} className="project-threads" hidden={!expanded}>{expanded && children()}</div>
  </section>;
}
