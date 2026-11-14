import type { LastTurn } from "../../../../../shared/lastTurn";

/** One model the gateway can continue a task on; `channel` groups models that share a quota. */
export type QuotaModelChoice = { slug: string; displayName: string; channel: string; channelLabel: string; efforts: string[]; defaultEffort: string | null };
export type QuotaSwitchOptions = { model: string | null; channel: string | null; channelLabel: string | null; resetAt: string | null; alternatives: QuotaModelChoice[] };
export type QuotaContinuation = { continuedFrom: string; model: string; channelLabel: string; carried: number; omitted: number };

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

export function continuationNotice(from: string, continuation: QuotaContinuation) {
  const omitted = continuation.omitted > 0 ? `（较早的 ${continuation.omitted} 条没有带上）` : "";
  return `已换到「${continuation.channelLabel}」接着做「${from}」，带上了之前的 ${continuation.carried} 条记录${omitted}。原任务保留不动。`;
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
