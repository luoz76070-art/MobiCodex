import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { agentError } from "./sessions.js";

// SDK 0.3.326 package.json declares claudeCodeVersion=2.1.326. The SDK does
// not declare a general minimum; use its paired release as our supported floor.
export const claudeCliMinimumVersion = "2.1.326";
export type ClaudeCliExecutable = { executable: string; version: string };
export function compatibleClaudeVersion(version: string) {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) return false;
  const actual = version.split(".").map(Number), minimum = claudeCliMinimumVersion.split(".").map(Number);
  for (let i = 0; i < 3; i++) { if (actual[i] !== minimum[i]) return actual[i]! > minimum[i]!; }
  return true;
}
export async function resolveClaudeCliExecutable(configured?: string): Promise<ClaudeCliExecutable> {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  const candidates = configured ? [configured] : [
    ...(process.env.PATH ?? "").split(path.delimiter).filter(path.isAbsolute).flatMap(dir => names.map(name => path.join(dir, name))),
    ...[path.join(os.homedir(), ".local", "bin"), path.join(os.homedir(), ".claude", "local"), "/opt/homebrew/bin", "/usr/local/bin"].flatMap(dir => names.map(name => path.join(dir, name))),
  ];
  let executable: string | undefined;
  for (const candidate of candidates) {
    try { await fs.access(candidate, constants.X_OK); if ((await fs.stat(candidate)).isFile()) { executable = candidate; break; } } catch { /* Try the next installed executable. */ }
  }
  if (!executable) throw agentError("CLAUDE_CLI_EXECUTABLE_NOT_FOUND", 409);
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(executable!, ["--version"], { timeout: 5000, maxBuffer: 8192, windowsHide: true, env: process.env }, (error, value) => {
      if (error) reject(agentError("CLAUDE_CLI_VERSION_FAILED", 409)); else resolve(value);
    });
  });
  const version = stdout.trim().match(/^(\d+\.\d+\.\d+)(?:\s|$)/u)?.[1];
  if (!version) throw agentError("CLAUDE_CLI_VERSION_FAILED", 409);
  return { executable, version };
}
