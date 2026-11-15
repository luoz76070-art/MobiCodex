// MobiCodex hook for the CC Desk Tunnel desktop client 0.3.2 (protocol 17).
//
// patch.mjs puts this file into a copy of the client, next to its proxy bridge: the place in the main process
// where the window's protocol frames pass as plain JSON. It opens a Unix socket that only this macOS account can
// reach and relays five commands from MobiCodex over the window's own connection, so the service sees the
// computer the session is on, with its execution channel, exactly as when the user types in the window.
//
// - Replies to relayed commands go back to the socket, never to the window.
// - Live events of a session that only MobiCodex is driving are kept from the window: the window shows the usage
//   and capability readings of any session it hears about as those of the session on screen.
// - Reading sessions is not done here. The service lets one connection follow one session at a time, so following
//   another over the window's connection would take the window's away; MobiCodex reads over a connection of its own.
// - Nothing in here may break the bridge: every hook swallows its own errors and leaves the frame as it was.
import { createServer, connect } from "node:net";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const CONTROL_VERSION = 1;
export const RELAYED = Object.freeze(["message.send", "approval.reply", "run.cancel", "run.continue", "run.task.stop"]);
const relayed = new Set(RELAYED);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINE = 256 * 1024;
const MAX_CLIENTS = 8;
const REMEMBERED = 256;

// One socket per client profile (CC Desk runs one process per connection, each with a profile of its own).
// Socket paths are limited to about 100 bytes on macOS, so the name is a short hash of the profile directory;
// the JSON beside it says which profile and service it belongs to.
export function controlDirectory(env = process.env) {
  return env.MOBICODEX_CCDESK_DIR || join(homedir(), ".mobicodex", "ccdesk");
}
export function socketPathFor(profile, env = process.env) {
  if (env.MOBICODEX_CCDESK_SOCKET) return env.MOBICODEX_CCDESK_SOCKET;
  const name = createHash("sha256").update(String(profile ?? "default")).digest("hex").slice(0, 12);
  return join(controlDirectory(env), `${name}.sock`);
}

const failure = (code, message) => Object.assign(new Error(message), { code });
const guard = (fn, fallback) => (value) => { try { return fn(value); } catch { return fallback; } };

