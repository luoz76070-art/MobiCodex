// End-to-end check of the control hook: the patched bridge between a stand-in window and a CC Desk service
// running in simulation mode, with MobiCodex's two halves (a reader of its own, commands through the socket).
// Local only; it needs a copy of the CC Desk service program, which is not part of this repository.
//
//   node integrations/cc-desk/test/e2e-fixture.mjs --fixture <dir> --bridge <dir>
//
// --fixture: the service program (apps/server, packages/protocol and node_modules with ws and zod), plus
//            tls.crt/tls.key/tls.fingerprint and tls-front.mjs (the client only speaks wss; simulation is plain ws).
// --bridge:  the output of `patch.mjs extract`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 ? pairs : [...pairs, [value.replace(/^--/, ""), all[index + 1]]]), []));
const fixture = args.fixture;
const WebSocket = createRequire(join(fixture, "package.json"))("ws");
const TOKEN = "fixture-token-0123456789abcdef";
const PORT = 18821;
const TLS_PORT = 18822;
const scratch = mkdtempSync(join(tmpdir(), "ccdesk-e2e-"));
const children = [];
const results = [];
const debug = { logs: [], window: [] };
const check = (name, fn) => { fn(); results.push(name); console.log(`ok - ${name}`); };

function start(command, argv, env, ready) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    const timer = setTimeout(() => reject(new Error(`${argv[0]} did not start: ${output}`)), 15000);
    const listen = (chunk) => { output += chunk; if (output.includes(ready)) { clearTimeout(timer); resolve(child); } };
    child.stdout.on("data", listen);
    child.stderr.on("data", listen);
    child.once("exit", (code) => reject(new Error(`${argv[0]} exited ${code}: ${output}`)));
  });
}

// A connection whose frames are kept, with waiting for one that matches.
function frames(socket, parse = (raw) => JSON.parse(raw.toString("utf8"))) {
  const seen = [];
  const waiters = new Set();
  socket.on("message", (raw) => {
    const message = parse(raw);
    seen.push(message);
    for (const waiter of [...waiters]) if (waiter.test(message)) { waiters.delete(waiter); waiter.resolve(message); }
  });
  return {
    seen,
    send: (message) => socket.send(JSON.stringify(message)),
    wait(test, label, ms = 8000) {
      const found = seen.find(test);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const waiter = { test, resolve };
        waiters.add(waiter);
        setTimeout(() => { if (waiters.delete(waiter)) reject(new Error(`timed out waiting for ${label}`)); }, ms);
      });
    },
  };
}
const opened = (socket) => new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
const auth = (deviceName) => ({ type: "auth", protocolVersion: 17, token: TOKEN, deviceName, tunnel: false });
const eventIn = (sessionId, type) => (m) => m.type === "session.event" && m.event.sessionId === sessionId && (!type || m.event.payload.type === type);
const finished = (sessionId) => (m) => m.type === "session.event" && m.event.sessionId === sessionId && m.event.payload.type === "run.status" && ["completed", "cancelled", "failed"].includes(m.event.payload.status);

