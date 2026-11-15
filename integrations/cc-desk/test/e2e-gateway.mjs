// End-to-end check of the gateway's CC Desk agent (C2): MobiCodex's adapter reads from a CC Desk service in simulation
// mode over its own connections and writes through the patched bridge's socket, while a stand-in window holds the
// computer's connection. The service shows each computer only its own sessions (PROXY_SESSION_VISIBILITY=device),
// so the gateway reads as the window's computer, under exactly the name the window gave.
// Local only, like e2e-fixture.mjs; build the relay first (pnpm --filter @mobile-codex/relay build).
//
//   node integrations/cc-desk/test/e2e-gateway.mjs --fixture <dir> --bridge <dir>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 ? pairs : [...pairs, [value.replace(/^--/, ""), all[index + 1]]]), []));
const relayDist = join(dirname(fileURLToPath(import.meta.url)), "../../../apps/relay/dist");
const { CcDeskAdapter } = await import(pathToFileURL(join(relayDist, "agents/ccDeskAdapter.js")).href);
const { ccDeskConfigSchema } = await import(pathToFileURL(join(relayDist, "agents/ccDeskProtocol.js")).href);
const WebSocket = createRequire(join(args.fixture, "package.json"))("ws");
const TOKEN = "fixture-token-0123456789abcdef", PORT = 18831, TLS_PORT = 18832;
const scratch = mkdtempSync(join(tmpdir(), "ccdesk-gw-"));
const children = [], results = [], serviceLog = [];
const check = (name, fn) => { fn(); results.push(name); console.log(`ok - ${name}`); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, label, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) { const value = read(); if (value) return value; if (Date.now() > end) throw new Error(`timed out waiting for ${label}`); await sleep(20); }
}
function start(command, argv, env, ready) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    const timer = setTimeout(() => reject(new Error(`${argv[0]} did not start: ${output}`)), 15000);
    const listen = (chunk) => { output += chunk; if (argv[0].endsWith("main.ts")) serviceLog.push(String(chunk)); if (output.includes(ready)) { clearTimeout(timer); resolve(child); } };
    child.stdout.on("data", listen); child.stderr.on("data", listen);
    child.once("exit", (code) => reject(new Error(`${argv[0]} exited ${code}: ${output}`)));
  });
}
function client(socket) {
  const seen = [];
  socket.on("message", (raw) => seen.push(JSON.parse(raw.toString("utf8"))));
  return { seen, send: (message) => socket.send(JSON.stringify(message)), wait: (test, label) => until(() => seen.find(test), label) };
}
const opened = (socket) => new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
const auth = (deviceName) => ({ type: "auth", protocolVersion: 17, token: TOKEN, deviceName, tunnel: false });
const ids = () => ({ clientMessageId: randomUUID() });

