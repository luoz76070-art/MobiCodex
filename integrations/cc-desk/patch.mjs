#!/usr/bin/env node
// Makes a copy of the CC Desk Tunnel desktop client that MobiCodex can relay commands through (see README.md).
// The installed client is only read; everything is written to the copy.
//
//   node integrations/cc-desk/patch.mjs install [--source <app>] [--target <app>] [--force]
//   node integrations/cc-desk/patch.mjs status  [--source <app>] [--target <app>]
//   node integrations/cc-desk/patch.mjs remove  [--target <app>]
//   node integrations/cc-desk/patch.mjs extract --out <dir> [--source <app>]   (for tests)
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { entryOf, packedFiles, readAsar, readEntry, writeAsar } from "./asar.mjs";
import { controlDirectory } from "./control.mjs";

// The one client release the hooks were written against. Anything else is refused rather than patched blind.
export const SUPPORTED = Object.freeze({
  version: "0.3.2",
  bridgeSha256: "6572e13a0246a51eb19fa0ce6c7943c4b0102c8a94282e2d087c2592b92104a6",
});
export const BRIDGE = "electron/proxy-bridge.mjs";
export const CONTROL = "electron/mobicodex-control.mjs";
const ASAR = "Contents/Resources/app.asar";
const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_SOURCE = "/Applications/CC Desk Tunnel.app";
export const DEFAULT_TARGET = join(homedir(), "Applications", "CC Desk Tunnel（手机控制）.app");

export const IMPORT_LINE = 'import { attachControl as mobicodexAttachControl } from "./mobicodex-control.mjs";\n';
// Each anchor is a line of the 0.3.2 bridge and must appear in it exactly once.
export const HOOKS = Object.freeze([
  {
    name: "attach",
    after: "let offerReceived = false;",
    insert: [
      "",
      "\t\tconst mobicodex = mobicodexAttachControl({",
      "\t\t\tsend: (text) => remote.send(text),",
      "\t\t\tisOpen: () => verified && remote.readyState === import_websocket.default.OPEN,",
      "\t\t\tsignal: current.controller.signal,",
      "\t\t\tlog,",
      "\t\t\tprofile: binaries.environment?.CC_DESK_TUNNEL_SCHEDULES,",
      "\t\t\tservice: config.url",
      "\t\t});",
    ].join("\n"),
  },
  { name: "window frames", after: 'const message = JSON.parse(raw.toString("utf8"));', insert: "\n\t\t\t\tmobicodex.fromWindow(message);" },
  {
    name: "service frames",
    before: 'if (message.type === "connection.error" && message.client) release = message.client;',
    insert: "mobicodex.observe(message);\n\t\t\t",
  },
  {
    name: "routing",
    replace: "} else if (local.readyState === import_websocket.default.OPEN) {",
    with: "} else if (mobicodex.consume(message)) {} else if (local.readyState === import_websocket.default.OPEN) {",
  },
]);

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function patchBridge(source) {
  if (source.includes("mobicodexAttachControl")) throw new Error("This bridge is patched already.");
  let text = source;
  for (const hook of HOOKS) {
    const anchor = hook.after ?? hook.before ?? hook.replace;
    const first = text.indexOf(anchor);
    if (first < 0 || text.indexOf(anchor, first + 1) >= 0)
      throw new Error(`Hook "${hook.name}": its anchor must appear exactly once.`);
    const replacement = hook.after ? anchor + hook.insert : hook.before ? hook.insert + anchor : hook.with;
    text = text.slice(0, first) + replacement + text.slice(first + anchor.length);
  }
  return IMPORT_LINE + text;
}

export function inspect(app) {
  const path = join(app, ASAR);
  if (!existsSync(path)) throw new Error(`${app} is not a CC Desk Tunnel app (no ${ASAR}).`);
  const archive = readAsar(path);
  const version = JSON.parse(readEntry(archive, "package.json").toString("utf8")).version;
  const patched = !!entryOf(archive, CONTROL);
  const bridge = readEntry(archive, BRIDGE);
  return { archive, version, patched, bridge, supported: !patched && version === SUPPORTED.version && sha256(bridge) === SUPPORTED.bridgeSha256 };
}

function requireSupported(source) {
  const found = inspect(source);
  if (found.patched) throw new Error(`${source} is a patched copy; point --source at the original client.`);
  if (!found.supported)
    throw new Error(`${source} is CC Desk Tunnel ${found.version}; only ${SUPPORTED.version} (with its original proxy bridge) is supported.`);
  return found;
}

export function changesFor(bridge) {
  return {
    [BRIDGE]: Buffer.from(patchBridge(bridge.toString("utf8")), "utf8"),
    [CONTROL]: readFileSync(join(here, "control.mjs")),
  };
}

