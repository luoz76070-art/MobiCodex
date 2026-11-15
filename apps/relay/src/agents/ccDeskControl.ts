import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { agentError } from "./sessions.js";

/** The computer the CC Desk window signed in as: its device frame and sign-in name, exactly as sent. */
export type CcDeskDevice = { id: string; name: string; platform?: string };
export type CcDeskControlState = { connected: boolean; writable: boolean; adapter?: string | null; serviceVersion?: string | null; protocolVersion?: number | null; device?: CcDeskDevice | null };
export type CcDeskRelayed = { ok: boolean; sessionId?: string; code?: string; message?: string };
type Pending = { resolve: (value: CcDeskRelayed) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
export function defaultControlDirectory() { return path.join(os.homedir(), ".mobicodex", "ccdesk"); }
function sameService(a: unknown, b: string) {
  try {
    const left = new URL(String(a)), right = new URL(b);
    return left.protocol === right.protocol && left.host === right.host && left.pathname.replace(/\/+$/u, "") === right.pathname.replace(/\/+$/u, "");
  } catch { return false; }
}
function alive(pid: unknown) {
  if (!Number.isInteger(pid) || (pid as number) <= 0) return false;
  try { process.kill(pid as number, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/**
 * The socket of the patched CC Desk client connected to the same service (integrations/cc-desk). Commands go out
 * over the client's own connection; without the socket the gateway can only read.
 */
export class CcDeskControl extends EventEmitter {
  private socket: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private readonly pending = new Map<string, Pending>();
  private buffer = "";
  private stopped = false;
  state: CcDeskControlState | null = null;
  constructor(private readonly options: { service: string; directory?: string; timeoutMs?: number }) { super(); }

  get writable() { return Boolean(this.socket && this.state?.connected && this.state.writable); }
  /** Who the window is while it is connected; null otherwise, or from a client that does not say. */
  get device(): CcDeskDevice | null {
    const device = this.socket && this.state?.connected ? this.state.device : null;
    if (!device || typeof device.id !== "string" || !UUID.test(device.id) || typeof device.name !== "string" || !device.name.trim() || device.name.length > 120) return null;
    return { id: device.id, name: device.name, ...(typeof device.platform === "string" && /^[a-z0-9]{1,16}$/u.test(device.platform) ? { platform: device.platform } : {}) };
  }

  /** Finds and connects to the socket if there is none; cheap to call before each use. */
  async refresh(): Promise<void> {
    if (this.stopped || this.socket) return;
    if (!this.connecting) this.connecting = this.connect().finally(() => { this.connecting = null; });
    return this.connecting;
  }

  async relay(command: Record<string, unknown> & { type: string; requestId: string; sessionId: string }): Promise<CcDeskRelayed> {
    await this.refresh();
    const socket = this.socket;
    if (!socket || !this.state?.connected) throw agentError("CCDESK_CONTROL_UNAVAILABLE", 409);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(agentError("CCDESK_TIMEOUT", 504)); }, this.options.timeoutMs ?? 40_000);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ id, op: "command", command })}\n`);
    });
  }

  stop() { this.stopped = true; this.drop(); }

  private async connect() {
    const directory = this.options.directory ?? defaultControlDirectory();
    let names: string[];
    try { names = await fs.readdir(directory); } catch { return; }
    const candidates: { socket: string; mtime: number }[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const file = path.join(directory, name);
        const [text, stat] = await Promise.all([fs.readFile(file, "utf8"), fs.stat(file)]);
        const info = JSON.parse(text) as { service?: unknown; socket?: unknown; pid?: unknown; controlVersion?: unknown };
        if (info.controlVersion !== 1 || typeof info.socket !== "string" || !sameService(info.service, this.options.service) || !alive(info.pid)) continue;
        candidates.push({ socket: info.socket, mtime: stat.mtimeMs });
      } catch { /* not a socket description */ }
    }
    for (const candidate of candidates.sort((a, b) => b.mtime - a.mtime)) {
      if (this.stopped) return;
      const socket = await new Promise<net.Socket | null>(resolve => {
        const probe = net.connect(candidate.socket);
        const done = (value: net.Socket | null) => { clearTimeout(timer); resolve(value); };
        const timer = setTimeout(() => { probe.destroy(); done(null); }, 2000);
        probe.once("connect", () => done(probe));
        probe.once("error", () => done(null));
      });
      if (!socket) continue;
      this.attach(socket);
      // The socket says where it stands as soon as it is connected.
      await new Promise<void>(resolve => { const timer = setTimeout(resolve, 2000); this.once("state", () => { clearTimeout(timer); resolve(); }); });
      return;
    }
  }

  private attach(socket: net.Socket) {
    this.socket = socket; this.buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      this.buffer += chunk;
      let end;
      while ((end = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        try { this.receive(JSON.parse(line)); } catch { /* one bad line does not end the socket */ }
      }
      if (this.buffer.length > 1024 * 1024) socket.destroy();
    });
    socket.once("close", () => { if (this.socket === socket) this.drop(); });
    socket.on("error", () => socket.destroy());
  }

  private receive(message: { id?: string; event?: string; state?: CcDeskControlState; ok?: boolean; response?: CcDeskRelayed; error?: { code?: string } }) {
    if (message.event === "state" && message.state) { this.state = message.state; this.emit("state", this.state); return; }
    const pending = message.id ? this.pending.get(message.id) : undefined;
    if (!pending || !message.id) return;
    this.pending.delete(message.id); clearTimeout(pending.timer);
    if (message.ok && message.response) return pending.resolve(message.response);
    const code = message.error?.code;
    pending.reject(code === "timeout" || code === "connection_closed" ? agentError("CCDESK_TIMEOUT", 504) : agentError("CCDESK_CONTROL_UNAVAILABLE", 409));
  }

  private drop() {
    const socket = this.socket;
    this.socket = null;
    const had = this.state;
    this.state = null;
    socket?.destroy();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(agentError("CCDESK_TIMEOUT", 504)); }
    this.pending.clear();
    if (had) this.emit("state", null);
  }
}
