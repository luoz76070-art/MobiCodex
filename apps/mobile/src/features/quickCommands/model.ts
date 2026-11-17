export const quickCommandsKey = "mobileCodexQuickCommandsV1";
export const quickCommandsChanged = "mobile-codex-quick-commands-changed";
export const maxQuickCommands = 20;
export const maxQuickCommandLength = 500;
export const defaultQuickCommands: readonly string[] = ["继续", "总结一下目前的进展", "先跑测试，再告诉我结果"];

export function normalizeQuickCommands(value: unknown): string[] {
  if (!Array.isArray(value)) return [...defaultQuickCommands];
  return value.filter((item): item is string => typeof item === "string")
    .map(item => item.trim().slice(0, maxQuickCommandLength).trim()).filter(Boolean).slice(0, maxQuickCommands);
}

let cachedRaw: string | null | undefined;
let cachedCommands: readonly string[] = defaultQuickCommands;
export function loadQuickCommands(): readonly string[] {
  try {
    const raw = localStorage.getItem(quickCommandsKey);
    if (raw !== cachedRaw) {
      cachedRaw = raw;
      try { cachedCommands = raw === null ? defaultQuickCommands : normalizeQuickCommands(JSON.parse(raw)); }
      catch { cachedCommands = defaultQuickCommands; }
    }
    return cachedCommands;
  } catch { return defaultQuickCommands; }
}

export function saveQuickCommands(commands: readonly string[]) {
  try { localStorage.setItem(quickCommandsKey, JSON.stringify(normalizeQuickCommands(commands))); }
  catch { throw new Error("常用指令保存失败，请检查手机存储后重试"); }
  window.dispatchEvent(new Event(quickCommandsChanged));
}

export function appendQuickCommand(draft: string, command: string, maxLength?: number) {
  const text = draft.trimEnd();
  const next = text ? `${text} ${command}` : command;
  // Never truncate an existing draft, even if its channel limit has changed.
  return maxLength === undefined ? next : maxLength < draft.length ? draft : next.slice(0, maxLength);
}