// What one connection of the window needs: relaying, and keeping the window's frames as they would have been.
export function createConnectionControl({ send, isOpen = () => true, log = () => {}, timeoutMs = 30_000, onState = () => {} }) {
  const pending = new Map();
  const relayedIds = new Set();
  const windowCreates = new Set();
  // The sessions the service sends this connection live events for, as the window asked for them...
  let windowSubscriptions = new Set();
  // ...and those it sends only because a relayed message started or joined a run there.
  const phoneOnly = new Set();
  const remember = (id) => {
    relayedIds.add(id);
    if (relayedIds.size > REMEMBERED) relayedIds.delete(relayedIds.values().next().value);
  };
  const control = {
    closed: false,
    writable: false,
    adapter: null,
    connectionId: null,
    serviceVersion: null,
    protocolVersion: null,
    // Which computer the window says it is (its sign-in name and device frame; nothing else of the sign-in is
    // kept). A reader of MobiCodex's own must say exactly the same: the service renames this computer's
    // sessions after the name a connection gives, and shows a computer only its own sessions.
    deviceName: null,
    deviceId: null,
    devicePlatform: null,
    phoneOnlySessions: () => [...phoneOnly],
    setWritable(value) {
      if (control.writable === value) return;
      control.writable = value;
      onState();
    },
    relay(command) {
      return new Promise((resolve, reject) => {
        if (control.closed || !isOpen()) return reject(failure("not_connected", "CC Desk is not connected to its service."));
        if (!control.writable) return reject(failure("not_ready", "CC Desk's execution channel is not ready yet."));
        if (pending.has(command.requestId)) return reject(failure("duplicate", "This requestId is already waiting for its reply."));
        const timer = setTimeout(() => {
          pending.delete(command.requestId);
          reject(failure("timeout", "No reply in time; resend with the same requestId."));
        }, timeoutMs);
        pending.set(command.requestId, { resolve, reject, timer });
        remember(command.requestId);
        // The service follows a session on the connection a message goes out on; see `consume`.
        if ((command.type === "message.send" || command.type === "run.continue") && !windowSubscriptions.has(command.sessionId))
          phoneOnly.add(command.sessionId);
        try {
          send(JSON.stringify(command));
        } catch (error) {
          clearTimeout(timer);
          pending.delete(command.requestId);
          return reject(failure("send_failed", String(error?.message ?? error)));
        }
        log(`MobiCodex control: relayed ${command.type}.`);
      });
    },
    // A frame from the window on its way to the service. Mirrors how the service keeps the connection's
    // subscriptions: following a session replaces all others, sending to one adds it.
    fromWindow: guard((message) => {
      if (!message || typeof message !== "object") return;
      if (message.type === "auth" && typeof message.deviceName === "string") {
        control.deviceName = message.deviceName;
        onState();
      } else if (message.type === "device" && typeof message.id === "string") {
        control.deviceId = message.id;
        control.devicePlatform = typeof message.platform === "string" ? message.platform : null;
        onState();
      } else if (message.type === "session.subscribe" && typeof message.sessionId === "string") {
        windowSubscriptions = new Set([message.sessionId]);
        phoneOnly.clear();
      } else if ((message.type === "message.send" || message.type === "run.continue") && typeof message.sessionId === "string") {
        windowSubscriptions.add(message.sessionId);
        phoneOnly.delete(message.sessionId);
      } else if (message.type === "session.create" && typeof message.requestId === "string") {
        windowCreates.add(message.requestId);
      }
    }),
    // Every frame from the service, before the bridge routes it.
    observe: guard((message) => {
      switch (message?.type) {
        case "ready":
          control.connectionId = message.connectionId ?? null;
          control.adapter = message.adapter ?? null;
          control.serviceVersion = message.version ?? null;
          control.protocolVersion = message.protocolVersion ?? null;
          // A native service runs commands only once this connection's execution channel is up (`tunnel.ready`).
          if (message.adapter !== "claude-code") control.setWritable(true);
          else onState();
          break;
        case "tunnel.ready":
          control.setWritable(true);
          break;
        case "connection.error":
          control.setWritable(false);
          break;
        case "response":
          // Creating a session follows it, as the service does for the connection that created it.
          if (windowCreates.delete(message.requestId) && message.ok && message.sessionId) {
            windowSubscriptions = new Set([message.sessionId]);
            phoneOnly.clear();
          }
          break;
        case "session.deleted":
          windowSubscriptions.delete(message.sessionId);
          phoneOnly.delete(message.sessionId);
          break;
      }
    }),
    // Whether a frame from the service stays off the window.
    consume: guard((message) => {
      if (message?.type === "response" && typeof message.requestId === "string") {
        const waiting = pending.get(message.requestId);
        if (waiting) {
          pending.delete(message.requestId);
          clearTimeout(waiting.timer);
          waiting.resolve({ ok: message.ok, sessionId: message.sessionId, code: message.code, message: message.message });
          return true;
        }
        return relayedIds.has(message.requestId);
      }
      if (message?.type === "session.event") return phoneOnly.has(message.event?.sessionId);
      if (message?.type === "session.fragment") return phoneOnly.has(message.sessionId);
      return false;
    }, false),
    close() {
      if (control.closed) return;
      control.closed = true;
      control.writable = false;
      for (const waiting of pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(failure("connection_closed", "CC Desk's connection closed; resend with the same requestId."));
      }
      pending.clear();
    },
  };
  return control;
}

const hub = { server: null, starting: null, path: null, info: null, clients: new Set(), current: null, log: () => {} };

function stateOf(control) {
  if (!control || control.closed) return { connected: false, writable: false, controlVersion: CONTROL_VERSION };
  return {
    connected: true,
    writable: control.writable,
    adapter: control.adapter,
    connectionId: control.connectionId,
    serviceVersion: control.serviceVersion,
    protocolVersion: control.protocolVersion,
    device: control.deviceId && control.deviceName
      ? { id: control.deviceId, name: control.deviceName, ...(control.devicePlatform ? { platform: control.devicePlatform } : {}) }
      : null,
    controlVersion: CONTROL_VERSION,
  };
}
function write(socket, message) {
  if (!socket.destroyed && socket.writable) socket.write(`${JSON.stringify(message)}\n`);
}
function announce() {
  const message = { event: "state", state: stateOf(hub.current) };
  for (const socket of hub.clients) write(socket, message);
}
function writeInfo() {
  if (!hub.path || !hub.info) return;
  const file = hub.path.replace(/\.sock$/, ".json");
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ ...hub.info, controlVersion: CONTROL_VERSION, pid: process.pid, socket: hub.path })}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

