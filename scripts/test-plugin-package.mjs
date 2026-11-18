// Checks the built Codex plugin (run `pnpm build:plugin` first): metadata, the catalog-facing layout,
// and that the files a directory catalog copies are enough to start the CLI.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { codexManifest } from './helpers/codex-plugin-manifest.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const plugin = path.join(root, 'dist-plugin/mobile-codex');
const read = async file => JSON.parse(await fs.readFile(path.join(plugin, file), 'utf8'));
const exists = file => fs.stat(path.join(plugin, file)).then(() => true, () => false);

test('the Codex manifest is derived from the portable manifest', async () => {
  const portable = await read('plugin.json');
  const codex = await read('.codex-plugin/plugin.json');
  assert.deepEqual(codex, codexManifest(portable));
  assert.equal(codex.name, 'mobile-codex');
  assert.equal(codex.extensions['com.openai'].onboardingSkill, './skills/mobile-codex/SKILL.md');
  for (const field of ['author', 'homepage', 'repository', 'license', 'keywords']) assert.ok(codex[field], field);
});

test('interface links use HTTPS and assets exist inside the plugin', async () => {
  const { interface: ui } = await read('.codex-plugin/plugin.json');
  for (const field of ['websiteURL', 'privacyPolicyURL', 'termsOfServiceURL']) assert.match(ui[field], /^https:\/\//, field);
  for (const asset of [ui.composerIcon, ui.logo, ...ui.screenshots]) assert.ok(await exists(asset), asset);
  assert.ok((await fs.stat(path.join(plugin, ui.composerIcon))).size < 50 * 1024, 'composer icon stays under 50 KB');
});

test('the runtime lives inside the skill directory', async () => {
  for (const file of ['skills/mobile-codex/SKILL.md', 'skills/mobile-codex/scripts/mobile-codex.mjs', 'skills/mobile-codex/lib/gateway.mjs',
    'scripts/mobile-codex.mjs', 'LICENSE', 'README.md', 'SECURITY.md', 'PRIVACY.md', '.codexignore']) assert.ok(await exists(file), file);
  assert.equal(await exists('lib'), false, 'no runtime outside the skill');
});

test('a catalog-style copy of the bundle can run the CLI', async t => {
  // Mirror only what awesome-codex-plugins copies: manifests, top-level docs, skills/ and interface assets.
  const copy = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-codex-catalog-'));
  t.after(() => fs.rm(copy, { recursive: true, force: true }));
  for (const entry of ['plugin.json', '.codex-plugin', 'README.md', 'SECURITY.md', 'LICENSE', '.codexignore', 'skills', 'assets'])
    await fs.cp(path.join(plugin, entry), path.join(copy, entry), { recursive: true });
  const run = cli => execFileSync(process.execPath, [cli, 'help'], { encoding: 'utf8', env: { ...process.env, HOME: copy } });
  const viaSkill = run(path.join(copy, 'skills/mobile-codex/scripts/mobile-codex.mjs'));
  assert.ok(viaSkill.trim().length > 0);
  assert.equal(run(path.join(plugin, 'scripts/mobile-codex.mjs')), viaSkill, 'the root entry forwards to the same CLI');
});

test('the unbuilt source CLI reports that the plugin must be built', () => {
  const result = spawnSync(process.execPath, [path.join(root, 'plugins/mobile-codex/skills/mobile-codex/scripts/mobile-codex.mjs'), 'help'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});
