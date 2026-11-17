import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';

test('native gateway offline decisions execute the production Java state machine', async () => {
  const candidates = [process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, 'bin'), '/opt/homebrew/opt/openjdk@17/bin', '/opt/homebrew/opt/openjdk/bin', ''];
  const java = candidates.find(candidate => {
    if (candidate === undefined) return false;
    try { execFileSync(path.join(candidate, 'javac'), ['-version'], { stdio: 'pipe' }); return true; } catch { return false; }
  });
  assert.notEqual(java, undefined, 'A JDK is required for the native offline decision test');
  await fs.mkdir('output/tests', { recursive: true });
  const output = await fs.mkdtemp(path.resolve('output/tests/offline-classes-'));
  try {
    execFileSync(path.join(java, 'javac'), ['-encoding', 'UTF-8', '-d', output,
      'apps/mobile/android/app/src/main/java/com/mobilecodex/app/GatewayOfflineState.java',
      'apps/mobile/tests/GatewayOfflineStateTest.java'], { stdio: 'pipe' });
    const result = execFileSync(path.join(java, 'java'), ['-cp', output, 'com.mobilecodex.app.GatewayOfflineStateTest'], { encoding: 'utf8' });
    assert.match(result, /threshold, once per outage, recovery, phone network, authentication, settings and lifecycle passed/);
  } finally { await fs.rm(output, { recursive: true, force: true }); }
});

test('the global offline switch reads and updates the shared notification preference', async () => {
  const source = await fs.readFile('apps/mobile/src/app/GlobalSettings.tsx', 'utf8');
  const ast = ts.createSourceFile('GlobalSettings.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let button;
  function visit(node) {
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(ast) === 'button'
      && node.openingElement.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(ast) === 'aria-label' && prop.initializer?.getText(ast) === '"电脑离线时提醒"')) button = node.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast); assert.ok(button, 'offline switch in actual GlobalSettings');
  const js = ts.transpileModule(`const result = (${button});`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
  const notify = { settings: { offline: true }, change(patch) { Object.assign(this.settings, patch); } };
  const render = () => new Function('React', 'notify', js + '; return result;')({ createElement: (type, props, ...children) => ({ type, props, children }) }, notify);
  assert.equal(render().props.role, 'switch'); assert.equal(render().props['aria-checked'], true);
  render().props.onClick(); assert.equal(render().props['aria-checked'], false); assert.deepEqual(render().children, ['已关闭']);
  render().props.onClick(); assert.equal(render().props['aria-checked'], true);
  assert.ok(source.indexOf('电脑离线时提醒') > source.indexOf('<h3>通知</h3>'));
});

test('F5 stays on F1 SSE and notification navigation, with system network and lifecycle guards', async () => {
  const java = name => fs.readFile(`apps/mobile/android/app/src/main/java/com/mobilecodex/app/${name}.java`, 'utf8');
  const [service, channels, bridge, manifest] = await Promise.all([java('AttentionService'), java('AttentionNotifications'), java('AttentionPlugin'), fs.readFile('apps/mobile/android/app/src/main/AndroidManifest.xml', 'utf8')]);
  assert.equal((service.match(/openConnection\(/g) ?? []).length, 1, 'no new network request');
  assert.match(service, /main\.postDelayed\(idleCheck, STATUS_CHECK_MS\)/);
  assert.match(service, /code == 401 \|\| code == 403/);
  assert.match(service, /catch \(Unauthorized error\)[\s\S]*?shutdown\(\)/);
  assert.match(service, /streamGeneration != generation/);
  assert.match(service, /GatewayOfflineState\.Change\.CLEAR\) AttentionNotifications\.cancel/);
  assert.match(service, /if \(worker == null \|\| !worker\.isAlive\(\)\)[\s\S]*?offline\.reset\(\)/);
  assert.match(service, /NET_CAPABILITY_VALIDATED/); assert.match(service, /手机没有网络/);
  assert.match(service, /setOngoing\(true\)\.setSilent\(true\)/);
  assert.match(service, /setContentTitle\("电脑网关离线"\)/); assert.match(service, /最后一次连上/);
  assert.match(service, /AttentionNotifications\.open\(this, AttentionNotifications\.GATEWAY_KEY/);
  assert.match(channels, /GATEWAY_KEY = "gateway"/); assert.match(channels, /new NotificationChannel\(GATEWAY/);
  assert.match(bridge, /AttentionConfig\.offline = Boolean\.TRUE\.equals\(call\.getBoolean\("offline", true\)\)/);
  assert.match(bridge, /else AttentionService\.settingsChanged\(\)/);
  assert.match(manifest, /android\.permission\.ACCESS_NETWORK_STATE/);
});
