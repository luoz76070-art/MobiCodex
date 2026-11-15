// The CC Desk route A pieces that run without a CC Desk install: the asar writer, the bridge hooks and the
// control hook. The end-to-end checks against a CC Desk service are in integrations/cc-desk/test (local only).
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { encodeAsar, packedFiles, readAsar, readEntry, withChanges } from "../integrations/cc-desk/asar.mjs";
import { attachControl, createConnectionControl, RELAYED, socketPathFor } from "../integrations/cc-desk/control.mjs";
import { HOOKS, IMPORT_LINE, patchBridge } from "../integrations/cc-desk/patch.mjs";

const scratch = mkdtempSync(join(tmpdir(), "mc-ccdesk-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function archiveFile(name, header, data) {
  const path = join(scratch, name);
  writeFileSync(path, encodeAsar(header, data));
  return path;
}

test("asar: reads files and writes changes without moving the others", () => {
  const a = Buffer.from("first file");
  const b = Buffer.from("second, in a directory");
  const header = { files: { "a.txt": { size: a.length, offset: "0" }, dir: { files: { "b.txt": { size: b.length, offset: String(a.length) } } }, "u.node": { size: 3, unpacked: true } } };
  const archive = readAsar(archiveFile("plain.asar", header, [a, b]));
  assert.deepEqual(packedFiles(archive), ["a.txt", "dir/b.txt"]);
  assert.equal(readEntry(archive, "dir/b.txt").toString(), b.toString());
  assert.equal(Buffer.compare(withChanges(archive, {}), archive.bytes), 0, "an archive without changes is written back byte for byte");
  const path = join(scratch, "changed.asar");
  writeFileSync(path, withChanges(archive, { "a.txt": Buffer.from("replaced"), "dir/c.txt": Buffer.from("added") }));
  const changed = readAsar(path);
  assert.equal(readEntry(changed, "a.txt").toString(), "replaced");
  assert.equal(readEntry(changed, "dir/c.txt").toString(), "added");
  assert.equal(readEntry(changed, "dir/b.txt").toString(), b.toString());
  assert.equal(changed.header.files.dir.files["b.txt"].offset, String(a.length));
  assert.equal(changed.header.files["a.txt"].integrity.algorithm, "SHA256");
  assert.throws(() => withChanges(archive, { "u.node": Buffer.from("x") }), /cannot be replaced/);
  assert.throws(() => readEntry(archive, "u.node"), /not a file packed/);
});

const anchors = HOOKS.map((hook) => hook.after ?? hook.before ?? hook.replace);
const bridge = ['import { createRequire } from "node:module";', ...anchors.map((anchor, index) => `\t\t// part ${index}\n\t\t${anchor}`), ""].join("\n");

test("bridge hooks: each anchor is used once and nothing else changes", () => {
  const patched = patchBridge(bridge);
  assert.ok(patched.startsWith(IMPORT_LINE));
  assert.match(patched, /const mobicodex = mobicodexAttachControl\(\{/);
  assert.match(patched, /let offerReceived = false;\n\t\tconst mobicodex/);
  assert.match(patched, /mobicodex\.fromWindow\(message\);/);
  assert.match(patched, /mobicodex\.observe\(message\);\n\t\t\tif \(message\.type === "connection\.error"/);
  assert.match(patched, /\} else if \(mobicodex\.consume\(message\)\) \{\} else if \(local\.readyState/);
  const stripped = patched.slice(IMPORT_LINE.length)
    .replace(/\n\t\tconst mobicodex = mobicodexAttachControl\(\{[\s\S]*?\n\t\t\}\);/, "")
    .replace("\n\t\t\t\tmobicodex.fromWindow(message);", "")
    .replace("mobicodex.observe(message);\n\t\t\t", "")
    .replace("} else if (mobicodex.consume(message)) {} else if", "} else if");
  assert.equal(stripped, bridge);
  assert.throws(() => patchBridge(patched), /patched already/);
  assert.throws(() => patchBridge(bridge.replace(anchors[1], "")), /exactly once/);
  assert.throws(() => patchBridge(`${bridge}\n${anchors[2]}`), /exactly once/);
});

function fakeConnection(options = {}) {
  const sent = [];
  const control = createConnectionControl({ send: (text) => sent.push(JSON.parse(text)), timeoutMs: options.timeoutMs ?? 2000, ...options });
  return { control, sent };
}
const event = (sessionId, type = "text.delta") => ({ type: "session.event", event: { sessionId, runId: randomUUID(), sequence: 1, createdAt: "", payload: { type } } });

test("control: writes wait for the execution channel", async () => {
  const { control } = fakeConnection();
  await assert.rejects(control.relay({ type: "run.cancel", requestId: randomUUID(), sessionId: randomUUID(), runId: randomUUID() }), { code: "not_ready" });
  control.observe({ type: "ready", adapter: "claude-code", connectionId: randomUUID(), version: "0.3.2", protocolVersion: 17 });
  assert.equal(control.writable, false);
  control.observe({ type: "tunnel.ready" });
  assert.equal(control.writable, true);
  control.observe({ type: "connection.error" });
  assert.equal(control.writable, false);
  const simulation = fakeConnection().control;
  simulation.observe({ type: "ready", adapter: "simulation" });
  assert.equal(simulation.writable, true);
});

test("control: replies go to the relay, never to the window, even when late", async () => {
  const { control, sent } = fakeConnection({ timeoutMs: 50 });
  control.observe({ type: "ready", adapter: "simulation" });
  const requestId = randomUUID();
  const reply = control.relay({ type: "message.send", requestId, sessionId: randomUUID(), text: "hi" });
  assert.equal(sent[0].requestId, requestId);
  assert.equal(control.consume({ type: "response", requestId, ok: false, code: "other_device", message: "elsewhere" }), true);
  assert.deepEqual(await reply, { ok: false, sessionId: undefined, code: "other_device", message: "elsewhere" });
  const slow = randomUUID();
  await assert.rejects(control.relay({ type: "run.continue", requestId: slow, sessionId: randomUUID() }), { code: "timeout" });
  assert.equal(control.consume({ type: "response", requestId: slow, ok: true }), true, "a reply after the timeout stays off the window");
  assert.equal(control.consume({ type: "response", requestId: randomUUID(), ok: true }), false, "the window's own replies pass");
});

test("control: live events of a session only the phone drives stay off the window", async () => {
  const { control } = fakeConnection();
  control.observe({ type: "ready", adapter: "simulation" });
  const [A, B, C] = [randomUUID(), randomUUID(), randomUUID()];
  control.fromWindow({ type: "session.subscribe", sessionId: A });
  const sending = control.relay({ type: "message.send", requestId: randomUUID(), sessionId: B, text: "from the phone" });
  assert.equal(control.consume(event(B)), true);
  assert.equal(control.consume({ type: "session.fragment", sessionId: B, runId: randomUUID(), payload: { type: "text.delta" } }), true);
  assert.equal(control.consume(event(A)), false);
  assert.equal(control.consume({ type: "session.updated", session: { id: B } }), false, "the session list still updates");
  control.relay({ type: "message.send", requestId: randomUUID(), sessionId: A, text: "to the session on screen" }).catch(() => {});
  assert.equal(control.consume(event(A)), false);
  control.fromWindow({ type: "session.subscribe", sessionId: B });
  assert.equal(control.consume(event(B)), false, "once the window follows it the events are the window's");
  control.relay({ type: "message.send", requestId: randomUUID(), sessionId: C, text: "another" }).catch(() => {});
  assert.deepEqual(control.phoneOnlySessions(), [C]);
  control.fromWindow({ type: "message.send", requestId: randomUUID(), sessionId: C, text: "typed in the window" });
  assert.deepEqual(control.phoneOnlySessions(), []);
  const createId = randomUUID();
  control.relay({ type: "message.send", requestId: randomUUID(), sessionId: A, text: "x" }).catch(() => {});
  control.fromWindow({ type: "session.create", requestId: createId, title: "new", projectPath: "/tmp/new" });
  const created = randomUUID();
  control.observe({ type: "response", requestId: createId, ok: true, sessionId: created });
  control.relay({ type: "message.send", requestId: randomUUID(), sessionId: B, text: "y" }).catch(() => {});
  assert.deepEqual(control.phoneOnlySessions(), [B], "creating a session follows it alone, as the service does");
  control.observe({ type: "session.deleted", sessionId: B });
  assert.deepEqual(control.phoneOnlySessions(), []);
  control.close();
  await assert.rejects(sending, { code: "connection_closed" });
  await assert.rejects(control.relay({ type: "run.continue", requestId: randomUUID(), sessionId: A }), { code: "not_connected" });
});

test("control: hooks never throw into the bridge", () => {
  const { control } = fakeConnection();
  assert.equal(control.consume(null), false);
  assert.doesNotThrow(() => control.observe(undefined));
  assert.doesNotThrow(() => control.fromWindow("not an object"));
});

test("control socket: state, the five commands only, and replies", async (t) => {
  const env = { MOBICODEX_CCDESK_DIR: join(scratch, "control") };
  const abort = new AbortController();
  const sent = [];
  const logs = [];
  const control = attachControl({ send: (text) => sent.push(JSON.parse(text)), isOpen: () => true, signal: abort.signal, log: (line) => logs.push(line), profile: "/profiles/one/schedules.json", service: "wss://service.example/ws", env });
  const path = socketPathFor("/profiles/one/schedules.json", env);
  assert.ok(path.length < 100, "short enough for a Unix socket on macOS");
  const socket = await new Promise((resolve, reject) => {
    const attempt = (left) => {
      const probe = connect(path);
      probe.once("connect", () => resolve(probe));
      probe.once("error", (error) => (left ? setTimeout(() => attempt(left - 1), 50) : reject(error)));
    };
    attempt(40);
  });
  t.after(() => { socket.destroy(); abort.abort(); });
  const lines = [];
  let text = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    text += chunk;
    let end;
    while ((end = text.indexOf("\n")) >= 0) { lines.push(JSON.parse(text.slice(0, end))); text = text.slice(end + 1); }
  });
  const until = async (test) => { for (let i = 0; i < 100; i++) { const found = lines.find(test); if (found) return found; await new Promise((r) => setTimeout(r, 20)); } throw new Error("no such line"); };
  const ask = (request) => { const id = randomUUID(); socket.write(`${JSON.stringify({ id, ...request })}\n`); return until((m) => m.id === id); };

  assert.deepEqual((await until((m) => m.event === "state")).state, { connected: true, writable: false, adapter: null, connectionId: null, serviceVersion: null, protocolVersion: null, device: null, controlVersion: 1 });
  // The window's computer, as it signs in: its name and id are passed on, nothing else of the sign-in.
  const deviceId = randomUUID();
  control.fromWindow({ type: "auth", protocolVersion: 17, token: "SECRET-SIGN-IN-TOKEN", deviceName: "Work Mac.local", tunnel: true });
  control.fromWindow({ type: "device", id: deviceId });
  assert.deepEqual((await until((m) => m.event === "state" && m.state.device)).state.device, { id: deviceId, name: "Work Mac.local" });
  assert.ok(!lines.some((line) => JSON.stringify(line).includes("SECRET")), "the sign-in token never reaches the socket");
  assert.equal((await ask({ op: "command", command: { type: "message.send", requestId: randomUUID(), sessionId: randomUUID(), text: "x" } })).error.code, "not_ready");
  control.observe({ type: "ready", adapter: "simulation", connectionId: randomUUID(), version: "0.3.2", protocolVersion: 17 });
  await until((m) => m.event === "state" && m.state.writable);
  for (const type of ["session.delete", "settings.update", "session.subscribe", "terminal.open", "account.logout"])
    assert.equal((await ask({ op: "command", command: { type, requestId: randomUUID(), sessionId: randomUUID() } })).error.code, "not_allowed");
  assert.equal((await ask({ op: "command", command: { type: "run.cancel", requestId: "1", sessionId: randomUUID() } })).error.code, "bad_request");
  assert.equal((await ask({ op: "nope" })).error.code, "unknown_op");
  assert.deepEqual(RELAYED, ["message.send", "approval.reply", "run.cancel", "run.continue", "run.task.stop"]);

  const requestId = randomUUID();
  const sessionId = randomUUID();
  const id = randomUUID();
  socket.write(`${JSON.stringify({ id, op: "command", command: { type: "approval.reply", requestId, sessionId, runId: randomUUID(), approvalId: randomUUID(), allowed: true } })}\n`);
  for (let i = 0; i < 100 && !sent.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(sent[0].requestId, requestId);
  assert.equal(control.consume({ type: "response", requestId, ok: true, sessionId }), true);
  assert.deepEqual((await until((m) => m.id === id)).response, { ok: true, sessionId });

  const info = JSON.parse(readFileSync(path.replace(/\.sock$/, ".json"), "utf8"));
  assert.equal(info.service, "wss://service.example/ws");
  assert.equal(info.socket, path);
  assert.ok(logs.includes("MobiCodex control: relayed approval.reply."));

  abort.abort();
  await until((m) => m.event === "state" && m.state.connected === false);
  assert.equal((await ask({ op: "status" })).state.connected, false);
  socket.destroy();
});
