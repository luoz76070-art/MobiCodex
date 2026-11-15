// The patched copy itself, in a profile of its own, against a CC Desk service in simulation mode: logs in through
// its window, relays messages through the socket and takes screenshots of the window. Local only; does not touch
// the profile of the client in daily use. Needs the fixture of e2e-fixture.mjs.
//
//   node integrations/cc-desk/test/e2e-electron.mjs --fixture <dir> --app <patched copy> --out <dir for screenshots>
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => (index % 2 ? pairs : [...pairs, [value.replace(/^--/, ""), all[index + 1]]]), []));
const WebSocket = createRequire(join(args.fixture, "package.json"))("ws");
const TOKEN = "fixture-token-0123456789abcdef";
const PORT = 18821, TLS_PORT = 18822, DEBUG_PORT = 9341;
const service = `wss://127.0.0.1:${TLS_PORT}/ws`;
const scratch = mkdtempSync(join(tmpdir(), "ccdesk-electron-"));
const profile = join(scratch, "profile");
const controlDir = join(scratch, "control");
mkdirSync(args.out, { recursive: true });
const children = [];
const check = (name, fn) => { fn(); console.log(`ok - ${name}`); };

function start(command, argv, env, ready) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    let output = "";
    const timer = setTimeout(() => reject(new Error(`${argv[0] ?? command} did not start: ${output.slice(-500)}`)), 20000);
    const listen = (chunk) => { output += chunk; if (!ready || output.includes(ready)) { clearTimeout(timer); resolve(child); } };
    child.stdout.on("data", listen);
    child.stderr.on("data", listen);
  });
}
async function until(test, label, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await test();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
    await sleep(250);
  }
}

