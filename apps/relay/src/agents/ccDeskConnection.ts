import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { TLSSocket } from "node:tls";
import WebSocket from "ws";
import type { CcDeskDevice } from "./ccDeskControl.js";
import { CCDESK_PROTOCOL, parseServerMessage, type CcDeskServerMessage } from "./ccDeskProtocol.js";
import { agentError } from "./sessions.js";

export type CcDeskConnectionOptions = { url: string; fingerprint?: string; token: string; device?: CcDeskDevice; timeoutMs?: number; heartbeatMs?: number };
export type CcDeskReady = Extract<CcDeskServerMessage, { type: "ready" }>;
export type CcDeskSnapshot = Extract<CcDeskServerMessage, { type: "session.snapshot" }>;
export type CcDeskResponse = Extract<CcDeskServerMessage, { type: "response" }>;
type Waiting = { expect: "response" | "snapshot"; resolve: (value: CcDeskResponse | CcDeskSnapshot) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

const pin = (value: string) => value.replaceAll(":", "").toLowerCase();
function connectionCode(code: string) {
  if (code === "version_mismatch") return "CCDESK_PROTOCOL_UNSUPPORTED";
  if (code === "unauthorized") return "CCDESK_AUTH_FAILED";
  return "CCDESK_CONNECTION_FAILED";
}
function requestCode(code: string | undefined) {
  if (code === "not_found") return agentError("CCDESK_SESSION_NOT_FOUND", 404);
  if (code === "invalid_cursor") return agentError("CCDESK_HISTORY_CURSOR_INVALID", 400);
  return agentError("CCDESK_REQUEST_FAILED", 502);
}

/**
 * One reading connection to the CC Desk service: list, follow one session, read history. It asks for no execution
 * channel. A service that shows each computer only its own sessions needs it to say which computer it is; then
 * it says exactly what the window of that computer said (`device`), because the service renames the computer's
 * sessions after the name a connection gives. It never sends `leave`: from the last connection of a computer that
 * would end the computer's runs at once. The token is sent only after the certificate checks out.
 */
export class CcDeskConnection extends EventEmitter {
  private socket: WebSocket | null = null;
  private readonly waiting = new Map<string, Waiting>();
  private heartbeat?: NodeJS.Timeout;
  private heard = 0;
  closed = false;
  ready: CcDeskReady | null = null;
  constructor(private readonly options: CcDeskConnectionOptions) { super(); }
  get device() { return this.options.device ?? null; }

  open(): Promise<CcDeskReady> {
    const { url, fingerprint, token, timeoutMs = 15_000 } = this.options;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (code: string) => {
        if (settled) return this.close(code);
        settled = true; clearTimeout(timer); this.close(code); reject(agentError(code));
      };
      const timer = setTimeout(() => fail("CCDESK_CONNECTION_FAILED"), timeoutMs);
      let socket: WebSocket;
      try {
        socket = new WebSocket(url, { handshakeTimeout: timeoutMs, perMessageDeflate: false, maxPayload: 16 * 1024 * 1024, rejectUnauthorized: !fingerprint });
      } catch { return fail("CCDESK_CONNECTION_FAILED"); }
      this.socket = socket;
      socket.once("upgrade", response => {
        if (!fingerprint) return;
        const certificate = (response.socket as TLSSocket).getPeerCertificate?.();
        if (!certificate?.fingerprint256 || pin(certificate.fingerprint256) !== pin(fingerprint)) fail("CCDESK_CERT_MISMATCH");
      });
      const device = this.options.device;
      // With a device frame the service sends `ready` again, now with that computer's sessions; a request sent
      // after it is answered after that, whichever way the service shows sessions.
      const barrier = device ? randomUUID() : null;
      const done = () => { settled = true; clearTimeout(timer); this.beat(); resolve(this.ready!); };
      socket.once("open", () => {
        if (settled || this.closed) return;
        socket.send(JSON.stringify({ type: "auth", protocolVersion: CCDESK_PROTOCOL, token, deviceName: device?.name ?? "MobiCodex 网关", tunnel: false }));
        if (!device) return;
        socket.send(JSON.stringify({ type: "device", id: device.id, ...(device.platform ? { platform: device.platform } : {}) }));
        socket.send(JSON.stringify({ type: "session.history", requestId: barrier, sessionId: randomUUID(), beforeSequence: 1 }));
      });
      socket.on("message", raw => {
        this.heard = Date.now();
        let message: CcDeskServerMessage | null;
        try { message = parseServerMessage(raw.toString()); } catch { return fail("CCDESK_PROTOCOL_UNSUPPORTED"); }
        if (!message) return;
        if (message.type === "connection.error") return fail(connectionCode(message.code));
        if (message.type === "ready") {
          if (message.protocolVersion !== CCDESK_PROTOCOL) return fail("CCDESK_PROTOCOL_UNSUPPORTED");
          this.ready = message;
          if (!settled && !barrier) done();
          return;
        }
        if (barrier && message.type === "response" && message.requestId === barrier) {
          if (!settled && this.ready) done();
          return;
        }
        this.route(message);
        this.emit("message", message);
      });
      socket.on("ping", () => { this.heard = Date.now(); });
      socket.on("pong", () => { this.heard = Date.now(); });
      socket.on("error", error => fail(/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/u.test(String((error as NodeJS.ErrnoException).code ?? error.message)) ? "CCDESK_CERT_MISMATCH" : "CCDESK_CONNECTION_FAILED"));
      socket.once("close", () => fail(settled ? "CCDESK_DISCONNECTED" : "CCDESK_CONNECTION_FAILED"));
    });
  }

  /** Sends a command; `snapshot` waits for the history page the command asks for, `response` for its reply. */
  request(command: Record<string, unknown>, expect: "snapshot"): Promise<CcDeskSnapshot>;
  request(command: Record<string, unknown>, expect: "response"): Promise<CcDeskResponse>;
  request(command: Record<string, unknown>, expect: "response" | "snapshot"): Promise<CcDeskResponse | CcDeskSnapshot> {
    const socket = this.socket;
    if (this.closed || !this.ready || socket?.readyState !== WebSocket.OPEN) return Promise.reject(agentError("CCDESK_DISCONNECTED"));
    const requestId = typeof command.requestId === "string" ? command.requestId : randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(requestId); reject(agentError("CCDESK_TIMEOUT", 504)); }, this.options.timeoutMs ?? 15_000);
      this.waiting.set(requestId, { expect, resolve, reject, timer });
      socket.send(JSON.stringify({ ...command, requestId }));
    });
  }

  close(code = "CCDESK_CLOSED") {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const waiting of this.waiting.values()) { clearTimeout(waiting.timer); waiting.reject(agentError("CCDESK_DISCONNECTED")); }
    this.waiting.clear();
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.close(1000);
      setTimeout(() => socket.terminate(), 1000).unref();
    } else socket?.terminate();
    this.emit("close", code);
  }

  private route(message: CcDeskServerMessage) {
    if (message.type !== "session.snapshot" && message.type !== "response") return;
    const waiting = this.waiting.get(message.requestId);
    if (!waiting) return;
    if (message.type === "response" && !message.ok) {
      this.waiting.delete(message.requestId); clearTimeout(waiting.timer); waiting.reject(requestCode(message.code)); return;
    }
    if ((message.type === "session.snapshot") !== (waiting.expect === "snapshot")) return;
    this.waiting.delete(message.requestId); clearTimeout(waiting.timer); waiting.resolve(message);
  }

  private beat() {
    const every = this.options.heartbeatMs ?? 15_000;
    this.heard = Date.now();
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.heard > every * 2.5) return this.close("CCDESK_DISCONNECTED");
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.ping();
    }, every);
    this.heartbeat.unref();
  }
}
