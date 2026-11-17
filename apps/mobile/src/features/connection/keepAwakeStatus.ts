const agentNames: Record<string, string> = { codex: "Codex", claude: "Claude Code", "claude-cli": "Claude CLI", deepseek: "DeepSeek", opencode: "OpenCode" };

/** Project only known labels and counts; never render raw errors or server context. */
export function keepAwakeLabel(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "状态不可用（电脑端可能需要升级）";
  const value = raw as { state?: unknown; reasons?: unknown; releasing?: unknown; unavailableSources?: unknown };
  const names = { disabled: "未启用", idle: "空闲", holding: "保持唤醒中", unsupported: "不支持", error: "出错（无法保持唤醒）" };
  if (typeof value.state !== "string" || !Object.hasOwn(names, value.state)) return "状态不可用";
  let label = names[value.state as keyof typeof names];
  if (value.state === "holding") {
    const reasons = Array.isArray(value.reasons) ? value.reasons.flatMap(item => {
      if (!item || !Object.hasOwn(agentNames, item.agentId) || !Number.isSafeInteger(item.count) || item.count <= 0) return [];
      return [`${agentNames[item.agentId]} ${item.count} 个任务`];
    }).slice(0, 5) : [];
    label += reasons.length ? `（${reasons.join("、")}）` : value.releasing === true ? "（任务已结束，60 秒后释放）" : "";
  }
  if (Array.isArray(value.unavailableSources) && value.unavailableSources.length) label += "；部分 Agent 运行状态暂不可用";
  return label;
}
