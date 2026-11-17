import { spawn } from "node:child_process";

export type AwakeReason = { agentId: string; count: number };
export type KeepAwakeStatus = {
  state: "disabled" | "idle" | "holding" | "unsupported" | "error";
  reasons: AwakeReason[];
  releasing: boolean;
  errorCode?: "KEEP_AWAKE_START_FAILED" | "KEEP_AWAKE_PROCESS_EXITED";
  unavailableSources: string[];
};
export type AwakeLease = { release: () => Promise<void> };
export type AwakeStarter = (command: string, args: string[], exited: () => void) => Promise<AwakeLease>;
export type KeepAwakePorts = {
  platform?: string; pid?: number; executable?: string; start?: AwakeStarter;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
};

/** Linux's helper exits on pipe EOF even if the gateway is killed; no shell or detached child. */
export function inhibitorCommand(platform: string, pid: number, executable = process.execPath) {
  if (platform === "darwin") return { command: "/usr/bin/caffeinate", args: ["-i", "-w", String(pid)] };
  if (platform === "linux") return { command: "systemd-inhibit", args: ["--what=idle", "--mode=block", "--who=MobiCodex", "--why=Agents are working", executable, "-e", "process.stdin.resume();process.stdin.on('end',()=>process.exit(0))"] };
  return null;
}

export const startInhibitor: AwakeStarter = (command, args, exited) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { shell: false, stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  let started = false, closed = false;
  const done = new Promise<void>(finish => child.once("close", () => { closed = true; finish(); }));
  child.stdin.on("error", () => {}); // An early process failure can close stdin before release.
  child.once("error", error => { if (!started) reject(error); else exited(); });
  child.once("exit", () => { if (started) exited(); });
  child.once("spawn", () => {
    started = true;
    resolve({ release: async () => {
      if (closed) return;
      if (command === "systemd-inhibit") child.stdin.end();
      else child.kill("SIGTERM");
      const timer = setTimeout(() => { if (!closed) child.kill("SIGKILL"); }, 1000);
      timer.unref();
      try { await done; } finally { clearTimeout(timer); }
    } });
  });
});

/** Owns a lease only. Running counts remain owned by their original Agent controllers. */
export class KeepAwake {
  private state: KeepAwakeStatus["state"];
  private reasons: AwakeReason[] = [];
  private unavailableSources: string[] = [];
  private errorCode?: KeepAwakeStatus["errorCode"];
  private lease?: AwakeLease;
  private starting?: Promise<void>;
  private releasing?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private retryAt = 0;
  private readonly command;
  private readonly setTimer;
  private readonly clearTimer;
  constructor(enabled = true, private readonly ports: KeepAwakePorts = {}) {
    this.command = inhibitorCommand(ports.platform ?? process.platform, ports.pid ?? process.pid, ports.executable);
    this.state = !enabled ? "disabled" : !this.command ? "unsupported" : "idle";
    this.setTimer = ports.setTimer ?? setTimeout; this.clearTimer = ports.clearTimer ?? clearTimeout;
  }
  snapshot(): KeepAwakeStatus { return { state: this.state, reasons: this.reasons.map(item => ({ ...item })), releasing: Boolean(this.timer), ...(this.errorCode ? { errorCode: this.errorCode } : {}), unavailableSources: [...this.unavailableSources] }; }
  async update(reasons: AwakeReason[], unavailableSources: string[] = []) {
    if (this.stopped || this.state === "disabled" || this.state === "unsupported") return;
    this.reasons = reasons.filter(item => item.count > 0); this.unavailableSources = [...unavailableSources];
    if (this.reasons.length) {
      if (this.timer) { this.clearTimer(this.timer); this.timer = undefined; }
      if (this.releasing) await this.releasing;
      if (!this.stopped && this.reasons.length && !this.lease && !this.starting && (this.ports.now ?? Date.now)() >= this.retryAt) {
        this.starting = this.acquire().finally(() => { this.starting = undefined; });
      }
      await this.starting;
    } else if ((this.lease || this.starting) && !this.timer) {
      this.timer = this.setTimer(() => {
        this.timer = undefined;
        this.releasing = (async () => { await this.starting; if (!this.reasons.length) await this.release(); })().finally(() => { this.releasing = undefined; });
      }, 60_000);
      this.timer.unref?.();
    } else if (!this.lease && !this.starting) { this.state = "idle"; this.errorCode = undefined; this.retryAt = 0; }
  }
  private async acquire() {
    try {
      let active = true, ended = false;
      const lease = await (this.ports.start ?? startInhibitor)(this.command!.command, this.command!.args, () => {
        ended = true;
        if (active && !this.stopped) { this.lease = undefined; this.state = "error"; this.errorCode = "KEEP_AWAKE_PROCESS_EXITED"; this.retryAt = (this.ports.now ?? Date.now)() + 30_000; }
      });
      const owned = { release: async () => { active = false; await lease.release(); } };
      if (this.stopped) { await owned.release(); return; }
      if (ended) { await owned.release(); this.state = "error"; this.errorCode = "KEEP_AWAKE_PROCESS_EXITED"; return; }
      this.lease = owned; this.state = "holding"; this.errorCode = undefined;
    } catch (error) {
      if (this.stopped) return;
      this.state = this.command!.command === "systemd-inhibit" && (error as NodeJS.ErrnoException).code === "ENOENT" ? "unsupported" : "error";
      this.errorCode = this.state === "error" ? "KEEP_AWAKE_START_FAILED" : undefined;
      this.retryAt = (this.ports.now ?? Date.now)() + 30_000;
    }
  }
  private async release() {
    const lease = this.lease; this.lease = undefined;
    try { await lease?.release(); } catch { this.state = "error"; this.errorCode = "KEEP_AWAKE_PROCESS_EXITED"; return; }
    if (this.state !== "disabled" && this.state !== "unsupported") { this.state = "idle"; this.errorCode = undefined; }
  }
  async stop() {
    this.stopped = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = undefined;
    await this.starting; await this.releasing; await this.release();
    this.reasons = []; this.unavailableSources = [];
  }
}