try {
  await start(process.execPath, [join(fixture, "apps/server/src/main.ts")], { PROXY_PORT: String(PORT), PROXY_TOKEN: TOKEN, PROXY_DATA_DIR: join(scratch, "data") }, "Proxy simulation service");
  await start(process.execPath, [join(fixture, "tls-front.mjs"), String(TLS_PORT), String(PORT)], {}, "tls front");
  const fingerprint = readFileSync(join(fixture, "tls.fingerprint"), "utf8").trim();
  const service = `wss://127.0.0.1:${TLS_PORT}/ws`;
  process.env.MOBICODEX_CCDESK_DIR = join(scratch, "control");
  const { openProxyBridge } = await import(pathToFileURL(join(args.bridge, "proxy-bridge.mjs")).href);
  const logs = debug.logs;
  const bridge = await openProxyBridge({ url: service, fingerprint }, {
    log: (line) => logs.push(line),
    resolveProxy: async () => "DIRECT",
    environment: { CC_DESK_TUNNEL_SCHEDULES: join(scratch, "profile", "schedules.json") },
  });

  // The stand-in window, through the bridge, as the client's page connects.
  const DEVICE = randomUUID();
  const windowSocket = new WebSocket(bridge.url);
  await opened(windowSocket);
  const win = frames(windowSocket);
  debug.window = win.seen;
  win.send(auth("Fixture Mac"));
  win.send({ type: "device", id: DEVICE });
  await win.wait((m) => m.type === "ready", "window ready");
  const create = async (client, title) => {
    const requestId = randomUUID();
    client.send({ type: "session.create", requestId, title, projectPath: `/tmp/${title}` });
    return (await client.wait((m) => m.type === "response" && m.requestId === requestId, `create ${title}`)).sessionId;
  };
  const A = await create(win, "window-session");
  const B = await create(win, "phone-session");
  win.send({ type: "session.subscribe", requestId: randomUUID(), sessionId: A, afterSequence: 0 });
  await win.wait((m) => m.type === "session.snapshot" && m.session.id === A, "window snapshot A");

  // MobiCodex's reader: a connection of its own, without a device identity.
  const direct = () => new WebSocket(service, { rejectUnauthorized: false });
  const readerSocket = direct();
  await opened(readerSocket);
  const reader = frames(readerSocket);
  reader.send(auth("MobiCodex reader"));
  await reader.wait((m) => m.type === "ready", "reader ready");
  reader.send({ type: "session.subscribe", requestId: randomUUID(), sessionId: B, afterSequence: 0 });
  await reader.wait((m) => m.type === "session.snapshot" && m.session.id === B, "reader snapshot B");

  // Another computer with a session of its own.
  const otherSocket = direct();
  await opened(otherSocket);
  const other = frames(otherSocket);
  other.send(auth("Other computer"));
  other.send({ type: "device", id: randomUUID(), platform: "darwin" });
  await other.wait((m) => m.type === "ready", "other ready");
  const C = await create(other, "other-computer-session");

  // The socket.
  const [socketName] = readdirSync(process.env.MOBICODEX_CCDESK_DIR).filter((name) => name.endsWith(".sock"));
  const info = JSON.parse(readFileSync(join(process.env.MOBICODEX_CCDESK_DIR, socketName.replace(".sock", ".json")), "utf8"));
  check("socket info names the profile and service", () => {
    assert.equal(info.service, service);
    assert.match(info.profile, /schedules\.json$/);
  });
  const lines = [];
  const lineWaiters = new Set();
  const control = connect(join(process.env.MOBICODEX_CCDESK_DIR, socketName));
  let pendingText = "";
  control.setEncoding("utf8");
  control.on("data", (chunk) => {
    pendingText += chunk;
    let end;
    while ((end = pendingText.indexOf("\n")) >= 0) {
      const message = JSON.parse(pendingText.slice(0, end));
      pendingText = pendingText.slice(end + 1);
      lines.push(message);
      for (const waiter of [...lineWaiters]) if (waiter.test(message)) { lineWaiters.delete(waiter); waiter.resolve(message); }
    }
  });
  const nextLine = (test, label) => {
    const found = lines.find(test);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve };
      lineWaiters.add(waiter);
      setTimeout(() => { if (lineWaiters.delete(waiter)) reject(new Error(`timed out waiting for ${label}`)); }, 8000);
    });
  };
  const ask = async (request) => {
    const id = randomUUID();
    control.write(`${JSON.stringify({ id, ...request })}\n`);
    return nextLine((m) => m.id === id, request.op);
  };
  const relay = (command) => ask({ op: "command", command: { requestId: randomUUID(), ...command } });

  const state = await nextLine((m) => m.event === "state", "state");
  check("socket reports a writable connection", () => {
    assert.equal(state.state.connected, true);
    assert.equal(state.state.writable, true);
    assert.equal(state.state.adapter, "simulation");
    assert.equal(state.state.protocolVersion, 17);
  });

  const relayedIds = [];
  const sent = await relay({ type: "message.send", sessionId: B, text: "来自手机的消息", scenario: "chat" });
  relayedIds.push(sent.id);
  check("message.send is relayed and answered on the socket", () => assert.deepEqual([sent.ok, sent.response.ok], [true, true]));
  await reader.wait(finished(B), "phone run finished");
  check("the reader sees the phone's message in the session", () =>
    assert.ok(reader.seen.some((m) => eventIn(B, "message.user")(m) && m.event.payload.text === "来自手机的消息")));

  const ownId = randomUUID();
  win.send({ type: "message.send", requestId: ownId, sessionId: A, text: "窗口自己发的", scenario: "chat" });
  await win.wait((m) => m.type === "response" && m.requestId === ownId, "window's own reply");
  await win.wait(finished(A), "window run finished");
  check("the window still gets its own replies and events", () => assert.ok(win.seen.some(eventIn(A, "message.user"))));

  const tool = await relay({ type: "message.send", sessionId: B, text: "需要审批的操作", scenario: "tool" });
  const requested = await reader.wait(eventIn(B, "approval.requested"), "approval requested");
  const approved = await relay({ type: "approval.reply", sessionId: B, runId: requested.event.runId, approvalId: requested.event.payload.approvalId, allowed: true });
  await reader.wait((m) => eventIn(B, "approval.resolved")(m) && m.event.payload.allowed === true, "approval resolved");
  await reader.wait((m) => finished(B)(m) && m.event.runId === requested.event.runId, "approved run finished");
  check("an approval is answered through the socket", () => assert.deepEqual([tool.response.ok, approved.ok, approved.response.ok], [true, true, true]));

  const second = await relay({ type: "message.send", sessionId: B, text: "这一轮要停掉", scenario: "tool" });
  const waiting = await reader.wait((m) => eventIn(B, "approval.requested")(m) && m.event.runId !== requested.event.runId, "second approval requested");
  const cancelled = await relay({ type: "run.cancel", sessionId: B, runId: waiting.event.runId });
  const stopped = await reader.wait((m) => finished(B)(m) && m.event.runId === waiting.event.runId, "cancelled run finished");
  check("a run is stopped through the socket", () => {
    assert.deepEqual([second.response.ok, cancelled.response.ok], [true, true]);
    assert.equal(stopped.event.payload.status, "cancelled");
  });

  const foreign = await relay({ type: "message.send", sessionId: C, text: "不该发出去", scenario: "chat" });
  check("a session on another computer is refused by the service", () => {
    assert.equal(foreign.ok, true);
    assert.equal(foreign.response.ok, false);
    assert.equal(foreign.response.code, "other_device");
  });

  const refused = await relay({ type: "session.delete", sessionId: B });
  const malformed = await ask({ op: "command", command: { type: "message.send", requestId: "not-a-uuid", sessionId: B, text: "x" } });
  check("commands outside the five, and malformed ones, never leave the socket", () => {
    assert.equal(refused.error.code, "not_allowed");
    assert.equal(malformed.error.code, "bad_request");
  });

  const all = lines.filter((m) => m.id && m.ok && m.response).map((m) => m.response);
  check("the window saw none of the relayed replies, nor any live event of the phone's session", () => {
    assert.ok(all.length >= 5);
    const windowResponses = new Set(win.seen.filter((m) => m.type === "response").map((m) => m.requestId));
    for (const line of lines) if (line.id && line.response) assert.ok(!windowResponses.has(line.id));
    assert.equal(win.seen.filter((m) => (m.type === "session.event" && m.event.sessionId === B) || (m.type === "session.fragment" && m.sessionId === B)).length, 0);
    assert.ok(win.seen.some((m) => m.type === "session.updated" && m.session.id === B), "session list updates still reach the window");
  });

  // The user opens the phone's session in the window: from then on its live events are the window's again.
  win.send({ type: "session.subscribe", requestId: randomUUID(), sessionId: B, afterSequence: 0 });
  const snapshot = await win.wait((m) => m.type === "session.snapshot" && m.session.id === B, "window snapshot B");
  check("the window's history of that session includes the phone's messages", () =>
    assert.ok(snapshot.events.some((e) => e.payload.type === "message.user" && e.payload.text === "来自手机的消息")));
  const shown = await relay({ type: "message.send", sessionId: B, text: "窗口开着时手机发的", scenario: "chat" });
  await win.wait((m) => eventIn(B, "message.user")(m) && m.event.payload.text === "窗口开着时手机发的", "window live event");
  check("with the session open in the window, the phone's message shows there live", () => assert.equal(shown.response.ok, true));
  await win.wait(finished(B), "last run finished");

  windowSocket.close();
  const closedState = await nextLine((m) => m.event === "state" && m.state.connected === false, "closed state");
  const late = await relay({ type: "message.send", sessionId: B, text: "窗口关了", scenario: "chat" });
  check("when the window's connection ends the socket says so and refuses commands", () => {
    assert.equal(closedState.state.writable, false);
    assert.equal(late.error.code, "not_connected");
  });
  check("the bridge logged each relay", () => assert.ok(logs.filter((line) => line.startsWith("MobiCodex control: relayed")).length >= 5));
  control.destroy();
  readerSocket.close();
  otherSocket.close();
  await bridge.close();
  console.log(`\n${results.length} checks passed`);
} catch (error) {
  console.error("bridge log:", debug.logs.join("\n"));
  console.error("window frames:", JSON.stringify(debug.window).slice(0, 2000));
  throw error;
} finally {
  for (const child of children) child.kill();
  rmSync(scratch, { recursive: true, force: true });
}
