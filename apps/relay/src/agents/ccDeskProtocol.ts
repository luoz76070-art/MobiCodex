import path from "node:path";
import { z } from "zod";

/** CC Desk Tunnel 0.3.2. A service of another protocol answers `version_mismatch` and is not used. */
export const CCDESK_PROTOCOL = 17;

function serviceUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "wss:" && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
export const ccDeskConfigSchema = z.object({
  url: z.string().max(2048).refine(serviceUrl),
  /** SHA-256 of the service certificate, as CC Desk shows it; without one the system CAs decide. */
  fingerprint: z.string().regex(/^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$|^[0-9A-Fa-f]{64}$/u).optional(),
  /** This Mac's device in CC Desk: only its sessions can be written to. */
  deviceId: z.string().uuid().optional(),
  /** Where the patched client's sockets are; the default is ~/.mobicodex/ccdesk. */
  controlDirectory: z.string().max(4096).refine(value => path.isAbsolute(value)).optional(),
}).strict();
export type CcDeskConfig = z.infer<typeof ccDeskConfigSchema>;
export const CCDESK_KEYCHAIN_SERVICE = "mobicodex-ccdesk";

export const ccDeskId = z.string().uuid();
const device = z.object({ id: ccDeskId, name: z.string().max(200), platform: z.enum(["win32", "darwin", "linux"]).optional() });
export const ccDeskSession = z.object({
  id: ccDeskId,
  title: z.string().max(200),
  projectPath: z.string().max(4096),
  device: device.optional(),
  permissionMode: z.string().max(40).optional(),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
  activeRun: z.object({ id: ccDeskId, status: z.string().max(40), connectionId: z.string().max(80), waiting: z.string().max(40).optional() }).nullable().optional(),
});
export type CcDeskSession = z.infer<typeof ccDeskSession>;
export const ccDeskPayload = z.object({ type: z.string().max(80) }).passthrough();
export type CcDeskPayload = z.infer<typeof ccDeskPayload> & Record<string, unknown>;
export const ccDeskEvent = z.object({ sessionId: ccDeskId, runId: ccDeskId, sequence: z.number().int().positive(), createdAt: z.string().max(40), payload: ccDeskPayload });
export type CcDeskEvent = z.infer<typeof ccDeskEvent>;

const serverMessages = {
  ready: z.object({ type: z.literal("ready"), protocolVersion: z.number(), connectionId: z.string(), adapter: z.string(), version: z.string().max(40), sessions: z.array(ccDeskSession) }),
  response: z.object({ type: z.literal("response"), requestId: z.string(), ok: z.boolean(), sessionId: z.string().optional(), code: z.string().max(80).optional(), message: z.string().max(2000).optional() }),
  "session.snapshot": z.object({ type: z.literal("session.snapshot"), requestId: z.string(), session: ccDeskSession, events: z.array(ccDeskEvent),
    mode: z.enum(["replace", "prepend", "append"]), firstSequence: z.number().int().nonnegative(), lastSequence: z.number().int().nonnegative(), hasEarlier: z.boolean() }),
  "session.updated": z.object({ type: z.literal("session.updated"), session: ccDeskSession }),
  "session.deleted": z.object({ type: z.literal("session.deleted"), sessionId: z.string() }),
  "session.event": z.object({ type: z.literal("session.event"), event: ccDeskEvent }),
  "session.fragment": z.object({ type: z.literal("session.fragment"), sessionId: ccDeskId, runId: ccDeskId, payload: ccDeskPayload }),
  "connection.error": z.object({ type: z.literal("connection.error"), code: z.string().max(80), message: z.string().max(2000).optional() }),
} as const;
type Messages = typeof serverMessages;
export type CcDeskServerMessage = { [K in keyof Messages]: z.infer<Messages[K]> }[keyof Messages];

/** The frames this gateway uses; anything else (terminals, accounts, usage) is dropped. Invalid known frames throw. */
export function parseServerMessage(raw: string): CcDeskServerMessage | null {
  const value: unknown = JSON.parse(raw);
  const type = value && typeof value === "object" ? (value as { type?: unknown }).type : undefined;
  if (typeof type !== "string" || !(type in serverMessages)) return null;
  return serverMessages[type as keyof Messages].parse(value) as CcDeskServerMessage;
}
