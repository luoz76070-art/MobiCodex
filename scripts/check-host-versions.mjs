#!/usr/bin/env node
// Daily review (#62): are the installed DeepSeek Harness and OpenCode builds ones MobiCodex verified? Reads only.
// Run through `corepack pnpm check:host-versions` (builds the relay first).
// Exit 0: every installed host is verified or absent. Exit 2: run the isolated checks, or update the linked plugin.
// codexDesktop is informational (#63): its version, and whether the desktop IPC or the shared daemon socket exists.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { harnessSupport, verifiedHarnessVersions } from '../plugins/mobile-deepseek/bridge.mjs';

const relay = new URL('../apps/relay/dist/agents/', import.meta.url);
const { defaultDeepSeekHostPaths, readDeepSeekInstall } = await import(new URL('deepSeekHost.js', relay).href);
const { hostSupport, satisfiesRange } = await import(new URL('hostVersions.js', relay).href);
const { openCodeVerifiedVersions } = await import(new URL('openCodeProtocol.js', relay).href);
const manifest = JSON.parse(await fs.readFile(new URL('../plugins/mobile-deepseek/package.json', import.meta.url), 'utf8'));

const deepseek = await readDeepSeekInstall(defaultDeepSeekHostPaths());
let opencode = null;
try {
  const output = execFileSync('opencode', ['--version'], { encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
  opencode = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/u.exec(output)?.[1] ?? null;
} catch { /* not on PATH */ }

const report = {
  deepseek: {
    installed: deepseek.harness,
    status: deepseek.harness ? harnessSupport(deepseek.harness) ?? 'unsupported' : 'absent',
    linkedPlugin: deepseek.plugin?.version ?? null,
    linkedPluginAccepts: deepseek.harness && deepseek.plugin?.range ? satisfiesRange(deepseek.harness, deepseek.plugin.range) : null,
    repoPlugin: manifest.version,
    repoPluginAccepts: deepseek.harness ? satisfiesRange(deepseek.harness, manifest.engines.dsh) : null,
    verified: verifiedHarnessVersions,
  },
  opencode: { installed: opencode, status: opencode ? hostSupport(opencode, openCodeVerifiedVersions) ?? 'unsupported' : 'absent', verified: openCodeVerifiedVersions },
};
// 'listening', 'stale' (a socket file nobody serves) or 'absent'. Connecting sends nothing.
const socketState = async file => {
  if (!await fs.stat(file).then(() => true, () => false)) return 'absent';
  return new Promise(resolve => {
    const socket = net.createConnection(file);
    const done = state => { socket.destroy(); resolve(state); };
    socket.once('connect', () => done('listening')); socket.once('error', () => done('stale')); socket.setTimeout(2000, () => done('stale'));
  });
};
let codexDesktop = null;
if (process.platform === 'darwin') {
  const plist = await fs.readFile('/Applications/ChatGPT.app/Contents/Info.plist', 'utf8').catch(() => '');
  const home = path.join(os.homedir(), '.codex');
  codexDesktop = { installed: /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]{1,64})<\/string>/u.exec(plist)?.[1] ?? null,
    ipcSocket: await socketState(path.join(home, 'ipc', 'ipc.sock')), daemonSocket: await socketState(path.join(home, 'app-server-control', 'app-server-control.sock')) };
}
report.codexDesktop = codexDesktop;
console.log(JSON.stringify(report, null, 2));
const attention = [report.deepseek.status, report.opencode.status].some(status => status === 'unverified' || status === 'unsupported')
  || report.deepseek.linkedPluginAccepts === false;
process.exitCode = attention ? 2 : 0;
