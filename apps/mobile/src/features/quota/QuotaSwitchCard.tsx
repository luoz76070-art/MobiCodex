import { useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowRightLeft, Clock3, Loader2 } from "lucide-react";
import { choiceLabel, quotaChoiceGroups, quotaSummary, type QuotaSwitchOptions } from "./quotaSwitch";

/** Shown when a Codex turn stops on an exhausted channel; the user picks where to continue. */
export function QuotaSwitchCard({ options, loading, busy, error, onContinue, onDismiss }: {
  options: QuotaSwitchOptions | null; loading: boolean; busy: boolean; error: string;
  onContinue: (model: string) => void; onDismiss: () => void;
}) {
  const choices = useMemo(() => options?.alternatives ?? [], [options]);
  const [model, setModel] = useState(choices[0]?.slug ?? "");
  useEffect(() => { if (!choices.some(choice => choice.slug === model)) setModel(choices[0]?.slug ?? ""); }, [choices, model]);
  const groups = quotaChoiceGroups(choices);
  return (
    <article className="approval-card quota-card" aria-label="额度用完">
      <header><span><AlertCircle size={15} aria-hidden="true" />额度用完</span>{options?.model && <em>{options.model.split("/").at(-1)}</em>}</header>
      <p>{quotaSummary(options)}</p>
      {loading ? <p role="status"><Loader2 size={14} className="spin" aria-hidden="true" /> 正在查看可用的渠道…</p>
        : choices.length ? <>
          <p>换个渠道接着做：会开一个新任务，带上这次的全部对话和做过的操作，原任务保留不动。</p>
          <label className="quota-choice">
            <span>换到</span>
            <select value={model} disabled={busy} onChange={event => setModel(event.target.value)}>
              {groups.map(group => <optgroup key={group.channel} label={group.label}>
                {group.choices.map(choice => <option key={choice.slug} value={choice.slug}>{choiceLabel(choice)}</option>)}
              </optgroup>)}
            </select>
          </label>
        </> : <p>电脑上没有其他可用的渠道，只能等额度恢复。</p>}
      {error && <p className="approval-risk" role="alert"><AlertCircle size={14} aria-hidden="true" /><span>{error}</span></p>}
      <div className="approval-actions">
        {choices.length > 0 && <button type="button" className="accept primary" disabled={busy || loading || !model} onClick={() => onContinue(model)}>
          {busy ? <Loader2 size={14} className="spin" aria-hidden="true" /> : <ArrowRightLeft size={14} aria-hidden="true" />}
          <span>{busy ? "正在换过去…" : "换到这个模型接着做"}</span>
        </button>}
        <button type="button" className="quiet" disabled={busy} onClick={onDismiss}><Clock3 size={14} aria-hidden="true" /><span>等恢复再说</span></button>
      </div>
    </article>
  );
}
