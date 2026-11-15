import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core";

export type IntakeImage = { path: string; name: string; mimeType: string; size: number };
export type SharePayload = { id: string; text: string | null; subject: string | null; images: IntakeImage[]; skipped: number };
export type ShortcutPayload = { target: "new-task" | "voice" | "thread"; key?: string; title?: string };
type IntakeNative = {
  setRecentThreads(options: { threads: { key: string; title: string }[] }): Promise<void>;
  clear(options: { id?: string }): Promise<void>;
  addListener(event: "share", listener: (value: SharePayload) => void): Promise<PluginListenerHandle>;
  addListener(event: "shortcut", listener: (value: ShortcutPayload) => void): Promise<PluginListenerHandle>;
};
export const Intake = registerPlugin<IntakeNative>("Intake");
export function intakeAvailable() { return Capacitor.isNativePlatform() && Capacitor.isPluginAvailable("Intake"); }
export function shareText(payload: SharePayload) {
  const text = payload.text?.trim() ?? "", subject = payload.subject?.trim() ?? "";
  return subject && !text.includes(subject) ? [subject, text].filter(Boolean).join("\n") : text;
}
export async function shareFiles(payload: SharePayload, fetcher: typeof fetch = fetch): Promise<File[]> {
  const files: File[] = [];
  for (const image of payload.images) {
    const response = await fetcher(Capacitor.convertFileSrc(image.path));
    if (!response.ok) throw new Error(`无法读取分享图片：${image.name}`);
    files.push(new File([await response.blob()], image.name, { type: image.mimeType }));
  }
  return files;
}
