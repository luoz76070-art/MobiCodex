import { loadConnectionProfiles } from "../features/connection/profiles";
import { type ThemeMode, type SplitMode, type ApprovalPolicy, type SandboxMode } from "./types";
import { savedNumber } from "../shared/preferences";

export const savedProfiles = loadConnectionProfiles();

export const defaultProfileId = localStorage.getItem("activeConnectionProfileId") ?? savedProfiles[0]?.id ?? "default";

export const defaultEndpoint =
  savedProfiles.find((profile) => profile.id === defaultProfileId)?.endpoint ?? localStorage.getItem("relayEndpoint") ?? "http://127.0.0.1:8787";

export const defaultToken =
  savedProfiles.find((profile) => profile.id === defaultProfileId)?.token ?? localStorage.getItem("relayToken") ?? "";

export const defaultTheme = (localStorage.getItem("themeMode") as ThemeMode | null) ?? "system";

// The split layout follows the screen; the manual choice was removed in #38.
export const defaultSplitMode: SplitMode = "auto";

export const defaultApprovalPolicy = (localStorage.getItem("approvalPolicy") as ApprovalPolicy | null) ?? "never";

export const defaultSandboxMode = (localStorage.getItem("sandboxMode") as SandboxMode | null) ?? "workspace-write";

export const defaultSidePaneSize = savedNumber("sidePaneSize", 320, 96, 520);

export const defaultTopPaneSize = savedNumber("topPaneSize", 220, 110, 520);

export const newThreadId = "__new_thread__";

export const maxMessagesPerThread = 240;

export const desktopLatestMaxBytes = 65_536;

export const desktopLatestMaxMessages = 24;

export const desktopPollActiveMs = 300;

export const desktopPollIdleMs = 1200;

export const livePollFallbackMs = 800;

export const liveSnapshotThrottleMs = 80;

export const smoothTextFrameMs = 26;

export const statusKeepaliveMs = 60_000;

export const threadRuntimeCacheKey = "mobileCodexThreadRuntimeCacheV1";

export const cachedThreadLimit = 24;

export const cachedMessagesPerThread = 120;

// Injected by vite.config.ts from android/app/build.gradle; plain test bundles get the fallbacks.
declare const __APP_VERSION_NAME__: string;
declare const __APP_VERSION_CODE__: number;

export const appVersionName = typeof __APP_VERSION_NAME__ === "undefined" ? "0.0.0-dev" : __APP_VERSION_NAME__;

export const appVersionCode = typeof __APP_VERSION_CODE__ === "undefined" ? 0 : __APP_VERSION_CODE__;

export const appVersionLabel = `v${appVersionName}`;

export const updateManifestUrl = (import.meta.env.VITE_MOBILE_CODEX_UPDATE_MANIFEST_URL ?? "").trim();

export const hotUpdateManifestUrl = (import.meta.env.VITE_MOBILE_CODEX_HOT_MANIFEST_URL ?? "").trim();
