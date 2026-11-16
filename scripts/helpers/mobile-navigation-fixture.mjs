import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import ts from 'typescript';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-navigation-'));
await build({ stdin: { contents: "export * from './apps/mobile/src/app/navigation.ts'; export * from './apps/mobile/src/app/sessionTargets.ts'; export { parseAttentionKey } from './apps/mobile/src/features/notify/attention.ts'; export { createBackLayers } from './apps/mobile/src/shared/BackLayers.tsx';", resolveDir: process.cwd(), loader: 'ts' },
  outfile: path.join(dir, 'navigation.cjs'), bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', nodePaths: [path.resolve('apps/mobile/node_modules')], define: { 'import.meta.env': '{}' } });
const oldStorage = globalThis.localStorage;
globalThis.localStorage = { getItem: () => null };
export const navigationModel = createRequire(import.meta.url)(path.join(dir, 'navigation.cjs'));
globalThis.localStorage = oldStorage;
await fs.rm(dir, { recursive: true, force: true });
export function withStorage(storage, action) {
  const old = globalThis.localStorage; globalThis.localStorage = storage;
  try { return action(); } finally { globalThis.localStorage = old; }
}
export function memoryStorage(entries = []) {
  const values = new Map(entries);
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}
const source = await fs.readFile('apps/mobile/src/app/App.tsx', 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const body = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'App').getText(ast).replace('export function', 'function');
const js = ts.transpileModule(body, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
export const findElement = (tree, type) => !tree || typeof tree !== 'object' ? undefined : tree.type === type ? tree : [tree.props?.notice, ...(tree.props?.children?.flat(Infinity) ?? [])].map(child => findElement(child, type)).find(Boolean);

// Execute the actual App handlers, state and effects with synthetic workspaces/network ports.
export function appNavigationFixture(initial = navigationModel.agentPicker(), entries = [], options = {}) {
  const storage = memoryStorage(entries), events = new EventTarget(), slots = [], effects = [];
  let cursor = 0, dirty = true, tree, intake, notification, layerCleanups = [];
  const cleared = [], requests = [];
  const profile = { id: 'test', cacheNamespace: 'fixed', endpoint: '', token: '', name: '测试连接' };
  const scope = 'test:fixed:';
  if (initial) withStorage(storage, () => navigationModel.saveNavigation(scope, initial));
  const h = (type, props, ...children) => ({ type, props: { ...props, children } });
  const hooks = {
    ...navigationModel,
    React: { createElement: h, Suspense: 'Suspense' },
    useState(value) { const index = cursor++; slots[index] ??= { value: typeof value === 'function' ? value() : value };
      return [slots[index].value, update => { const next = typeof update === 'function' ? update(slots[index].value) : update;
        dirty ||= next !== slots[index].value; slots[index].value = next; }]; },
    useRef(value) { return slots[cursor++] ??= { current: value }; },
    useMemo(action, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((v, i) => v !== old.deps[i])) slots[index] = { value: action(), deps }; return slots[index].value; },
    useCallback(callback, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((v, i) => v !== old.deps[i])) slots[index] = { value: callback, deps }; return slots[index].value; },
    useEffect(setup, deps) { const index = cursor++, old = slots[index]; if (!old || deps.some((v, i) => v !== old.deps[i])) effects.push(() => { old?.cleanup?.(); slots[index] = { deps, cleanup: setup() }; }); },
    loadNavigation: (...args) => withStorage(storage, () => navigationModel.loadNavigation(...args)),
    saveNavigation: (...args) => withStorage(storage, () => navigationModel.saveNavigation(...args)),
    sessionTargetNavigation: (...args) => withStorage(storage, () => navigationModel.sessionTargetNavigation(...args)),
    requestNavigationBack() { events.dispatchEvent(new Event('product-back', { cancelable: true })); },
    loadConnectionProfiles: () => [profile], defaultProfileId: profile.id,
    normalizeEndpoint: value => value, defaultSplitMode: 'auto', defaultApprovalPolicy: 'never', defaultSandboxMode: 'workspace-write',
    useVoiceRecovery: () => ({ recovery: {}, notice: null }), useAttention(_endpoint, _token, callback) {
      notification = callback;
      hooks.useEffect(() => { if (options.coldNotification) callback(options.coldNotification); }, []);
    },
    useIntake(callbacks) {
      intake = callbacks;
      hooks.useEffect(() => {
        if (options.coldShare) callbacks.onShare(options.coldShare);
        if (options.coldShortcut) callbacks.onShortcut(options.coldShortcut);
      }, []);
    }, takeProductSettingsLaunch() {}, intakeAvailable: () => true,
    Intake: { async clear(value) { cleared.push(value); } },
    async requestGet(...args) {
      requests.push(args);
      return options.readAgents ? options.readAgents(...args) : { agents: options.agents ?? ['claude', 'deepseek', 'ccdesk', 'opencode'].map(id => ({ id, sessionApi: 1, state: 'connected' })) };
    },
    buildUrl: (_endpoint, route) => route, newThreadId: '__new_thread__', SystemNotice: 'Notice', AbortController,
    productBeforeNavigate: "product-before-navigate", localStorage: storage, window: events, Event,
    BackLayersContext: { Provider: 'Provider' }, BackLayer: 'BackLayer', AgentPicker: 'Picker',
    ProductRemoteShell: 'Shell', WorkItemsPage: 'Items', CapturePanel: 'Capture', AgentWorkspace: 'AgentWorkspace', Workspace: 'Workspace', GlobalSettings: 'Settings',
  };
  const Component = new Function(...Object.keys(hooks), js + '; return App;')(...Object.values(hooks));
  function render() {
    let attempts = 0;
    do {
      if (++attempts > 20) throw new Error('App did not settle');
      dirty = false; cursor = 0; tree = Component();
      for (const run of effects.splice(0)) run();
    } while (dirty);
    layerCleanups.forEach(cleanup => cleanup()); layerCleanups = [];
    const layers = tree.props.value;
    function register(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'BackLayer' && node.props.open) layerCleanups.push(layers.add(node.props.priority, node.props.close));
      for (const child of node.props?.children?.flat(Infinity) ?? []) register(child);
    }
    register(tree); return tree;
  }
  const fixture = { cleared, requests, storage: storage.values, storagePort: storage, events, scope, render, get intake() { return intake; },
    notify: target => notification(target),
    async settle() { for (let i = 0; i < 6; i++) { render(); await new Promise(resolve => setImmediate(resolve)); } return render(); },
    retry() {
      const notice = findElement(render(), 'Notice');
      const button = notice?.props.children.flat(Infinity).find(child => child?.type === 'button' && child.props.children.includes('重试打开'));
      if (!button) throw new Error('retry action missing'); button.props.onClick(); render();
    },
    back() { const event = new Event('product-back', { cancelable: true }); events.dispatchEvent(event); render(); return event; },
    stop() { layerCleanups.forEach(cleanup => cleanup()); for (const slot of slots) slot?.cleanup?.(); },
  };
  render(); return fixture;
}
