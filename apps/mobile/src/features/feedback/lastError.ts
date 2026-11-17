/** Memory only. No credentials, URLs, paths or other connection's errors in feedback context. */
export function redactFeedbackError(text: string) {
  return text.replace(/(?:https?|wss?|file|content):\/\/[^\s<>"'，。；！？）)]+/giu, '[地址]')
    .replace(/\bBearer\s+[^\s，。；]+/giu, '[凭证]')
    .replace(/(?:token|secret|password|api[_-]?key|authorization)\s*[:=：]\s*[^\s，。；]+/giu, '[凭证]')
    .replace(/(?:[A-Z]:[\\/]|~?\/)[^\s<>"'，。；！？）)]+/giu, '[路径]')
    .replace(/(?:\.{1,2}[\\/])?[\w.-]+[\\/][^\s<>"'，。；！？）)]+/gu, '[路径]')
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]+\b/giu, '[邮箱]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/gu, '[标识]')
    .replace(/\s+/gu, ' ').trim().slice(0, 200);
}
let latest: { scope: string; text: string } | null = null;
export function recordFeedbackError(scope: string, text: string) {
  const safe = redactFeedbackError(text);
  if (safe) latest = { scope, text: safe };
}
export function lastFeedbackError(scope: string) { return latest?.scope === scope ? latest.text : ''; }
/** All visible alert components use this one recorder, including errors inside portal sheets. */
export function observeFeedbackErrors(scope: string, root: HTMLElement = document.body, secrets: string[] = []) {
  const seen = new WeakMap<Element, string>();
  const scan = () => {
    for (const node of root.querySelectorAll<HTMLElement>('[role="alert"], [data-feedback-error="true"], .error-notice, .voice-error')) {
      if (!node.getClientRects().length || getComputedStyle(node).visibility === 'hidden') { seen.delete(node); continue; }
      let text = node.textContent?.trim() ?? '';
      for (const secret of secrets) if (secret) text = text.replaceAll(secret, '[凭证]');
      text = redactFeedbackError(text);
      if (!text) seen.delete(node);
      if (text && seen.get(node) !== text) { seen.set(node, text); recordFeedbackError(scope, text); }
    }
  };
  const observer = new MutationObserver(scan);
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'hidden', 'style', 'role', 'data-feedback-error'] });
  scan(); return () => observer.disconnect();
}
