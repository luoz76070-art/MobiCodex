import { validateFeedbackInput, type FeedbackInput, type FeedbackItem } from './model';
export type QueuedFeedback = { scope: string; input: FeedbackInput; createdAt: string };
export type FeedbackQueueStorage = {
  list(scope: string): Promise<QueuedFeedback[]>;
  add(record: QueuedFeedback): Promise<void>;
  remove(scope: string, clientId: string): Promise<void>;
};
export const feedbackQueueLimits = { count: 20, bytes: 30 * 1024 * 1024 };
export function assertFeedbackQueueCapacity(entries: QueuedFeedback[], record: QueuedFeedback) {
  if (entries.some(entry => entry.input.clientId === record.input.clientId)) return;
  if (entries.length >= feedbackQueueLimits.count || entries.reduce((size, entry) => size + JSON.stringify(entry.input).length, JSON.stringify(record.input).length) > feedbackQueueLimits.bytes) throw new Error('待发反馈已满，请先连接电脑补发。');
}
/** IndexedDB avoids the small localStorage quota for an optional 5MiB screenshot. Never stores credentials. */
export function feedbackQueueStorage(): FeedbackQueueStorage {
  let opened: Promise<IDBDatabase> | undefined;
  const db = () => opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('mobicodex-feedback-v1', 1);
    request.onupgradeneeded = () => { const store = request.result.createObjectStore('queue', { keyPath: ['scope', 'input.clientId'] }); store.createIndex('scope', 'scope'); };
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); opened = undefined; }; resolve(request.result); };
    request.onerror = () => { opened = undefined; reject(new Error('反馈存储不可用，内容尚未保存，请保持面板打开。')); };
  });
  async function transaction<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore, set: (value: T) => void, fail: (error: Error) => void) => void): Promise<T> {
    const database = await db();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('queue', mode); let value: T, failure: Error | undefined;
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(failure ?? new Error('反馈保存失败，内容仍在面板中，请释放空间后重试。'));
      run(tx.objectStore('queue'), next => { value = next; }, error => { failure = error; tx.abort(); });
    });
  }
  return {
    list: scope => transaction<QueuedFeedback[]>('readonly', (store, set) => { const request = store.index('scope').getAll(scope); request.onsuccess = () => set(request.result); }),
    add: record => transaction<void>('readwrite', (store, _set, fail) => {
      validateFeedbackInput(record.input);
      const request = store.index('scope').getAll(record.scope);
      request.onsuccess = () => {
        const entries = request.result as QueuedFeedback[];
        try { assertFeedbackQueueCapacity(entries, record); } catch (error) { fail(error as Error); return; }
        if (!entries.some(entry => entry.input.clientId === record.input.clientId)) store.add(record);
      };
    }),
    remove: (scope, id) => transaction<void>('readwrite', store => { store.delete([scope, id]); }),
  };
}
/** Per-scope single flight. A retry always carries the persisted UUID; an uncertain response never deletes it. */
export function createFeedbackSender(options: { scope: string; storage: FeedbackQueueStorage; post: (input: FeedbackInput) => Promise<FeedbackItem>; active: () => boolean; changed: () => void }) {
  let pending: Promise<void> | null = null, again = false;
  function flush(): Promise<void> {
    again = true;
    if (pending) return pending;
    pending = (async () => {
      do {
        again = false;
        const entries = await options.storage.list(options.scope);
        let rejected: unknown;
        for (const entry of entries) {
          if (!options.active()) return;
          let receipt: FeedbackItem;
          try { receipt = await options.post(entry.input); }
          catch (error) {
            // Keep an invalid item for review, but do not let it block other independent feedback.
            if ([400, 413, 422].includes((error as { status?: number }).status ?? 0)) { rejected = error; continue; }
            throw error;
          }
          if (receipt.clientId !== entry.input.clientId || !receipt.id || !receipt.status) throw new Error('反馈回执不匹配，已保留待发记录。');
          // A response from an old connection must not mutate the new scope's UI/queue.
          if (!options.active()) return;
          await options.storage.remove(options.scope, entry.input.clientId); options.changed();
        }
        if (rejected) throw rejected;
      } while (again && options.active());
    })().finally(() => { pending = null; });
    return pending;
  }
  return { flush };
}
