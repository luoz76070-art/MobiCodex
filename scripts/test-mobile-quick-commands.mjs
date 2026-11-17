import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';

// Run the production components with isolated React/DOM/storage ports; no gateway or native calls.
const values = new Map(), events = new EventTarget(), timers = new Map();
let blocked = false, timerId = 0, active;
const storage = { getItem(key) { if (blocked) throw Error('blocked'); return values.get(key) ?? null; },
  setItem(key, value) { if (blocked) throw Error('blocked'); values.set(key, value); } };
const document = { activeElement: null, body: {} };
const element = (type, props, key) => ({ type, props: props ?? {}, key });
class Node {
  isConnected = true;
  style = {};
  scrollHeight = 48;
  focus() { document.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  querySelector(selector) { return this.querySelectorAll(selector)[0]; }
  querySelectorAll(selector) {
    return this.children.flatMap(child => typeof child !== 'object' || !child ? [] : [
      ...(child.type === 'textarea' || (selector.includes('button') && child.type === 'button' && !child.props.disabled) ? [child.dom] : []),
      ...(child.dom?.querySelectorAll(selector) ?? []),
    ]);
  }
}
const hooks = {
  useState(initial) { const frame = active.frame, index = frame.cursor++;
    frame.slots[index] ??= { value: typeof initial === 'function' ? initial() : initial };
    const slot = frame.slots[index], owner = active;
    return [slot.value, update => { const value = typeof update === 'function' ? update(slot.value) : update;
      if (value !== slot.value) { slot.value = value; owner.dirty = true; } }]; },
  useRef(value) { const frame = active.frame; return frame.slots[frame.cursor++] ??= { current: value }; },
  useEffect(setup, deps) { const frame = active.frame, index = frame.cursor++, old = frame.slots[index];
    if (!old || !deps || deps.some((value, i) => value !== old.deps?.[i])) {
      const slot = { deps, cleanup: old?.cleanup }; frame.slots[index] = slot;
      active.effects.push(() => { slot.cleanup?.(); slot.cleanup = setup(); });
    } },
  useLayoutEffect(...args) { hooks.useEffect(...args); },
  useSyncExternalStore(subscribe, snapshot) { const owner = active;
    hooks.useEffect(() => subscribe(() => { owner.dirty = true; }), [subscribe]); return snapshot(); },
  createContext: value => ({ value }), useContext: context => context.value,
};
const bundled = await build({ stdin: { contents: `export * from './apps/mobile/src/features/quickCommands/model.ts';
export { QuickCommands } from './apps/mobile/src/features/quickCommands/QuickCommands.tsx';
export { QuickCommandSettings } from './apps/mobile/src/features/quickCommands/QuickCommandSettings.tsx';
export { ComputerComposer } from './apps/mobile/src/features/chat/ComputerComposer.tsx';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', write: false, loader: { '.css': 'empty' },
  external: ['react', 'react/jsx-runtime', 'react-dom', 'lucide-react'], nodePaths: [path.resolve('apps/mobile/node_modules')] });
const module = { exports: {} };
new Function('module', 'exports', 'require', 'localStorage', 'window', 'document', 'HTMLElement', 'setTimeout', 'clearTimeout', bundled.outputFiles[0].text)(
  module, module.exports, name => {
    if (name === 'react') return hooks;
    if (name === 'react/jsx-runtime') return { jsx: element, jsxs: element, Fragment: 'fragment' };
    if (name === 'react-dom') return { createPortal: tree => tree };
    if (name === 'lucide-react') return new Proxy({}, { get: () => () => null });
    throw Error(`Unexpected dependency: ${name}`);
  }, storage, events, document, Node, action => { timers.set(++timerId, action); return timerId; }, id => timers.delete(id));
const m = module.exports;
function fixture(component, props = {}) {
  const f = { frames: new Map(), nodes: new Map(), effects: [], dirty: true, frame: null, tree: null };
  function walk(node, key) {
    if (Array.isArray(node)) return node.map((child, i) => walk(child, `${key}.${child?.key ?? i}`));
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') {
      const frame = f.frames.get(key) ?? { slots: [] }; f.frames.set(key, frame); frame.seen = true; frame.cursor = 0;
      f.frame = frame; return walk(node.type(node.props), `${key}.render`);
    }
    const dom = f.nodes.get(key) ?? new Node(); f.nodes.set(key, dom);
    dom.value = node.props.value ?? ''; dom.disabled = Boolean(node.props.disabled); dom.isConnected = true;
    if (node.props.ref) node.props.ref.current = dom;
    const children = walk([node.props.children].flat(Infinity), `${key}.children`);
    dom.children = children;
    return { ...node, dom, children };
  }
  f.render = () => {
    active = f;
    let attempts = 0;
    do {
      assert.ok(++attempts < 20, 'component settles'); f.dirty = false;
      for (const frame of f.frames.values()) frame.seen = false;
      f.tree = walk(element(component, props), 'root');
      for (const [key, frame] of f.frames) if (!frame.seen) { frame.slots.forEach(slot => slot?.cleanup?.()); f.frames.delete(key); }
      f.effects.splice(0).forEach(run => run());
    } while (f.dirty);
    return f.tree;
  };
  f.all = predicate => {
    f.render(); const found = [];
    function visit(node) { if (!node || typeof node !== 'object') return; if (Array.isArray(node)) return node.forEach(visit);
      if (predicate(node)) found.push(node); node.children?.forEach(visit); }
    visit(f.tree); return found;
  };
  f.label = label => { const node = f.all(node => node.props['aria-label'] === label)[0]; assert.ok(node, label); return node; };
  f.button = text => { const node = f.all(node => node.type === 'button' && node.children.includes(text))[0]; assert.ok(node, text); return node; };
  f.close = () => { for (const frame of f.frames.values()) frame.slots.forEach(slot => slot?.cleanup?.()); timers.clear(); };
  f.props = props; f.render(); return f;
}
function tickPress() { for (const [id, action] of [...timers]) { timers.delete(id); action(); } }
const touch = { isPrimary: true, pointerType: 'touch', clientX: 20, clientY: 30 };
const event = extras => ({ preventDefault() {}, stopPropagation() {}, ...extras });
test.beforeEach(() => { values.clear(); blocked = false; timers.clear(); document.activeElement = null; });

test('versioned global storage: defaults, round trip, empty list, malformed data, trim and limits', () => {
  assert.match(m.quickCommandsKey, /V\d+$/);
  assert.deepEqual(m.loadQuickCommands(), ['继续', '总结一下目前的进展', '先跑测试，再告诉我结果']);
  let changes = 0; const changed = () => changes++; events.addEventListener(m.quickCommandsChanged, changed);
  m.saveQuickCommands(['  合成指令  ', '', '   ', '甲'.repeat(501), ...Array(22).fill('检查')]);
  const commands = m.loadQuickCommands(); assert.equal(commands.length, 20); assert.equal(commands[0], '合成指令'); assert.equal(commands[1].length, 500);
  assert.equal(m.loadQuickCommands(), commands, 'stable snapshot'); assert.equal(changes, 1);
  assert.equal(values.size, 1, 'one global key'); assert.deepEqual(JSON.parse(values.get(m.quickCommandsKey)), commands);
  m.saveQuickCommands([]); assert.deepEqual(m.loadQuickCommands(), []);
  for (const raw of ['broken', '{}', 'null']) { values.set(m.quickCommandsKey, raw); assert.deepEqual(m.loadQuickCommands(), m.defaultQuickCommands); }
  values.set(m.quickCommandsKey, JSON.stringify([null, 3, '  检查  '])); assert.deepEqual(m.loadQuickCommands(), ['检查']);
  blocked = true; assert.deepEqual(m.loadQuickCommands(), m.defaultQuickCommands); assert.throws(() => m.saveQuickCommands(['检查']), /保存失败/);
  events.removeEventListener(m.quickCommandsChanged, changed);
});

test('click fills empty and existing drafts, focuses the end, preserves limits and never sends', t => {
  for (const initial of ['', '已有内容', '已有内容  ', '  ']) {
    let sends = 0;
    const props = { draft: initial, onDraft: text => { props.draft = text; }, onSend: () => sends++, onStop() {}, onUpload() {}, voice: null, status: '合成状态', placeholder: '', hasContent: true, canSend: true };
    const f = fixture(m.ComputerComposer, props); t.after(f.close);
    f.label('常用指令：继续').props.onClick();
    const input = f.label('消息'); assert.equal(props.draft, initial.trimEnd() ? `${initial.trimEnd()} 继续` : '继续');
    assert.equal(document.activeElement, input.dom); assert.equal(input.dom.selectionStart, props.draft.length); assert.equal(input.dom.selectionEnd, props.draft.length); assert.equal(sends, 0);
  }
  assert.equal(m.appendQuickCommand('原文', '继续', 4), '原文 继');
  assert.equal(m.appendQuickCommand('保留原文', '继续', 2), '保留原文');
});

test('touch long press edits and deletes, and suppresses the release click', t => {
  let chosen = 0; const f = fixture(m.QuickCommands, { disabled: false, onChoose: () => chosen++ }); t.after(f.close);
  const chip = f.label('常用指令：继续'); chip.dom.focus(); chip.props.onPointerDown(touch); tickPress(); chip.props.onPointerUp(); chip.props.onClick();
  f.label('编辑常用指令'); assert.equal(chosen, 0);
  f.all(node => node.type === 'textarea')[0].props.onChange(event({ target: { value: '  合成长按修改  ' } })); f.button('保存').props.onClick();
  assert.equal(m.loadQuickCommands()[0], '合成长按修改');
  f.label('常用指令：合成长按修改').props.onContextMenu(event()); f.button('删除').props.onClick();
  assert.equal(m.loadQuickCommands().length, 2); assert.ok(!m.loadQuickCommands().includes('合成长按修改')); assert.equal(chosen, 0);
});

test('swiping, scrolling, cancellation, leaving, disabling and unmounting cancel long press', t => {
  for (const cancel of ['move', 'scroll', 'pointercancel', 'leave', 'blur', 'disabled', 'unmount']) {
    let chosen = 0; const f = fixture(m.QuickCommands, { disabled: false, onChoose: () => chosen++ }); t.after(f.close);
    const chip = f.label('常用指令：继续'); chip.props.onPointerDown(touch);
    if (cancel === 'move') chip.props.onPointerMove({ clientX: 70, clientY: 30 });
    if (cancel === 'scroll') f.label('常用指令').props.onScrollCapture();
    if (cancel === 'pointercancel') chip.props.onPointerCancel();
    if (cancel === 'leave') chip.props.onPointerLeave();
    if (cancel === 'blur') chip.props.onBlur();
    if (cancel === 'disabled') { f.props.disabled = true; f.render(); }
    if (cancel === 'unmount') f.close();
    tickPress(); assert.equal(f.all(node => node.props.role === 'dialog').length, 0, cancel);
    if (['move', 'scroll', 'pointercancel', 'leave'].includes(cancel)) {
      chip.props.onContextMenu(event()); chip.props.onClick(); assert.equal(chosen, 0, cancel);
    }
    f.close();
  }
});

test('right click and both keyboard menu gestures edit; Escape restores focus and Tab stays in the panel', t => {
  const f = fixture(m.QuickCommands, { disabled: false, onChoose() {} }); t.after(f.close);
  for (const key of ['ContextMenu', 'F10', 'right']) {
    const chip = f.label('常用指令：继续'); chip.dom.focus();
    if (key === 'right') chip.props.onContextMenu(event()); else chip.props.onKeyDown(event({ key, shiftKey: key === 'F10' }));
    const dialog = f.label('编辑常用指令'); assert.equal(document.activeElement, f.all(node => node.type === 'textarea')[0].dom);
    dialog.props.onKeyDown(event({ key: 'Tab', shiftKey: true })); assert.equal(document.activeElement, f.button('保存').dom);
    dialog.props.onKeyDown(event({ key: 'Escape' })); f.render(); assert.equal(document.activeElement, chip.dom);
  }
});

test('global settings add, edit, delete, move, restore, reject blank and enforce twenty commands', t => {
  const f = fixture(m.QuickCommandSettings), bar = fixture(m.QuickCommands, { disabled: false, onChoose() {} }); t.after(f.close); t.after(bar.close);
  f.button('添加指令').props.onClick(); assert.equal(f.button('保存').props.disabled, true);
  f.all(node => node.type === 'textarea')[0].props.onChange(event({ target: { value: '  新指令  ' } })); f.button('保存').props.onClick();
  assert.deepEqual(m.loadQuickCommands(), [...m.defaultQuickCommands, '新指令']); bar.label('常用指令：新指令');
  f.label('上移常用指令：新指令').props.onClick(); assert.equal(m.loadQuickCommands()[2], '新指令');
  f.label('下移常用指令：新指令').props.onClick(); assert.equal(m.loadQuickCommands()[3], '新指令');
  f.label('编辑常用指令：新指令').props.onClick(); f.all(node => node.type === 'textarea')[0].props.onChange(event({ target: { value: '修改' } })); f.button('保存').props.onClick();
  f.label('删除常用指令：修改').props.onClick(); assert.deepEqual(m.loadQuickCommands(), m.defaultQuickCommands);
  m.saveQuickCommands(Array.from({ length: 20 }, (_, i) => `指令${i}`)); assert.equal(f.button('添加指令').props.disabled, true);
  f.button('恢复默认').props.onClick(); assert.deepEqual(m.loadQuickCommands(), m.defaultQuickCommands);
  m.saveQuickCommands([]); assert.equal(bar.all(node => node.props.className === 'quick-commands').length, 0); f.button('恢复默认').props.onClick();
});

test('storage failures keep editing text and show a recoverable error', t => {
  const f = fixture(m.QuickCommandSettings); t.after(f.close);
  f.button('添加指令').props.onClick(); f.all(node => node.type === 'textarea')[0].props.onChange(event({ target: { value: '保留编辑内容' } }));
  blocked = true; f.button('保存').props.onClick(); assert.match(f.all(node => node.props.role === 'alert')[0].children.join(''), /保存失败/);
  assert.equal(f.all(node => node.type === 'textarea')[0].props.value, '保留编辑内容'); blocked = false;
  f.button('保存').props.onClick(); assert.ok(m.loadQuickCommands().includes('保留编辑内容'));
});

test('cross-tab storage updates synchronize the bar, and unrelated keys do not affect commands', t => {
  const f = fixture(m.QuickCommands, { disabled: false, onChoose() {} }); t.after(f.close);
  values.set(m.quickCommandsKey, JSON.stringify(['来自另一页']));
  events.dispatchEvent(Object.assign(new Event('storage'), { key: m.quickCommandsKey })); f.label('常用指令：来自另一页');
  events.dispatchEvent(Object.assign(new Event('storage'), { key: 'unrelated' })); assert.deepEqual(m.loadQuickCommands(), ['来自另一页']);
});

test('disabled chips cannot fill or edit drafts, and mouse presses do not start a long press', t => {
  let chosen = 0; const f = fixture(m.QuickCommands, { disabled: true, onChoose: () => chosen++ }); t.after(f.close);
  const chip = f.label('常用指令：继续');
  chip.props.onClick(); chip.props.onContextMenu(event()); chip.props.onKeyDown(event({ key: 'ContextMenu' }));
  chip.props.onPointerDown(touch); tickPress(); assert.equal(chosen, 0); assert.equal(f.all(node => node.props.role === 'dialog').length, 0);
  f.props.disabled = false; const enabled = f.label('常用指令：继续');
  enabled.props.onPointerDown({ ...touch, pointerType: 'mouse' }); tickPress(); assert.equal(f.all(node => node.props.role === 'dialog').length, 0);
  enabled.props.onPointerUp(); enabled.props.onClick(); assert.equal(chosen, 1);
});

const transpile = source => ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 } }).outputText;
async function composerCall(file, environment) {
  const source = await fs.readFile(file, 'utf8'), ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  function visit(node) { if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(ast) === 'ComputerComposer') expression = node.getText(ast); ts.forEachChild(node, visit); }
  visit(ast); assert.ok(expression, file);
  const scope = { React: { createElement: (type, props) => ({ type, props }) }, ComputerComposer: m.ComputerComposer, ...environment };
  return new Function(...Object.keys(scope), transpile(`const result = (${expression});`) + '; return result;')(...Object.values(scope));
}
test('all six Agent pages render the shared row in the composer position and inherit disabled state', async t => {
  const noop = () => {}, view = () => null;
  for (const id of ['codex', 'claude', 'claude-cli', 'deepseek', 'ccdesk', 'opencode']) for (const disabled of [false, true]) {
    const env = { draft: '合成草稿', editDraft: noop, sendMessage: noop, interruptActiveTurn: noop, openUploadFiles: noop, canControlSelected: !disabled,
      token: 'synthetic', endpoint: '', uploading: false, isLiveTurnActive: false, hasMessageContent: true, submittingMessage: false, sending: false, canSend: true, canInterrupt: false,
      nativeDesktop: false, sessionStatus: null, activeRuntime: {}, isDesktopWatch: false, isDesktopHistoryOnly: false, controlText: '', selected: {}, voiceOpenRequest: 0, workspaceCwd: '', messages: [], scope: 'synthetic', activeThreadKey: 'synthetic', newThreadId: 'new', voiceRecovery: {},
      ComposerSessionStatus: view, VoiceInput: view, Mic: view,
      input: { text: '合成草稿' }, editText: noop, send: noop, operate: noop, uploadInput: { current: null }, readOnly: disabled, online: true, busy: false, attachments: [], sendEnabled: true,
      snapshot: null, control: null, agent: { id, label: id }, session: { directory: '', title: '' }, scopeKey: 'synthetic', draftSession: 'synthetic' };
    const call = await composerCall(id === 'codex' ? 'apps/mobile/src/app/App.tsx' : 'apps/mobile/src/features/agents/AgentWorkspace.tsx', env);
    const f = fixture(call.type, call.props); t.after(f.close);
    const chips = f.all(node => node.props.className === 'quick-command-chip'); assert.equal(chips.length, 3, id);
    assert.ok(chips.every(chip => chip.props.disabled === disabled), id); assert.equal(f.all(node => node.type === 'textarea')[0].props.disabled, disabled);
    const children = f.tree.children.filter(child => child && typeof child === 'object');
    assert.equal(children[1].type, 'fragment'); assert.equal(children[2].props.className, 'composer');
    f.close();
  }
  const settings = await fs.readFile('apps/mobile/src/app/GlobalSettings.tsx', 'utf8'); assert.match(settings, /settingsOpen && <QuickCommandSettings \/>/);
});
