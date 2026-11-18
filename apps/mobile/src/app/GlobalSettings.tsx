import { openFeedback } from '../features/feedback/model';
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, AlertCircle, Bell, CheckCircle2, Clipboard, Copy, Download, ExternalLink, Eye, EyeOff, KeyRound, Loader2, Monitor, Moon, RefreshCcw, Server, Sparkles, Sun, Terminal, Wifi, X } from "lucide-react";
import type { ApprovalPolicy, ConnectionProfile, DiagnosticStep, RelayStatus, SandboxMode, SplitMode, ThemeMode } from "./types";
import { appVersionLabel } from "./config";
import { ConnectionCard } from "../features/connection/ConnectionCard";
import { PairingPanel } from "../features/connection/PairingPanel";
import { VoiceSettings } from "../features/voice/VoiceSettings";
import { QuickCommandSettings } from "../features/quickCommands/QuickCommandSettings";
import { DisclosureSummary } from "../shared/DisclosureSummary";
import { hapticsEnabled, setHapticsEnabled } from "../shared/haptics";
import { useNotifySettings } from "../features/notify/attention";
import { productOpenUpdates } from "../features/product/host";
import { cachedSystemPalette, chatFontScales, loadProductDisplay, loadThemeMode, saveProductDisplay, saveThemeMode, type ProductDisplay } from "../features/product/standalone";
import { loadConnectionProfiles, saveConnectionSettings, profileNameFromEndpoint, upsertConnectionProfile, saveConnectionProfiles } from "../features/connection/profiles";
import { assertSecureEndpoint, toFriendlyFetchError, apiGet as requestGet, buildUrl, normalizeEndpoint } from "../features/connection/http";
import { makeDiagnosticText, openHealthUrl } from "../features/connection/diagnostics";
import { shortPath } from "../features/threads/model";
import { writeClipboard } from "../shared/clipboard";

export type CodexPreferences = {
  splitMode: SplitMode; setSplitMode: (value: SplitMode) => void;
  approvalPolicy: ApprovalPolicy; setApprovalPolicy: (value: ApprovalPolicy) => void;
  sandboxMode: SandboxMode; setSandboxMode: (value: SandboxMode) => void;
};
export type CodexSettingsTools = {
  available: boolean; busy: boolean; message: string;
  exportDiagnostics: (mode: "copy" | "file") => Promise<void>;
  refreshThreads: () => void;
};

