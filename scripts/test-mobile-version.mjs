import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseAndroidVersion, readAndroidVersion } from '../apps/mobile/scripts/android-version.mjs';

const mobile = fileURLToPath(new URL('../apps/mobile/', import.meta.url));
const gradleFile = path.join(mobile, 'android/app/build.gradle');

async function loadVite() {
  const require = createRequire(path.join(mobile, 'package.json'));
  const pkgFile = require.resolve('vite/package.json');
  const entry = JSON.parse(await readFile(pkgFile, 'utf8')).exports['.'];
  const target = typeof entry === 'string' ? entry : entry.import?.default ?? entry.import ?? entry.default;
  return import(pathToFileURL(path.join(path.dirname(pkgFile), target)).href);
}

test('the app version comes from build.gradle', () => {
  const version = readAndroidVersion(gradleFile);
  assert.match(version.name, /^\d+\.\d+\.\d+$/u);
  assert.ok(Number.isSafeInteger(version.code) && version.code > 0);
  assert.deepEqual(parseAndroidVersion('versionCode 7\n        versionName "1.2.3"\n'), { name: '1.2.3', code: 7 });
  assert.throws(() => parseAndroidVersion('versionName "1.2.3"\n'), /versionCode/u);
});

test('the web build injects the build.gradle version and the source keeps no copy', async () => {
  const version = readAndroidVersion(gradleFile);
  const { loadConfigFromFile } = await loadVite();
  const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(mobile, 'vite.config.ts'), mobile, 'silent');
  assert.equal(loaded.config.define.__APP_VERSION_NAME__, JSON.stringify(version.name));
  assert.equal(loaded.config.define.__APP_VERSION_CODE__, JSON.stringify(version.code));
  const config = await readFile(path.join(mobile, 'src/app/config.ts'), 'utf8');
  assert.match(config, /appVersionName = typeof __APP_VERSION_NAME__/u);
  assert.match(config, /appVersionCode = typeof __APP_VERSION_CODE__/u);
  assert.doesNotMatch(config, /appVersion(Name|Code) = ["\d]/u, 'A hardcoded version drifts from build.gradle');
});
