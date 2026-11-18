import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../apps/mobile/src/', import.meta.url));
const files = (await readdir(root, { recursive: true })).map(file => path.join(root, file));
const read = file => readFile(file, 'utf8');

// Classes that are only hooks for tests and DOM queries, or are styled through a parent selector.
const hooks = new Set([
  'text-action', 'advanced-settings', 'agent-create', 'question-other', 'approval-command', 'pairing-section',
  'handoff-resolve', 'item-state-actions', 'product-standalone', 'voice-history', 'voice-history-list', 'brand-mark',
]);

async function usedClasses() {
  const used = new Map();
  for (const file of files.filter(file => file.endsWith('.tsx'))) {
    const source = await read(file);
    for (const match of source.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\}|\{'([^']+)'\})/gu)) {
      // Template parts are dynamic; a token left ending in "-" is a prefix such as diff-${kind}.
      const text = (match[1] ?? match[2] ?? match[3]).replace(/\$\{[^}]*\}/gu, ' ');
      for (const name of text.split(/\s+/u).filter(name => /^[a-zA-Z][\w-]*[a-zA-Z0-9]$/u.test(name))) {
        if (!used.has(name)) used.set(name, new Set());
        used.get(name).add(path.relative(root, file));
      }
    }
  }
  return used;
}

test('every static class used by a component has a style rule or is a known hook', async () => {
  const css = (await Promise.all(files.filter(file => file.endsWith('.css')).map(read))).join('\n');
  const defined = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/gu)].map(match => match[1]));
  const used = await usedClasses();
  const missing = [...used].filter(([name]) => !defined.has(name) && !hooks.has(name)).map(([name, where]) => `${name} (${[...where].join(', ')})`);
  assert.deepEqual(missing, [], 'Classes without any style rule: deleting a rule must not orphan a component');
  const stale = [...hooks].filter(name => !used.has(name) || defined.has(name));
  assert.deepEqual(stale, [], 'Hook list entries that are gone or now styled');
});

test('the work items and capture sheets open as fixed overlays', async () => {
  const css = await read(path.join(root, 'styles.css'));
  const scrim = css.match(/^\.handoff-scrim \{([^}]+)\}/mu)?.[1] ?? '';
  assert.match(scrim, /position: fixed;/u);
  assert.match(scrim, /inset: 0;/u);
  assert.match(css, /^\.handoff-card \{[^}]*background: var\(--panel-solid\)/mu);
  for (const file of ['features/workItems/WorkItemsPage.tsx', 'features/capture/CapturePanel.tsx']) {
    const source = await read(path.join(root, file));
    assert.match(source, /className="handoff-scrim[^"]*"/u, file);
    assert.match(source, /className="handoff-card [^"]*"/u, file);
  }
});