let adapter = null;
try {
  await start(process.execPath, [join(args.fixture, "apps/server/src/main.ts")], { PROXY_PORT: String(PORT), PROXY_TOKEN: TOKEN, PROXY_DATA_DIR: join(scratch, "data"), PROXY_SESSION_VISIBILITY: "device" }, "Proxy simulation service");
  await start(process.execPath, [join(args.fixture, "tls-front.mjs"), String(TLS_PORT), String(PORT)], {}, "tls front");
  const fingerprint = readFileSync(join(args.fixture, "tls.fingerprint"), "utf8").trim();
  const service = `wss://127.0.0.1:${TLS_PORT}/ws`;
  process.env.MOBICODEX_CCDESK_DIR = join(scratch, "control");
  const { openProxyBridge } = await import(pathToFileURL(join(args.bridge, "proxy-bridge.mjs")).href);
  const logs = [];
  const bridge = await openProxyBridge({ url: service, fingerprint }, { log: (line) => logs.push(line), resolveProxy: async () => "DIRECT",
    environment: { CC_DESK_TUNNEL_SCHEDULES: join(scratch, "profile", "schedules.json") } });

  // The computer: a stand-in window through the patched bridge.
  const MAC = randomUUID();
  const windowSocket = new WebSocket(bridge.url);
  await opened(windowSocket);
  const win = client(windowSocket);
  win.send(auth("Fixture Mac")); win.send({ type: "device", id: MAC });
  await win.wait((m) => m.type === "ready", "window ready");
  const create = async (peer, title) => {
    const requestId = randomUUID();
    peer.send({ type: "session.create", requestId, title, projectPath: `/tmp/${title}` });
    return (await peer.wait((m) => m.type === "response" && m.requestId === requestId, `create ${title}`)).sessionId;
  };
  const shown = await create(win, "window-session");
  const phone = await create(win, "phone-session");
  win.send({ type: "session.subscribe", requestId: randomUUID(), sessionId: shown, afterSequence: 0 });

  // Another computer with its own session.
  const otherSocket = new WebSocket(service, { rejectUnauthorized: false });
  await opened(otherSocket);
  const other = client(otherSocket);
  other.send(auth("Other computer")); other.send({ type: "device", id: randomUUID(), platform: "win32" });
  await other.wait((m) => m.type === "ready", "other ready");
  const foreign = await create(other, "other-computer-session");

  adapter = new CcDeskAdapter(ccDeskConfigSchema.parse({ url: service, fingerprint, deviceId: MAC, controlDirectory: process.env.MOBICODEX_CCDESK_DIR }), { readToken: async () => TOKEN });
  const status = await adapter.probe();
  check("the gateway connects as this computer, sees its sessions and can write", () => {
    assert.equal(status.state, "connected");
    assert.equal(status.loadedSessions.count, 2);
    assert.equal(status.capabilities.sendMessage, true);
  });
  const { sessions } = await adapter.listSessions();
  check("the list holds this computer's sessions only", () => assert.deepEqual(sessions.map((s) => s.title).sort(), ["phone-session", "window-session"]));

  const seen = [];
  const close = await adapter.watchSession(phone, (snapshot) => seen.push(snapshot), () => {});
  const last = () => seen.at(-1);
  const send = await adapter.sendMessage(phone, { controlToken: last().control.token, ...ids(), text: "来自手机的消息", delivery: "queue" });
  await until(() => last().lastTurn?.status === "completed" && last().status === "idle", "phone run completed");
  check("a message from the phone runs in the session and its reply streams back", () => {
    assert.ok(["submitted", "confirmed"].includes(send.delivery), "the relay was answered");
    const texts = last().messages.map((m) => [m.kind, m.text]);
    assert.deepEqual(texts[0], ["user_message", "来自手机的消息"]);
    // The simulation answers in two messages, streamed in pieces of 12 characters: each must read exactly once.
    const reply = last().messages.filter((m) => m.kind === "agent_message");
    assert.deepEqual(reply.map((m) => m.text.trim()), ["已收到：来自手机的消息",
      "这是 **离线模拟回复**。\n\n- 项目目标：Windows\n- 服务适配器：模拟\n- 没有调用 Claude 或其他模型\n\n可继续发送消息。"]);
    assert.deepEqual(reply.map((m) => m.phase), ["commentary", "final_answer"]);
    assert.equal(last().submission.delivery, "confirmed");
  });
  check("the window saw neither the relayed reply nor the phone session's live events", () => {
    assert.ok(!win.seen.some((m) => m.type === "response" && m.requestId === send.clientMessageId));
    assert.ok(!win.seen.some((m) => (m.type === "session.event" && m.event.sessionId === phone) || (m.type === "session.fragment" && m.sessionId === phone)));
  });

  // The computer starts a tool run in the phone's session; the phone approves it.
  const toolRequest = randomUUID();
  win.send({ type: "message.send", requestId: toolRequest, sessionId: phone, text: "需要审批的操作", scenario: "tool" });
  const permission = await until(() => last().permissions[0], "permission card");
  check("the approval shows on the phone with what it is for", () => {
    assert.deepEqual(permission.decisions, ["once", "reject"]);
    assert.equal(permission.unavailableReason, null);
  });
  await adapter.respondPermission(phone, permission.id, { controlToken: last().control.token, ...ids(), decision: "once" });
  await until(() => !last().permissions.length && last().status === "idle", "approved run finished");
  check("the phone's approval lets the run finish", () => assert.equal(last().lastTurn.status, "completed"));

  // A question run, answered from the phone.
  win.send({ type: "message.send", requestId: randomUUID(), sessionId: phone, text: "问我一下", scenario: "question" });
  const question = await until(() => last().questions[0], "question card");
  const answers = question.questions.map((q) => [q.options[0].label]);
  await adapter.respondQuestion(phone, question.id, { controlToken: last().control.token, ...ids(), answers });
  await until(() => !last().questions.length && last().status === "idle", "question run finished");
  check("a question is answered from the phone and the answers reach the run", () => {
    assert.equal(last().lastTurn.status, "completed");
    const reply = last().messages.filter((m) => m.kind === "agent_message").at(-1).text;
    for (const [label] of answers) assert.ok(reply.includes(label), `${label} in ${reply}`);
  });

  // A run stopped from the phone.
  win.send({ type: "message.send", requestId: randomUUID(), sessionId: phone, text: "这一轮要停掉", scenario: "tool" });
  await until(() => last().permissions[0] && last().control.canInterrupt, "second run waiting");
  await adapter.interruptSession(phone, { controlToken: last().control.token, ...ids() });
  await until(() => last().status === "idle" && last().lastTurn?.status === "interrupted", "interrupted");
  check("a run is stopped from the phone", () => assert.equal(last().permissions.length, 0));
  close();

  const hidden = await adapter.watchSession(foreign, () => {}, () => {}).then(() => null, (error) => error.code);
  check("the other computer's session stays hidden", () => assert.equal(hidden, "CCDESK_SESSION_NOT_FOUND"));
  check("no session of this computer was renamed", () => {
    const renamed = win.seen.filter((m) => m.type === "session.updated" && m.session.device?.id === MAC && m.session.device.name !== "Fixture Mac");
    assert.equal(renamed.length, 0);
  });

  let gone = false;
  const closeLast = await adapter.watchSession(phone, () => {}, () => { gone = true; });
  windowSocket.close();
  await until(() => gone, "the reader goes with the window");
  await assert.rejects(adapter.listSessions(), { code: "CCDESK_CONTROL_UNAVAILABLE" });
  const afterClose = await adapter.probe();
  check("with the computer's window gone the gateway lets go and says phone control is off", () => {
    assert.equal(afterClose.capabilities.sendMessage, false);
  });
  closeLast();
  await sleep(300);
  check("the service saw connections of this computer close, none of them by leaving", () => {
    const closes = serviceLog.join("").split("\n").filter((line) => /^Connection \w+ closed after/u.test(line));
    assert.ok(closes.length >= 3, closes.join("\n"));
    assert.ok(!closes.some((line) => line.includes("the client left")), closes.join("\n"));
  });
  // Send, approval, answer and stop.
  check("the bridge logged each relay", () => assert.equal(logs.filter((line) => line.startsWith("MobiCodex control: relayed")).length, 4));
  otherSocket.close();
  await bridge.close();
  console.log(`\n${results.length} checks passed`);
} finally {
  await adapter?.stop();
  for (const child of children) child.kill();
  rmSync(scratch, { recursive: true, force: true });
}