export function GlobalSettings({ connection, settingsOpen, onClose, onApply, preferences, codex }: {
  connection: ConnectionProfile; settingsOpen: boolean; onClose: () => void;
  onApply: (profile: ConnectionProfile) => void; preferences: CodexPreferences; codex: CodexSettingsTools | null;
}) {
  const endpoint = normalizeEndpoint(connection.endpoint), token = connection.token;
  const { splitMode, setSplitMode, approvalPolicy, setApprovalPolicy, sandboxMode, setSandboxMode } = preferences;
  const codexRef = useRef(codex);
  codexRef.current = codex;
  const abortRef = useRef(new AbortController());
  useEffect(() => { const controller = new AbortController(); abortRef.current = controller; return () => controller.abort(); }, []);
  const apiGet = <T,>(url: string, auth?: string) => requestGet<T>(url, auth, abortRef.current.signal);
  const [connectionProfiles, setConnectionProfiles] = useState<ConnectionProfile[]>(loadConnectionProfiles);
  const [activeProfileId, setActiveProfileId] = useState(connection.id);
  const [draftEndpoint, setDraftEndpoint] = useState(endpoint);
  const [draftToken, setDraftToken] = useState(token);
  const [theme, setTheme] = useState<ThemeMode>(loadThemeMode);
  const [display, setDisplay] = useState<ProductDisplay>(loadProductDisplay);
  function changeDisplay(patch: Partial<ProductDisplay>) {
    const next = { ...display, ...patch };
    setDisplay(next);
    saveProductDisplay(next);
  }
  const [haptics, setHaptics] = useState(hapticsEnabled);
  const [diagnostics, setDiagnostics] = useState<DiagnosticStep[]>([]);
  const [diagnosticText, setDiagnosticText] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [copied, setCopied] = useState("");
  const [status, setStatus] = useState("连接设置");
  const [connectionState, setConnectionState] = useState<"idle" | "testing" | "ok" | "error">("idle");
  const [relayStatus, setRelayStatus] = useState<RelayStatus | null>(null);
  const notify = useNotifySettings();
  useEffect(() => { saveThemeMode(theme); }, [theme]);
  useEffect(() => { localStorage.setItem("approvalPolicy", approvalPolicy); }, [approvalPolicy]);
  useEffect(() => { localStorage.setItem("sandboxMode", sandboxMode); }, [sandboxMode]);
  useEffect(() => { localStorage.setItem("splitMode", splitMode); }, [splitMode]);

  // Refresh shared computer details when the sheet opens, without changing the current Agent.
  useEffect(() => {
    if (settingsOpen && endpoint && token) void refreshRelayStatus().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen, endpoint, token]);

  async function refreshRelayStatus(): Promise<RelayStatus> {
    try {
      const data = await apiGet<RelayStatus>(buildUrl(endpoint, "/api/status"), token);
      if (!abortRef.current.signal.aborted) setRelayStatus(data);
      return data;
    } catch (error) {
      if (!abortRef.current.signal.aborted) setStatus(toFriendlyFetchError(error));
      throw error;
    }
  }

  async function persistProfiles(profiles: ConnectionProfile[], activeId: string) {
    try {
      assertSecureEndpoint(profiles.find(profile => profile.id === activeId)!.endpoint);
      await saveConnectionProfiles(profiles, activeId);
      return !abortRef.current.signal.aborted;
    } catch (error) { setStatus(toFriendlyFetchError(error)); return false; }
  }

  async function applyPairedConnection(pairedEndpoint: string, pairedToken: string) {
    const profile: ConnectionProfile = { id: activeProfileId, name: profileNameFromEndpoint(pairedEndpoint), endpoint: pairedEndpoint, token: pairedToken, cacheNamespace: crypto.randomUUID(), updatedAt: new Date().toISOString() };
    const next = upsertConnectionProfile(connectionProfiles, profile);
    if (!await persistProfiles(next, profile.id)) throw new Error("设备凭证保存失败，请重新生成配对信息");
    saveConnectionSettings(pairedEndpoint, pairedToken);
    onApply(profile);
  }

  async function saveCurrentProfile() {
    const normalizedEndpoint = normalizeEndpoint(draftEndpoint);
    const now = new Date().toISOString();
    const nextProfile: ConnectionProfile = {
      id: activeProfileId || `profile-${Date.now()}`,
      name: profileNameFromEndpoint(normalizedEndpoint),
      endpoint: normalizedEndpoint,
      token: draftToken,
      cacheNamespace: endpoint === normalizedEndpoint && token === draftToken ? connection.cacheNamespace ?? connection.updatedAt : crypto.randomUUID(),
      updatedAt: now,
    };
    const next = upsertConnectionProfile(connectionProfiles, nextProfile);
    if (!await persistProfiles(next, nextProfile.id)) return;
    setConnectionProfiles(next);
    setActiveProfileId(nextProfile.id);
    saveConnectionSettings(normalizedEndpoint, draftToken);
    onApply(nextProfile);
    setStatus("连接档案已保存");
  }

  async function addConnectionProfile() {
    const id = `profile-${Date.now()}`;
    const nextProfile: ConnectionProfile = {
      id,
      name: "新连接",
      endpoint: "http://127.0.0.1:8787",
      token: "",
      updatedAt: new Date().toISOString(),
    };
    const next = upsertConnectionProfile(connectionProfiles, nextProfile);
    if (!await persistProfiles(next, id)) return;
    setConnectionProfiles(next);
    setActiveProfileId(id);
    onApply(nextProfile);
    setStatus("已新建连接档案");
  }

  async function selectConnectionProfile(profileId: string) {
    const profile = connectionProfiles.find((item) => item.id === profileId);
    if (!profile) return;
    if (!await persistProfiles(connectionProfiles, profile.id)) return;
    setActiveProfileId(profile.id);
    onApply(profile);
    saveConnectionSettings(profile.endpoint, profile.token);
    setStatus(`已切换到 ${profile.name}`);
  }

  async function deleteConnectionProfile() {
    if (connectionProfiles.length <= 1) {
      setStatus("至少保留一个连接档案");
      return;
    }
    const next = connectionProfiles.filter((profile) => profile.id !== activeProfileId);
    const fallback = next[0];
    if (!await persistProfiles(next, fallback.id)) return;
    setConnectionProfiles(next);
    setActiveProfileId(fallback.id);
    onApply(fallback);
    saveConnectionSettings(fallback.endpoint, fallback.token);
    setStatus("连接档案已删除");
  }

  async function testConnection() {
    if (normalizeEndpoint(draftEndpoint) !== endpoint || draftToken !== token) {
      await saveCurrentProfile();
      return;
    }
    setConnectionState("testing");
    setStatus("测试连接中");
    setDiagnostics([]);
    setDiagnosticText("");
    setCopied("");
    saveConnectionSettings(endpoint, token);

    const steps: DiagnosticStep[] = [];
    const startedAt = new Date().toISOString();

    async function runStep(name: string, action: () => Promise<string>) {
      try {
        const detail = await action();
        steps.push({ name, ok: true, detail });
      } catch (error) {
        steps.push({ name, ok: false, detail: toFriendlyFetchError(error) });
        throw error;
      } finally {
        setDiagnostics([...steps]);
      }
    }

    try {
      await runStep("Relay /health", async () => {
        const data = await apiGet<{ ok: boolean }>(buildUrl(endpoint, "/health"));
        if (!data.ok) throw new Error("Relay health returned ok=false");
        return "ok";
      });

      await runStep("Token /api/threads", async () => {
        const data = await apiGet<{ threads: unknown[] }>(buildUrl(endpoint, "/api/threads?limit=1"), token);
        return `ok, threads=${data.threads.length}`;
      });

      await runStep("Live /api/live/health", async () => {
        const data = await apiGet<{ ok: boolean; mode: string; error?: string }>(buildUrl(endpoint, "/api/live/health"), token);
        if (!data.ok) throw new Error(data.error ?? "live health returned ok=false");
        return `ok, mode=${data.mode}`;
      });

      await runStep("Desktop control /api/desktop/control/health", async () => {
        const data = await apiGet<{ ok: boolean; mode: string; error?: string }>(buildUrl(endpoint, "/api/desktop/control/health"), token);
        if (!data.ok) throw new Error(data.error ?? "desktop control returned ok=false");
        return `ok, mode=${data.mode}`;
      });

      await runStep("Status /api/status", async () => {
        const data = await refreshRelayStatus();
        const executable =
          typeof data.codexExecutable === "string"
            ? data.codexExecutable
            : data.codexExecutable?.executable;
        const executableSource =
          typeof data.codexExecutable === "string"
            ? "legacy"
            : data.codexExecutable?.source ?? "unknown";
        const codexDetail = executable
          ? `codex=${shortPath(executable)}`
          : `codex 未找到（${executableSource}）`;
        return `ok, ${codexDetail}, upload=${shortPath(data.uploadDir)}, cwd=${shortPath(data.defaultCwd)}`;
      });

      setConnectionState("ok");
      setStatus("连接测试通过");
      setDiagnosticText(makeDiagnosticText(startedAt, endpoint, steps));
      codexRef.current?.refreshThreads();
    } catch {
      setConnectionState("error");
      setStatus("连接测试失败");
      setDiagnosticText(makeDiagnosticText(startedAt, endpoint, steps));
    }
  }

  async function copyText(text: string, key: string) {
    if (!text) return;
    try {
      await writeClipboard(text);
      setCopied(key);
      setStatus("已复制");
      window.setTimeout(() => setCopied(""), 1600);
    } catch (error) {
      setStatus(`复制失败：${toFriendlyFetchError(error)}`);
    }
  }
  return createPortal(<>
      <div className={`settings-scrim ${settingsOpen ? "show" : ""}`} onClick={() => onClose()} />

      <aside className={`settings-sheet glass-surface ${settingsOpen ? "open" : ""}`} aria-label="设置">
        <div className="settings-heading">
          <div>
            <h2>设置</h2>
            <p data-feedback-error={connectionState === "error" || /失败|无法|拒绝|超时|请等待/.test(status) ? true : undefined}>{status}</p>
          </div>
          <button className="icon-button" onClick={() => onClose()} aria-label="关闭设置">
            <X size={18} />
          </button>
        </div>

        <ConnectionCard endpoint={endpoint} token={token} connectionState={connectionState} open={settingsOpen} />
        <PairingPanel endpoint={endpoint} token={token} onPaired={applyPairedConnection} />
        {settingsOpen && <section className="settings-section"><VoiceSettings endpoint={endpoint} token={token} /></section>}
        {settingsOpen && <QuickCommandSettings />}
        <section className="settings-section"><details className="settings-disclosure advanced-settings"><DisclosureSummary>高级</DisclosureSummary>
          <p className="setting-description">手动填写电脑地址和访问令牌、检查连接、导出诊断。配对成功后一般不需要改。实时会话、桌面控制和会话显示诊断仅 Codex 可用。</p>
          <div className="settings-subsection">
          <h3>手动连接</h3>
          <div className="profile-row">
            <label className="input-field">
              <Server size={16} />
              <select value={activeProfileId} onChange={(event) => selectConnectionProfile(event.target.value)} aria-label="连接档案">
                {connectionProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="icon-button" onClick={addConnectionProfile} aria-label="新增连接档案">
              <Sparkles size={17} />
            </button>
            <button className="icon-button" onClick={deleteConnectionProfile} aria-label="删除连接档案">
              <X size={17} />
            </button>
          </div>
          <div className="field-row">
            <label className="input-field">
              <Server size={16} />
              <input value={draftEndpoint} onChange={(event) => setDraftEndpoint(event.target.value)} placeholder="电脑地址，例如 https://…" aria-label="电脑地址" />
            </label>
            <button className="icon-button" onClick={() => openHealthUrl(endpoint)} aria-label="在浏览器里检查电脑地址" title="在浏览器里检查电脑地址">
              <ExternalLink size={17} />
            </button>
          </div>
          <div className="field-row">
            <label className="input-field">
              <KeyRound size={16} />
              <input
                value={draftToken}
                onChange={(event) => setDraftToken(event.target.value)}
                placeholder="访问令牌" aria-label="访问令牌"
                type={showToken ? "text" : "password"}
              />
            </label>
            <button className="icon-button" onClick={() => setShowToken((value) => !value)} aria-label="显示或隐藏访问令牌">
              {showToken ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
          <div className="settings-actions">
            <button className="action-button primary" onClick={() => void testConnection()} disabled={connectionState === "testing"}>
              {connectionState === "testing" ? <Loader2 size={16} className="spin" /> : <Wifi size={16} />}
              <span>测试连接</span>
            </button>
            <button className="action-button" onClick={() => codex?.refreshThreads()} disabled={!codex}>
              <RefreshCcw size={16} />
              <span>保存刷新（仅 Codex）</span>
            </button>
            <button className="action-button" onClick={saveCurrentProfile}>
              <Clipboard size={16} />
              <span>保存档案</span>
            </button>
          </div>
        </div>
        <div className="settings-subsection">
          <h3>电脑状态</h3>
          <div className="status-grid">
            <span>电脑</span>
            <strong>{connectionState === "ok" ? "在线" : connectionState === "testing" ? "检测中" : "待确认"}</strong>
            <span>实时会话（仅 Codex）</span>
            <strong>{relayStatus?.live?.ok ? "可用" : relayStatus?.live?.error ?? "未检测"}</strong>
            <span>桌面端 Codex（仅 Codex）</span>
            <strong>{relayStatus?.desktopControl?.ok ? "可控制" : relayStatus?.desktopControl?.error ?? "未检测"}</strong>
            <span>上传目录</span>
            <strong>{relayStatus?.uploadDir ? shortPath(relayStatus.uploadDir) : "未检测"}</strong>
          </div>
          <div className="settings-actions">
            <button className="action-button" onClick={() => void refreshRelayStatus().catch(() => undefined)}>
              <Activity size={16} />
              <span>刷新状态</span>
            </button>
            {relayStatus?.uploadDir && (
              <button className="action-button" onClick={() => copyText(relayStatus.uploadDir, "upload-dir")}>
                <Clipboard size={16} />
                <span>{copied === "upload-dir" ? "已复制" : "复制上传目录"}</span>
              </button>
            )}
          </div>
        </div>
          <div className="settings-subsection"><details className="settings-disclosure"><DisclosureSummary>会话显示诊断（仅 Codex）</DisclosureSummary>
          <p className="update-note">出现显示或连接问题时，可复制不超过 2 KB 的摘要。详细报告单独保存为文件，最多 64 KB。仅含版本、身份指纹、数量及连接状态，不含正文、附件路径或密钥。</p>
          <div className="settings-actions"><button className="action-button" disabled={!codex?.available || codex.busy} onClick={() => void codex?.exportDiagnostics("copy")}>
            {codex?.busy ? <Loader2 size={16} className="spin" /> : <Copy size={16} />}
            <span>{codex?.busy ? "正在生成诊断…" : "复制诊断摘要"}</span>
          </button>
          <button className="action-button" disabled={!codex?.available || codex.busy} onClick={() => void codex?.exportDiagnostics("file")}><Download size={16} /><span>保存详细报告</span></button></div>
          {codex?.message && <p className="update-note" role="status">{codex.message}</p>}
        </details></div>
        </details></section>
        <section className="settings-section"><button type="button" className="action-button" onClick={() => openFeedback()}>反馈问题</button></section>
        <section className="settings-section"><h3>应用版本</h3><p>{appVersionLabel}</p><button className="action-button" onClick={() => window.dispatchEvent(new Event(productOpenUpdates))}><Download size={18} /><span>应用更新</span></button></section>

        <section className="settings-section">
          <h3>外观与触感</h3>
          <div className="segmented">
            <button className={theme === "system" ? "active" : ""} onClick={() => setTheme("system")}>
              <Monitor size={15} />
              <span>系统</span>
            </button>
            <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>
              <Sun size={15} />
              <span>浅色</span>
            </button>
            <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>
              <Moon size={15} />
              <span>深色</span>
            </button>
          </div>
          <>
            {cachedSystemPalette() && <label className="haptics-setting">跟随系统取色
              <button type="button" className="action-button" role="switch" aria-label="跟随系统取色" aria-checked={display.dynamicColor} onClick={() => changeDisplay({ dynamicColor: !display.dynamicColor })}>{display.dynamicColor ? "已开启" : "已关闭"}</button>
            </label>}
            <div className="display-setting"><span>聊天字号</span><div className="segmented four" role="radiogroup" aria-label="聊天字号">{chatFontScales.map(option => <button key={option.value} role="radio" aria-checked={display.chatFontScale === option.value} className={display.chatFontScale === option.value ? "active" : ""} onClick={() => changeDisplay({ chatFontScale: option.value })}><span>{option.label}</span></button>)}</div></div>
            <label className="haptics-setting">显示工具卡片
              <button type="button" className="action-button" role="switch" aria-label="显示工具卡片" aria-checked={display.showToolCards} onClick={() => changeDisplay({ showToolCards: !display.showToolCards })}>{display.showToolCards ? "已开启" : "已关闭"}</button>
            </label>
            <label className="haptics-setting">显示工具结果摘要
              <button type="button" className="action-button" role="switch" aria-label="显示工具结果摘要" aria-checked={display.showToolResultSummary} onClick={() => changeDisplay({ showToolResultSummary: !display.showToolResultSummary })}>{display.showToolResultSummary ? "已开启" : "已关闭"}</button>
            </label>
          </>
          <label className="haptics-setting">发送和审批时轻微震动
            <button type="button" className="action-button" role="switch" aria-label="发送和审批时轻微震动" aria-checked={haptics}
              onClick={() => { setHapticsEnabled(!haptics); setHaptics(!haptics); }}>{haptics ? "已开启" : "已关闭"}</button>
          </label>
        </section>

        {notify.available && <section className="settings-section">
          <h3>通知</h3>
          <p className="update-note">手机上发出的任务完成、失败或需要审批时提醒你。只在有任务运行时保持连接，结束后自动断开。</p>
          {notify.permission && notify.permission !== "granted" && <button className="action-button" onClick={() => void notify.allow()}><Bell size={16} /><span>{notify.permission === "denied" ? "通知被系统关掉了，去打开" : "允许通知"}</span></button>}
          <label className="haptics-setting">任务完成时通知
            <button type="button" className="action-button" role="switch" aria-label="任务完成时通知" aria-checked={notify.settings.finished} onClick={() => notify.change({ finished: !notify.settings.finished })}>{notify.settings.finished ? "已开启" : "已关闭"}</button>
          </label>
          {notify.alertHint && <p className="update-note">{notify.alertHint === "off" ? "系统关掉了“任务完成”通知的弹出或震动，任务完成时不会在屏幕上方弹出。" : "任务完成时在屏幕上方弹出并震动。有的手机还要在系统里单独打开“悬浮通知”（或“横幅”）和震动。"}</p>}
          {notify.alertHint && <button className="action-button" onClick={() => void notify.openAlertSettings()}><Bell size={16} /><span>{notify.alertHint === "off" ? "去打开弹出和震动" : "检查“任务完成”通知设置"}</span></button>}
          <label className="haptics-setting">需要审批时通知
            <button type="button" className="action-button" role="switch" aria-label="需要审批时通知" aria-checked={notify.settings.approvals} onClick={() => notify.change({ approvals: !notify.settings.approvals })}>{notify.settings.approvals ? "已开启" : "已关闭"}</button>
          </label>
          <label className="haptics-setting">电脑离线时提醒
            <button type="button" className="action-button" role="switch" aria-label="电脑离线时提醒" aria-checked={notify.settings.offline} onClick={() => notify.change({ offline: !notify.settings.offline })}>{notify.settings.offline ? "已开启" : "已关闭"}</button>
          </label>
          <p className="update-note">仅在等待任务结果的通知服务运行时检查。手机有网络、电脑网关连续两分钟不可达才提醒；重新连上会自动撤掉提醒。手机没网时只显示静默状态。</p>
        </section>}

        <section className="settings-section">
          <h3>运行策略（仅 Codex）</h3>
          <div className="segmented">
            <button className={approvalPolicy === "never" ? "active" : ""} onClick={() => setApprovalPolicy("never")}>
              <CheckCircle2 size={15} />
              <span>直接执行</span>
            </button>
            <button className={approvalPolicy === "on-request" ? "active" : ""} onClick={() => setApprovalPolicy("on-request")}>
              <AlertCircle size={15} />
              <span>需要审批</span>
            </button>
            <button className={sandboxMode === "read-only" ? "active" : ""} onClick={() => setSandboxMode("read-only")}>
              <Eye size={15} />
              <span>只读</span>
            </button>
          </div>
          <div className="segmented">
            <button className={sandboxMode === "workspace-write" ? "active" : ""} onClick={() => setSandboxMode("workspace-write")}>
              <Terminal size={15} />
              <span>工程写入</span>
            </button>
            <button className={sandboxMode === "danger-full-access" ? "active" : ""} onClick={() => setSandboxMode("danger-full-access")}>
              <KeyRound size={15} />
              <span>完整权限</span>
            </button>
          </div>
        </section>


        {(diagnostics.length > 0 || diagnosticText) && (
          <section className={`diagnostics ${connectionState}`}>
            <div className="diagnostics-heading">
              <span>
                {connectionState === "ok" ? <CheckCircle2 size={16} /> : connectionState === "error" ? <AlertCircle size={16} /> : <Activity size={16} />}
                {connectionState === "ok" ? "连接可用" : connectionState === "testing" ? "正在检测" : "连接诊断"}
              </span>
              <button className="text-button" onClick={() => copyText(diagnosticText, "diagnostics")}>
                <Clipboard size={15} />
                <span>{copied === "diagnostics" ? "已复制" : "复制"}</span>
              </button>
            </div>
            <div className="diagnostic-list">
              {diagnostics.map((step) => (
                <div key={step.name} className={`diagnostic-step ${step.ok ? "ok" : "fail"}`}>
                  <strong>{step.name}</strong>
                  <span>{step.detail}</span>
                </div>
              ))}
            </div>
          </section>
        )}
      </aside>
  </>, document.body);
}
