import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';

// Execute the real AgentChat render, handlers and effects with isolated transport/UI ports.
// Like the voice driver, this covers wiring, not React DOM scheduling or native lifecycle.
const source = await fs.readFile(new URL('../../apps/mobile/src/features/agents/AgentWorkspace.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('AgentWorkspace.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'AgentChat');
assert.ok(component, 'production AgentChat must be exercised');
const js = ts.transpileModule(component.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText;

export function agentChatDriver(helpers, agentId) {
  let cursor = 0, tree, dirty, mounted = true, historyResponse = { messages: [], cursor: null }, uploadCount = 0;
  const slots = [], effects = [], subscriptions = [], posts = [], reads = [];
  const props = { endpoint: 'https://synthetic.invalid', token: 'synthetic', scopeKey: `test-${agentId}`,
    agent: { id: agentId, label: agentId }, session: { id: 'synthetic-session', title: '合成会话', directory: '' },
    draft: '保留的草稿', onDraft: value => { props.draft = value; }, voiceRecovery: {} };
  const ports = {
    ...helpers,
    useRef: value => slots[cursor++] ??= { current: value },
    useState(value) {
      const index = cursor++; slots[index] ??= { value: typeof value === 'function' ? value() : value };
      return [slots[index].value, next => { const value = typeof next === 'function' ? next(slots[index].value) : next; if (slots[index].value !== value) dirty = true; slots[index].value = value; }];
    },
    useEffect(setup, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => value !== previous.deps[i])) effects.push(() => { previous?.cleanup?.(); slots[index] = { deps, cleanup: setup() }; });
    },
    h: (type, props, ...children) => ({ type, props: { ...props, children } }),
    window: new EventTarget(), productBeforeNavigate: 'productBeforeNavigate',
    requestAnimationFrame() {}, loadReadingPositions: () => ({}), saveReadingPositions() {}, maxMessagesPerThread: 240,
    revokeAttachmentPreviews() {}, mergeAttachments: (current, next) => [...current, ...next],
    uploadAttachments: async () => { uploadCount++; return []; }, composeMessageWithAttachments: text => text,
    buildUrl: (endpoint, route) => endpoint + route,
    apiGet: (_url, _token, signal) => { reads.push({ signal }); return historyResponse; },
    apiPost: async (url, _token, body) => { posts.push({ url, body }); return { delivery: 'confirmed' }; },
    subscribeEvents: options => { subscriptions.push(options); options.onState('connecting'); return () => {}; },
    friendlyError: () => '合成错误', deviceRevokedMessage: '电脑拒绝了这台设备：可能已被撤销，或访问令牌不对。请重新配对。',
    attentionAfterSend: async () => {}, writeClipboard: async () => {},
  };
  for (const name of ['SystemNotice', 'MessageSkeleton', 'MessageTimeline', 'MessageMediaProvider', 'MessageBubble',
    'AgentQuestions', 'PermissionCard', 'AgentQueue', 'AttachmentTray', 'ComputerComposer', 'ComposerSessionStatus', 'VoiceInput']) ports[name] = name;
  const Component = new Function('ports', `const { ${Object.keys(ports).join(', ')} } = ports;\n${js}\nreturn AgentChat;`)(ports);
  function render() {
    assert.ok(mounted);
    do { dirty = false; cursor = 0; tree = Component(props); for (const setup of effects.splice(0)) setup(); } while (dirty);
    return tree;
  }
  function nodes(node) {
    if (Array.isArray(node)) return node.flatMap(nodes);
    return node && typeof node === 'object' ? [node, ...nodes(node.props.children)] : [];
  }
  render();
  return { render, posts, reads, subscription: subscriptions[0],
    node: type => nodes(tree).find(node => node.type === type), uploads: () => uploadCount,
    history: value => { historyResponse = value; },
    state(value) { subscriptions[0].onState(value); render(); },
    snapshot(value) { subscriptions[0].events['agent-session'](value); render(); },
    unmount() { if (!mounted) return; for (const slot of slots) slot?.cleanup?.(); mounted = false; },
  };
}
