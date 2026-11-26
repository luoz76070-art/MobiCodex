import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { satisfiesRange } from "./hostVersions.js";

export type DeepSeekHostPaths = { app: string; profile: string };
export type DeepSeekInstall = { harness: string | null; plugin: { version: string; range: string | null } | null };

/** The desktop app and the profile it loads plugins from; only macOS has a fixed install location. */
export function defaultDeepSeekHostPaths(): DeepSeekHostPaths | null {
  return process.platform === "darwin" ? { app: "/Applications/DeepSeek Harness.app", profile: path.join(os.homedir(), ".dsh", "profiles", "desktop") } : null;
}

async function small(file: string) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 262_144) throw new Error("unexpected file");
  return fs.readFile(file, "utf8");
}
const versionText = (value: unknown) => typeof value === "string" && /^[0-9A-Za-z.+-]{1,64}$/u.test(value) ? value : null;

/** Read-only: which DeepSeek is installed and which plugin build its profile links, to explain a dead bridge. */
export async function readDeepSeekInstall(paths: DeepSeekHostPaths | null): Promise<DeepSeekInstall> {
  if (!paths) return { harness: null, plugin: null };
  let harness: string | null = null, plugin: DeepSeekInstall["plugin"] = null;
  try {
    const plist = await small(path.join(paths.app, "Contents", "Info.plist"));
    harness = versionText(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]*)<\/string>/u.exec(plist)?.[1]);
  } catch { /* not installed here */ }
  try {
    const manifest = JSON.parse(await small(path.join(paths.profile, "node_modules", "dsh-mobile-codex", "package.json"))) as { version?: unknown; engines?: { dsh?: unknown } };
    const version = versionText(manifest.version), range = manifest.engines?.dsh;
    if (version) plugin = { version, range: typeof range === "string" && range.length <= 1024 ? range : null };
  } catch { /* plugin not linked */ }
  return { harness, plugin };
}

export function deepSeekUnreachableMessage({ harness, plugin }: DeepSeekInstall) {
  if (harness && plugin?.range && satisfiesRange(harness, plugin.range) === false)
    return `电脑上的 DeepSeek 已更新到 ${harness}，已装的 MobiCodex 插件 ${plugin.version} 不支持这个版本，需要在电脑上更新插件。`;
  if (harness && !plugin) return `电脑上的 DeepSeek（${harness}）还没有装 MobiCodex 插件。`;
  if (harness) return "连不上电脑上的 DeepSeek 插件。请确认 DeepSeek 已打开；刚更新过 DeepSeek 或插件的话，在 DeepSeek 的插件设置里把 Mobile Codex 关掉再打开。";
  return "连不上电脑上的 DeepSeek。请确认 DeepSeek Harness 已打开，并启用了 Mobile Codex 插件。";
}

export function deepSeekIncompatibleMessage(version: string, missing: readonly string[]) {
  const shown = versionText(version) ?? "未知版本";
  return missing.length
    ? `电脑上的 DeepSeek ${shown} 改了插件依赖的内部接口（${missing.join("、")}），插件已暂停以免误操作，需要等 MobiCodex 更新。`
    : `电脑上的 DeepSeek ${shown} 不在插件支持的范围（0.2.x），插件已暂停，需要等 MobiCodex 更新。`;
}

export function deepSeekUnverifiedNotice(version: string, interactions: boolean) {
  return `电脑上的 DeepSeek ${version} 还没经过 MobiCodex 验证，查看会话和发消息照常可用${interactions ? "" : "，提问和审批暂时请在电脑上处理"}。`;
}