// Loads the patched bridge in a separate Node process to be sure it parses and links.
function smokeImport(changes) {
  const directory = mkdtempSync(join(tmpdir(), "mobicodex-ccdesk-"));
  try {
    writeFileSync(join(directory, "proxy-bridge.mjs"), changes[BRIDGE]);
    writeFileSync(join(directory, "mobicodex-control.mjs"), changes[CONTROL]);
    const url = pathToFileURL(join(directory, "proxy-bridge.mjs")).href;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const m = await import(${JSON.stringify(url)}); if (typeof m.openProxyBridge !== "function") process.exit(3);`], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(`The patched bridge does not load: ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

// pgrep cannot see the arguments of apps started from the Dock when run over SSH; ps can.
function running(app) {
  const result = spawnSync("ps", ["-axo", "command="], { encoding: "utf8" });
  const prefix = join(app, "Contents") + "/";
  return result.status === 0 && result.stdout.split("\n").some((line) => line.startsWith(prefix));
}

function moveToTrash(app) {
  const trash = join(homedir(), ".Trash");
  mkdirSync(trash, { recursive: true });
  const destination = join(trash, `${basename(app, ".app")} ${new Date().toISOString().replace(/[:.]/g, "-")}.app`);
  renameSync(app, destination);
  return destination;
}

export function install({ source = DEFAULT_SOURCE, target = DEFAULT_TARGET, force = false } = {}) {
  const original = requireSupported(source);
  const changes = changesFor(original.bridge);
  smokeImport(changes);
  if (existsSync(target)) {
    if (!force) throw new Error(`${target} exists; pass --force to replace it.`);
    if (!inspect(target).patched) throw new Error(`${target} was not made by this script; it is left alone.`);
    if (running(target)) throw new Error("Quit the patched copy first.");
    console.log(`Old copy moved to ${moveToTrash(target)}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  // The original was downloaded and approved once; the copy's signature seal no longer covers its changed
  // archive, so a quarantine flag carried over would make macOS refuse to open it.
  execFileSync("ditto", ["--noqtn", source, target]);
  spawnSync("xattr", ["-dr", "com.apple.quarantine", target]);
  writeAsar(original.archive, changes, join(target, ASAR));
  // Read the copy back: the two changed files as intended, every other file byte for byte the original's.
  const copy = readAsar(join(target, ASAR));
  for (const file of packedFiles(original.archive)) {
    const expected = changes[file] ?? readEntry(original.archive, file);
    if (Buffer.compare(readEntry(copy, file), expected) !== 0) throw new Error(`The copy's ${file} is not what was written.`);
  }
  if (Buffer.compare(readEntry(copy, CONTROL), changes[CONTROL]) !== 0) throw new Error(`The copy's ${CONTROL} is not what was written.`);
  return { target, bridgeSha256: sha256(changes[BRIDGE]), controlSha256: sha256(changes[CONTROL]) };
}

export function remove({ target = DEFAULT_TARGET } = {}) {
  if (!existsSync(target)) return null;
  if (!inspect(target).patched) throw new Error(`${target} was not made by this script; it is left alone.`);
  if (running(target)) throw new Error("Quit the patched copy first.");
  return moveToTrash(target);
}

export function status({ source = DEFAULT_SOURCE, target = DEFAULT_TARGET } = {}) {
  const describe = (app) => {
    if (!existsSync(app)) return { present: false };
    try {
      const found = inspect(app);
      return { present: true, version: found.version, patched: found.patched, supported: found.supported, running: running(app) };
    } catch (error) {
      return { present: true, error: error.message };
    }
  };
  const sockets = [];
  try {
    for (const name of readdirSync(controlDirectory())) {
      if (!name.endsWith(".json")) continue;
      try {
        sockets.push(JSON.parse(readFileSync(join(controlDirectory(), name), "utf8")));
      } catch {}
    }
  } catch {}
  return { source: { path: source, ...describe(source) }, target: { path: target, ...describe(target) }, sockets };
}

export function extract({ source = DEFAULT_SOURCE, out }) {
  const original = requireSupported(source);
  const changes = changesFor(original.bridge);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "proxy-bridge.original.mjs"), original.bridge);
  writeFileSync(join(out, "proxy-bridge.mjs"), changes[BRIDGE]);
  writeFileSync(join(out, "mobicodex-control.mjs"), changes[CONTROL]);
  return out;
}

function main(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === "--force") options.force = true;
    else if (["--source", "--target", "--out"].includes(flag) && rest[index + 1]) options[flag.slice(2)] = rest[++index];
    else throw new Error(`Unknown option ${flag}`);
  }
  if (command === "install") {
    const result = install(options);
    console.log(`Patched copy ready: ${result.target}`);
    console.log("Quit CC Desk Tunnel, then open the copy. To go back, quit the copy and open the original.");
  } else if (command === "status") console.log(JSON.stringify(status(options), null, 2));
  else if (command === "remove") console.log(remove(options) ? "Copy moved to the Trash." : "No copy to remove.");
  else if (command === "extract") {
    if (!options.out) throw new Error("extract needs --out <dir>");
    console.log(extract(options));
  } else {
    console.log("usage: patch.mjs install|status|remove|extract [--source <app>] [--target <app>] [--out <dir>] [--force]");
    process.exitCode = command ? 2 : 0;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
