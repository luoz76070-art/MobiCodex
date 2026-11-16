import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

export function createBackLayers() {
  let sequence = 0;
  const layers = new Map<symbol, { priority: number; order: number; close: () => void }>();
  return {
    add(priority: number, close: () => void) {
      const id = Symbol(); layers.set(id, { priority, order: ++sequence, close });
      return () => { layers.delete(id); };
    },
    dismiss() {
      const layer = [...layers.values()].sort((a, b) => b.priority - a.priority || b.order - a.order)[0];
      if (!layer) return false;
      layer.close(); return true;
    },
  };
}
export const BackLayersContext = createContext<ReturnType<typeof createBackLayers> | null>(null);

/** Higher painted layers close first; only the newest layer at the same height closes. */
export function useBackLayer(open: boolean, close: () => void, priority: number) {
  const layers = useContext(BackLayersContext), latest = useRef(close); latest.current = close;
  useEffect(() => open ? layers?.add(priority, () => latest.current()) : undefined, [layers, open, priority]);
}

export function BackLayer({ open, close, priority, children }: { open: boolean; close: () => void; priority: number; children: ReactNode }) {
  useBackLayer(open, close, priority);
  return <>{children}</>;
}
