import { build } from 'esbuild';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { codexManifest } from './helpers/codex-plugin-manifest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist-plugin');
const plugin = path.join(output, 'mobile-codex');
// Runtime files sit inside the skill: directory catalogs copy skills/ but not other plugin folders.
const skill = path.join(plugin, 'skills/mobile-codex');
await fs.rm(plugin, { recursive: true, force: true });
await fs.mkdir(plugin, { recursive: true });
await fs.cp(path.join(root, 'plugins/mobile-codex'), plugin, { recursive: true });
await fs.copyFile(path.join(root, 'LICENSE'), path.join(plugin, 'LICENSE'));
await build({
  entryPoints: [path.join(root, 'apps/relay/src/gateway/main.ts')], outfile: path.join(skill, 'lib/gateway.mjs'),
  bundle: true, platform: 'node', target: 'node20', format: 'esm', minify: true,
  define: { __GATEWAY_BUILD_ID__: JSON.stringify(`gateway-${randomUUID()}`) },
  banner: { js: "import { createRequire as _createRequire } from 'node:module'; const require = _createRequire(import.meta.url);" },
});
// Preserve the SDK's own terms beside the gateway bundle that embeds its read helpers.
const relayRequire = createRequire(path.join(root, 'apps/relay/package.json'));
const sdkDirectory = path.dirname(relayRequire.resolve('@anthropic-ai/claude-agent-sdk'));
await fs.copyFile(path.join(sdkDirectory, 'LICENSE.md'), path.join(skill, 'lib/CLAUDE-AGENT-SDK-LICENSE.md'));
// The README's approval screenshot doubles as the plugin directory screenshot.
await fs.copyFile(path.join(root, 'docs/images/screens/approval.jpg'), path.join(plugin, 'assets/approval.jpg'));
const portable = JSON.parse(await fs.readFile(path.join(plugin, 'plugin.json'), 'utf8'));
await fs.mkdir(path.join(plugin, '.codex-plugin'), { recursive: true });
await fs.writeFile(path.join(plugin, '.codex-plugin/plugin.json'), JSON.stringify(codexManifest(portable), null, 2) + '\n');
const marketplace = { name: 'mobile-codex-local', interface: { displayName: 'Mobile Codex 本地预览' }, plugins: [{ name: 'mobile-codex', source: { source: 'local', path: './mobile-codex' }, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Productivity' }] };
await fs.mkdir(path.join(output, '.agents/plugins'), { recursive: true });
await fs.writeFile(path.join(output, '.agents/plugins/marketplace.json'), JSON.stringify(marketplace, null, 2) + '\n');
console.log(`Plugin built: ${plugin}`);
const claudePlugin = path.join(output, 'mobile-claude');
await fs.rm(claudePlugin, { recursive: true, force: true });
await fs.cp(path.join(root, 'plugins/mobile-claude'), claudePlugin, { recursive: true });
await fs.copyFile(path.join(root, 'LICENSE'), path.join(claudePlugin, 'LICENSE'));
console.log(`Claude mod built: ${claudePlugin}`);
const deepSeekPlugin = path.join(output, 'mobile-deepseek');
await fs.rm(deepSeekPlugin, { recursive: true, force: true });
await fs.cp(path.join(root, 'plugins/mobile-deepseek'), deepSeekPlugin, { recursive: true });
await fs.copyFile(path.join(root, 'LICENSE'), path.join(deepSeekPlugin, 'LICENSE'));
console.log(`DeepSeek bundle built: ${deepSeekPlugin}`);
