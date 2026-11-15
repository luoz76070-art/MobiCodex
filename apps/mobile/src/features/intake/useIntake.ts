import { useEffect, useRef } from "react";
import type { PluginListenerHandle } from "@capacitor/core";
import { Intake, intakeAvailable, type SharePayload, type ShortcutPayload } from "./plugin";

export function useIntake({ onShare, onShortcut }: { onShare: (payload: SharePayload) => void; onShortcut: (payload: ShortcutPayload) => void }) {
  const latest = useRef({ onShare, onShortcut }); latest.current = { onShare, onShortcut };
  useEffect(() => {
    if (!intakeAvailable()) return;
    let active = true;
    const handles: PluginListenerHandle[] = [];
    const keep = (handle: PluginListenerHandle) => { if (active) handles.push(handle); else void handle.remove(); };
    void Intake.addListener("share", payload => { if (active) latest.current.onShare(payload); }).then(keep).catch(() => undefined);
    void Intake.addListener("shortcut", payload => { if (active) latest.current.onShortcut(payload); }).then(keep).catch(() => undefined);
    void Intake.clear({}).catch(() => undefined);
    return () => { active = false; for (const handle of handles) void handle.remove(); };
  }, []);
}
