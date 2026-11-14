import type { LastTurn } from "../../../../../shared/lastTurn";

/** One model the gateway can continue a task on; `channel` groups models that share a quota. */
export type QuotaModelChoice = { slug: string; displayName: string; channel: string; channelLabel: string; efforts: string[]; defaultEffort: string | null };
/** `blocked`: models Codex could only reach by calling the exhausted model first, so they are not offered. */
export type QuotaSwitchOptions = { model: string | null; channel: string | null; channelLabel: string | null; resetAt: string | null; alternatives: QuotaModelChoice[]; blocked?: number };
/** A thread running on a stand-in channel, and where it came from. */
export type ChannelSwitchRecord = { homeModel: string; homeLabel: string; toModel: string; toLabel: string; resetAt: string | null; at: string };

/** The last turn ran out of quota and nothing is running now: offer another channel. */
export function needsQuotaSwitch(lastTurn: LastTurn | null | undefined, running: boolean) {
  return !running && !!lastTurn && lastTurn.status !== "completed" && lastTurn.reason.code === "rate_limited";
}

/** Alternatives grouped by channel, keeping the gateway's order (same model elsewhere first). */
export function quotaChoiceGroups(choices: QuotaModelChoice[]) {
  const groups: { channel: string; label: string; choices: QuotaModelChoice[] }[] = [];
  for (const choice of choices) {
    const group = groups.find(entry => entry.channel === choice.channel);
    if (group) group.choices.push(choice);
    else groups.push({ channel: choice.channel, label: choice.channelLabel, choices: [choice] });
  }
  return groups;
}

/** "GPT-6-Astra（默认渠道）": the closed picker must show the channel too, since the same model exists on several. */
export function choiceLabel(choice: QuotaModelChoice) {
  const name = choice.displayName.replace(/\s*[（(][^（）()]*[）)]\s*$/, "") || choice.slug;
  return `${name}（${choice.channelLabel}）`;
}

/** "11-20 19:34" in Beijing time, whatever the phone's own time zone. */
export function beijingTime(iso: string | null | undefined) {
  const time = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(time)) return null;
  const shifted = new Date(time + 8 * 3_600_000).toISOString();
  return `${shifted.slice(5, 10)} ${shifted.slice(11, 16)}`;
}

/** The one-line explanation at the top of the card. */
export function quotaSummary(options: QuotaSwitchOptions | null) {
  const where = options?.channelLabel ? `「${options.channelLabel}」渠道` : "这个渠道";
  const reset = beijingTime(options?.resetAt);
  return `${where}的额度用完了${reset ? `，预计北京时间 ${reset} 恢复` : ""}。`;
}

/** The message that starts the switched turn; the thread itself carries all context. */
export function switchPrompt(kind: "quota" | "return", from: string | null, to: string) {
  return kind === "quota"
    ? `（换渠道接着做）上一轮${from ? `在「${from}」` : ""}因为额度用完中断了，现在换到「${to}」。请先看一下当前进度（必要时检查工作区里的实际改动），然后接着把没做完的部分做完。`
    : `（换回原渠道）现在换回「${to}」。如果之前的任务还没做完就接着做；已经做完的话只回复“已换回”，不要做别的。`;
}

export function standInNotice(record: ChannelSwitchRecord, now = Date.now()) {
  const reset = record.resetAt ? Date.parse(record.resetAt) : NaN;
  const when = Number.isFinite(reset) ? reset <= now ? "，原渠道应该已经恢复" : `，预计北京时间 ${beijingTime(record.resetAt)} 恢复` : "";
  return `正在用「${record.toLabel}」顶替「${record.homeLabel}」${when}。`;
}

const switchesKey = "mobicodexChannelSwitchV1";
const rememberedSwitches = 50;

export function loadSwitchRecords(): Record<string, ChannelSwitchRecord> {
  try {
    const value = JSON.parse(localStorage.getItem(switchesKey) ?? "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, ChannelSwitchRecord> : {};
  } catch { return {}; }
}

/** Remember (record) or forget (null) a thread's stand-in channel; keeps the newest few. */
export function saveSwitchRecord(records: Record<string, ChannelSwitchRecord>, threadId: string, record: ChannelSwitchRecord | null) {
  const next = { ...records };
  if (record) next[threadId] = record; else delete next[threadId];
  const kept = Object.fromEntries(Object.entries(next).sort(([, a], [, b]) => a.at.localeCompare(b.at)).slice(-rememberedSwitches));
  try { localStorage.setItem(switchesKey, JSON.stringify(kept)); } catch { /* Storage full or disabled: the notice lasts until reload. */ }
  return kept;
}

const dismissedKey = "mobicodexQuotaDismissedV1";
const remembered = 30;

/** "Wait for it" hides the card for that failed turn only; a later 429 shows it again. */
export function quotaDismissed(threadId: string, turnId: string) {
  return readDismissed().includes(`${threadId}|${turnId}`);
}

export function dismissQuota(threadId: string, turnId: string) {
  const next = [...readDismissed().filter(entry => entry !== `${threadId}|${turnId}`), `${threadId}|${turnId}`].slice(-remembered);
  try { localStorage.setItem(dismissedKey, JSON.stringify(next)); } catch { /* Storage full or disabled: the card simply stays hidden until reload. */ }
}

function readDismissed(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(dismissedKey) ?? "[]");
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
  } catch { return []; }
}