function handleLine(socket, line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return write(socket, { id: null, ok: false, error: { code: "bad_json", message: "Each line must be one JSON object." } });
  }
  const id = request?.id ?? null;
  const fail = (code, message) => write(socket, { id, ok: false, error: { code, message } });
  if (request?.op === "status") return write(socket, { id, ok: true, state: stateOf(hub.current) });
  if (request?.op !== "command") return fail("unknown_op", "op must be status or command.");
  const command = request.command;
  if (!command || typeof command !== "object" || Array.isArray(command) || !relayed.has(command.type))
    return fail("not_allowed", `Only ${RELAYED.join(", ")} are relayed.`);
  if (typeof command.requestId !== "string" || !UUID.test(command.requestId)) return fail("bad_request", "requestId must be a UUID.");
  if (typeof command.sessionId !== "string" || !UUID.test(command.sessionId)) return fail("bad_request", "sessionId must be a UUID.");
  const control = hub.current;
  if (!control || control.closed) return fail("not_connected", "CC Desk is not connected to its service.");
  control.relay(command).then(
    (response) => write(socket, { id, ok: true, response }),
    (error) => fail(error.code ?? "failed", error.message),
  );
}

function handleClient(socket) {
  if (hub.clients.size >= MAX_CLIENTS) {
    socket.end(`${JSON.stringify({ event: "error", error: { code: "busy", message: "Too many clients." } })}\n`);
    return;
  }
  hub.clients.add(socket);
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) handleLine(socket, line);
    }
    if (buffer.length > MAX_LINE) socket.destroy();
  });
  const drop = () => hub.clients.delete(socket);
  socket.on("close", drop);
  socket.on("error", drop);
  write(socket, { event: "state", state: stateOf(hub.current) });
}

function answering(path) {
  return new Promise((resolve) => {
    const probe = connect(path);
    const done = (value) => { probe.destroy(); resolve(value); };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    setTimeout(() => done(false), 1000).unref();
  });
}
function present(path) {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function ensureServer(path) {
  if (hub.starting) return hub.starting;
  hub.starting = (async () => {
    const directory = dirname(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    if (present(path)) {
      // Another process of the same profile cannot exist (the client holds a lock per profile), so a socket that
      // answers belongs to someone else: leave it alone rather than take it over.
      if (await answering(path)) {
        hub.log("MobiCodex control: the socket is answered by another process; not serving.");
        return;
      }
      unlinkSync(path);
    }
    const server = createServer(handleClient);
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, resolve);
    });
    chmodSync(path, 0o600);
    server.on("error", (error) => hub.log(`MobiCodex control: socket error ${error.code ?? error.message}.`));
    server.unref();
    hub.server = server;
    hub.path = path;
    writeInfo();
    hub.log("MobiCodex control: listening.");
  })().catch((error) => {
    hub.log(`MobiCodex control: cannot listen (${error.code ?? error.message}).`);
    hub.starting = null;
  });
  return hub.starting;
}

const inert = Object.freeze({ fromWindow() {}, observe() {}, consume: () => false });

// Called by the patched bridge for each connection of the window.
export function attachControl({ send, isOpen, signal, log = () => {}, profile, service, timeoutMs, env = process.env } = {}) {
  try {
    if (env.MOBICODEX_CCDESK_CONTROL === "0") return inert;
    hub.log = log;
    hub.info = { profile: profile ?? null, service: service ?? null };
    const control = createConnectionControl({
      send,
      isOpen,
      log,
      timeoutMs,
      onState: () => {
        if (hub.current === control) announce();
      },
    });
    hub.current = control;
    announce();
    signal?.addEventListener(
      "abort",
      () => {
        control.close();
        if (hub.current === control) {
          hub.current = null;
          announce();
        }
      },
      { once: true },
    );
    if (hub.server) {
      try { writeInfo(); } catch {}
    } else void ensureServer(socketPathFor(profile, env));
    return control;
  } catch (error) {
    log(`MobiCodex control: disabled for this connection (${error?.message ?? error}).`);
    return inert;
  }
}