// Minimal Chrome DevTools Protocol client for the window.
async function devtools() {
  const list = await until(async () => {
    try { return (await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json()).find((t) => t.type === "page"); } catch { return null; }
  }, "window page");
  const ws = new WebSocket(list.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  let next = 0;
  const waiting = new Map();
  ws.on("message", (raw) => { const m = JSON.parse(raw); waiting.get(m.id)?.(m); waiting.delete(m.id); });
  const call = (method, params = {}) => new Promise((resolve) => { const id = ++next; waiting.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => {
    const m = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (m.result?.exceptionDetails) throw new Error(m.result.exceptionDetails.exception?.description ?? "evaluate failed");
    return m.result?.result?.value;
  };
  const screenshot = async (name) => {
    const m = await call("Page.captureScreenshot", { format: "png" });
    writeFileSync(join(args.out, name), Buffer.from(m.result.data, "base64"));
  };
  return { evaluate, screenshot, close: () => ws.close() };
}

function controlClient(path) {
  const socket = connect(path);
  const lines = [];
  let text = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    text += chunk;
    let end;
    while ((end = text.indexOf("\n")) >= 0) { lines.push(JSON.parse(text.slice(0, end))); text = text.slice(end + 1); }
  });
  const ask = async (request) => {
    const id = randomUUID();
    socket.write(`${JSON.stringify({ id, ...request })}\n`);
    return until(() => lines.find((m) => m.id === id), request.op);
  };
  return { lines, ask, close: () => socket.destroy() };
}

let app;
try {
  await start(process.execPath, [join(args.fixture, "apps/server/src/main.ts")], { PROXY_PORT: String(PORT), PROXY_TOKEN: TOKEN, PROXY_DATA_DIR: join(scratch, "data") }, "Proxy simulation service");
  await start(process.execPath, [join(args.fixture, "tls-front.mjs"), String(TLS_PORT), String(PORT)], {}, "tls front");
  const fingerprint = readFileSync(join(args.fixture, "tls.fingerprint"), "utf8").trim();
  app = await start(join(args.app, "Contents/MacOS/CC Desk Tunnel"), [`--user-data-dir=${profile}`, `--remote-debugging-port=${DEBUG_PORT}`], { MOBICODEX_CCDESK_DIR: controlDir }, "DevTools listening");
  const page = await devtools();
  await until(() => page.evaluate(`!!document.querySelector('input[type=password]')`), "login form");
  // Fill the form the way typing would (React reads the native setter and the input event), without remembering the token.
  await page.evaluate(`(() => {
    const field = (label) => [...document.querySelectorAll('input')].find((e) => e.labels?.[0]?.innerText.trim() === label);
    const type = (e, value) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); };
    type(field('服务地址'), ${JSON.stringify(service)});
    type(field('服务证书指纹（可选）'), ${JSON.stringify(fingerprint)});
    type(field('服务凭据'), ${JSON.stringify(TOKEN)});
    for (const label of ['记住凭据', '自动登录']) { const box = field(label); if (box.checked) box.click(); }
    [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === '连接').click();
  })()`);
  await page.screenshot("1-after-connect.png");
  const socketPath = await until(() => {
    if (!existsSync(controlDir)) return null;
    const name = readdirSync(controlDir).find((n) => n.endsWith(".sock"));
    return name && join(controlDir, name);
  }, "control socket");
  const control = controlClient(socketPath);
  const state = await until(async () => { const s = await control.ask({ op: "status" }); return s.state.writable && s; }, "writable state");
  check("the patched window connects and its socket becomes writable", () => assert.equal(state.state.adapter, "simulation"));

  // A session on this window's computer, made over a connection that says it is the same computer.
  const settings = JSON.parse(readFileSync(join(profile, "settings.json"), "utf8"));
  const deviceId = settings.deviceId ?? settings.device?.id;
  assert.ok(deviceId, `device id not found in settings keys: ${Object.keys(settings)}`);
  const helper = new WebSocket(service, { rejectUnauthorized: false });
  await new Promise((resolve) => helper.once("open", resolve));
  const helperFrames = [];
  helper.on("message", (raw) => helperFrames.push(JSON.parse(raw)));
  helper.send(JSON.stringify({ type: "auth", protocolVersion: 17, token: TOKEN, deviceName: "fixture helper", tunnel: false }));
  helper.send(JSON.stringify({ type: "device", id: deviceId, platform: "darwin" }));
  const createId = randomUUID();
  helper.send(JSON.stringify({ type: "session.create", requestId: createId, title: "手机控制测试", projectPath: "/tmp/mobicodex-control-test" }));
  const session = (await until(() => helperFrames.find((m) => m.type === "response" && m.requestId === createId), "session created")).sessionId;
  helper.close();
  await until(() => page.evaluate(`document.body.innerText.includes('手机控制测试')`), "session listed in the window");
  await page.screenshot("2-session-listed.png");

  const first = await control.ask({ op: "command", command: { type: "message.send", requestId: randomUUID(), sessionId: session, text: "来自手机的第一条消息", scenario: "chat" } });
  check("a message is relayed through the real client", () => assert.deepEqual([first.ok, first.response.ok], [true, true]));
  await sleep(3000);
  await page.screenshot("3-after-phone-message-elsewhere.png");

  // Open the session in the window: the phone's message is in its history.
  await page.evaluate(`(() => { const item = [...document.querySelectorAll('*')].reverse().find((e) => e.childElementCount === 0 && e.textContent.trim() === '手机控制测试'); item.click(); })()`);
  await until(() => page.evaluate(`document.body.innerText.includes('来自手机的第一条消息')`), "phone message in the window");
  await page.screenshot("4-session-open.png");
  const second = await control.ask({ op: "command", command: { type: "message.send", requestId: randomUUID(), sessionId: session, text: "窗口打开时手机发的第二条", scenario: "chat" } });
  await until(() => page.evaluate(`document.body.innerText.includes('窗口打开时手机发的第二条')`), "live phone message in the window");
  await sleep(2500);
  await page.screenshot("5-live-message.png");
  check("with the session open, the phone's message appears in the window live", () => assert.equal(second.response.ok, true));
  const logDir = join(profile, "logs");
  const logText = existsSync(logDir) ? readdirSync(logDir).map((name) => readFileSync(join(logDir, name), "utf8")).join("\n") : "";
  check("the client's own log records the relays", () => assert.ok((logText.match(/MobiCodex control: relayed message\.send/g) ?? []).length >= 2, logText.slice(-800)));
  control.close();
  page.close();
} finally {
  for (const child of children.reverse()) child.kill();
  await sleep(1500);
  rmSync(scratch, { recursive: true, force: true });
}
