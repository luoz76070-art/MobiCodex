// Launched with an isolated HOME before the SDK is imported. Never opens user records.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { createRequire, syncBuiltinESMExports } from 'node:module';
const root = process.env.C4A_TEST_ROOT;
assert.ok(root && process.env.HOME === root);
const project = path.join(root, 'sdk-project'), config = process.env.CLAUDE_CONFIG_DIR;
const id = '10000000-0000-4000-8000-000000000001';
const directory = path.join(config, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
await fs.mkdir(project, { recursive: true }); await fs.mkdir(directory, { recursive: true });
const rows = [
  { type: 'user', uuid: '10000000-0000-4000-8000-000000000002', parentUuid: null, sessionId: id, cwd: project, message: { role: 'user', content: 'Synthetic local question' } },
  { type: 'assistant', uuid: '10000000-0000-4000-8000-000000000003', parentUuid: '10000000-0000-4000-8000-000000000002', sessionId: id, cwd: project, message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic answer' }] } },
];
await fs.writeFile(path.join(directory, `${id}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
let processAttempts = 0, networkAttempts = 0;
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[method] = () => { processAttempts++; throw new Error('PROCESS_BLOCKED'); };
for (const module of [http, https]) for (const method of ['get', 'request']) module[method] = () => { networkAttempts++; throw new Error('NETWORK_BLOCKED'); };
globalThis.fetch = () => { networkAttempts++; throw new Error('NETWORK_BLOCKED'); };
syncBuiltinESMExports();
const sdk = await import('@anthropic-ai/claude-agent-sdk');
const sessions = await sdk.listSessions({ dir: project, includeWorktrees: false });
assert.equal(sessions[0]?.sessionId, id);
assert.equal((await sdk.getSessionInfo(id, { dir: project }))?.sessionId, id);
const messages = await sdk.getSessionMessages(id, { dir: project }); assert.equal(messages.length, 2);
const { ClaudeCliAdapter } = await import('../../dist/agents/claudeCliAdapter.js');
const adapter = new ClaudeCliAdapter({ directories: [project] }, { listSessions: sdk.listSessions, getSessionInfo: sdk.getSessionInfo, getSessionMessages: sdk.getSessionMessages });
assert.equal((await adapter.listSessions()).sessions.length, 1);
let snapshot;
const off = await adapter.watchSession(id, value => { snapshot = value; }, () => {});
assert.deepEqual(snapshot.messages.map(message => message.text), ['Synthetic local question', 'Synthetic answer']);
off(); await adapter.stop();
const require = createRequire(import.meta.url);
const sdkRoot = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
const manifest = JSON.parse(await fs.readFile(path.join(sdkRoot, 'package.json'), 'utf8'));
let nativePackages = 0;
for (const dependency of Object.keys(manifest.optionalDependencies)) {
  try { await fs.access(path.join(path.dirname(sdkRoot), dependency.split('/')[1], 'package.json')); nativePackages++; } catch { /* Optional platform CLI must be absent. */ }
}
console.log(JSON.stringify({ sessions: sessions.length, messages: messages.length, processAttempts, networkAttempts, nativePackages }));
