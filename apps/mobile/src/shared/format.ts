
export function formatDate(value: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(
    new Date(value),
  );
}

export function formatTime(value: string) {
  if (!value) return "";
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

export function formatMessageTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function clip(text: string, max = 110) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1).trimEnd()}...` : normalized;
}

/** #39 list rows: 刚刚, HH:mm today, 昨天, MM-DD this year, YYYY-MM-DD before that. */
export function formatListTime(value: string, now = Date.now()) {
  const date = new Date(value), time = date.getTime();
  if (!value || !Number.isFinite(time)) return "";
  if (Math.abs(now - time) < 60_000) return "刚刚";
  const pad = (part: number) => String(part).padStart(2, "0"), today = new Date(now);
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1), yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (time >= midnight.getTime() && time < tomorrow.getTime()) return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (time >= yesterday.getTime() && time < midnight.getTime()) return "昨天";
  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return date.getFullYear() === today.getFullYear() ? day : `${date.getFullYear()}-${day}`;
}
