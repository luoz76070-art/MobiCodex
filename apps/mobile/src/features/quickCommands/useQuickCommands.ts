import { useSyncExternalStore } from "react";
import { defaultQuickCommands, loadQuickCommands, quickCommandsChanged, quickCommandsKey } from "./model";

function subscribe(notify: () => void) {
  const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === quickCommandsKey) notify(); };
  window.addEventListener(quickCommandsChanged, notify);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(quickCommandsChanged, notify);
    window.removeEventListener("storage", onStorage);
  };
}

export function useQuickCommands() {
  return useSyncExternalStore(subscribe, loadQuickCommands, () => defaultQuickCommands);
}
