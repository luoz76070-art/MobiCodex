import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { keychainToken } from "../agents/ccDeskAdapter.js";
import { CcDeskConnection } from "../agents/ccDeskConnection.js";
import { CcDeskControl } from "../agents/ccDeskControl.js";
import { CCDESK_KEYCHAIN_SERVICE, ccDeskConfigSchema, type CcDeskConfig } from "../agents/ccDeskProtocol.js";
import { readManagedConfig, writeManagedConfig } from "./config.js";

const ccDeskError = (code: string) => Object.assign(new Error(code), { code });

/** What CC Desk itself remembers about its service. The token in the same file is never read. */
export async function ccDeskDefaults(file = path.join(os.homedir(), "Library", "Application Support", "CC Desk Tunnel", "settings.json")) {
  try {
    const settings = JSON.parse(await fs.readFile(file, "utf8")) as { deviceId?: unknown; login?: { url?: unknown; fingerprint?: unknown } };
    return {
      url: typeof settings.login?.url === "string" ? settings.login.url : undefined,
      fingerprint: typeof settings.login?.fingerprint === "string" && settings.login.fingerprint ? settings.login.fingerprint : undefined,
      deviceId: typeof settings.deviceId === "string" ? settings.deviceId : undefined,
    };
  } catch { return {}; }
}

function security(args: string[], interactive: boolean): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("security", args, { stdio: interactive ? "inherit" : "ignore" });
    child.once("error", reject);
    child.once("exit", code => resolve(code ?? 1));
  });
}

async function verify(config: CcDeskConfig) {
  const token = await keychainToken(config.url);
  const connection = new CcDeskConnection({ url: config.url, token, ...(config.fingerprint ? { fingerprint: config.fingerprint } : {}) });
  try { return (await connection.open()).sessions.length; } finally { connection.close(); }
}

async function control(config: CcDeskConfig) {
  const socket = new CcDeskControl({ service: config.url, directory: config.controlDirectory });
  try { await socket.refresh(); return { found: Boolean(socket.state), writable: socket.writable }; } finally { socket.stop(); }
}

export async function ccDeskLogin(file: string, options: { url?: string; fingerprint?: string }) {
  const managed = await readManagedConfig(file);
  const defaults = await ccDeskDefaults();
  const parsed = ccDeskConfigSchema.safeParse({
    url: options.url ?? defaults.url,
    ...(options.fingerprint ?? defaults.fingerprint ? { fingerprint: options.fingerprint ?? defaults.fingerprint } : {}),
    ...(defaults.deviceId ? { deviceId: defaults.deviceId } : {}),
  });
  if (!parsed.success) throw ccDeskError("CCDESK_SETTINGS_INVALID");
  if (!process.stdin.isTTY) throw ccDeskError("CCDESK_LOGIN_NEEDS_TERMINAL");
  console.error(`CC Desk 服务：${parsed.data.url}\n请输入 CC Desk 的服务凭据（输入两次；只存进钥匙串，不写入任何文件）：`);
  // security asks for the value itself, so the token never appears in arguments, environment or this process.
  const code = await security(["add-generic-password", "-U", "-s", CCDESK_KEYCHAIN_SERVICE, "-a", parsed.data.url, "-l", "MobiCodex · CC Desk", "-w"], true);
  if (code !== 0) throw ccDeskError("CCDESK_KEYCHAIN_FAILED");
  const sessions = await verify(parsed.data);
  await writeManagedConfig(file, { ...managed, ccdesk: { ...parsed.data } });
  return { configured: true, url: parsed.data.url, sessions, deviceKnown: Boolean(parsed.data.deviceId), control: await control(parsed.data),
    note: "重启网关后生效（stop 再 start）。手机上的“CC Desk”在补丁副本开着时可以发送、审批和停止。" };
}

export async function ccDeskLogout(file: string) {
  const managed = await readManagedConfig(file);
  if (managed.ccdesk) await security(["delete-generic-password", "-s", CCDESK_KEYCHAIN_SERVICE, "-a", managed.ccdesk.url], false);
  const { ccdesk: _removed, ...rest } = managed;
  await writeManagedConfig(file, rest);
  return { configured: false, note: "已删除钥匙串里的凭据和配置；重启网关后生效。" };
}

export async function ccDeskStatus(file: string) {
  const managed = await readManagedConfig(file);
  if (!managed.ccdesk) return { configured: false };
  const stored = (await security(["find-generic-password", "-s", CCDESK_KEYCHAIN_SERVICE, "-a", managed.ccdesk.url], false)) === 0;
  return { configured: true, url: managed.ccdesk.url, tokenStored: stored, deviceKnown: Boolean(managed.ccdesk.deviceId), control: await control(managed.ccdesk) };
}
