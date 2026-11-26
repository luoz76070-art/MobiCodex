import { ghIssueClient, type FeedbackIssueClient } from "../feedback/github.js";
import { feedbackTargetId } from "../feedback/store.js";
import { FeedbackTargets } from "../feedback/targets.js";
import { gatewayError, type ManagedConfig } from "./config.js";

/** Same registry the running gateway reads, so a change applies without a restart. */
export async function feedbackCommand(command: string, options: Record<string, string>, config: ManagedConfig, dataDirectory: string,
  client: FeedbackIssueClient = ghIssueClient(config.feedback?.github ?? {})) {
  const targets = new FeedbackTargets(dataDirectory, config.feedback?.github?.repos ?? []);
  try {
    if (command === "feedback-repos") return { targets: await targets.list() };
    if (command === "feedback-add") {
      if (!options.repo) throw gatewayError("GATEWAY_USAGE");
      const added = await targets.add({ repo: options.repo, label: options.label }, repo => client.lookup ? client.lookup(repo) : Promise.reject(new Error("lookup unavailable")));
      return { added, note: "手机上重新打开「反馈问题」就能选；网关不用重启。" };
    }
    if (command === "feedback-remove") {
      const id = feedbackTargetId.safeParse(options.id);
      if (!id.success) throw gatewayError("GATEWAY_USAGE");
      await targets.remove(id.data);
      return { removed: id.data, note: "还在等着提交到这个仓库的反馈会停下并写明原因；已提交的不受影响。" };
    }
  } catch (error) {
    const message = (error as Error)?.message;
    if (typeof message === "string" && /^feedback_[a-z_]+$/u.test(message)) throw gatewayError(message.toUpperCase());
    throw error;
  }
  throw gatewayError("GATEWAY_USAGE");
}

export const feedbackErrorMessages: Record<string, string> = {
  FEEDBACK_REPO_INVALID: "仓库要写成 用户名/仓库名，也可以填 github.com 上的仓库链接。",
  FEEDBACK_LABEL_INVALID: "显示名称最多 40 个字，不能有换行等控制字符。",
  FEEDBACK_TARGET_EXISTS: "这个仓库已经在列表里了。",
  FEEDBACK_TARGET_LIMIT: "最多 10 个仓库，请先删掉不用的。",
  FEEDBACK_TARGET_FIXED: "这个仓库写在 gateway.json 的 feedback.github.repos 里，请在配置文件里改，然后重启网关。",
  FEEDBACK_UNKNOWN_TARGET: "列表里没有这个 id，请先运行 feedback repos 查看。",
  FEEDBACK_TARGETS_UNAVAILABLE: "读写反馈仓库列表（数据目录里的 feedback-targets.json）失败，请检查这个文件。",
  FEEDBACK_REPO_NOT_FOUND: "找不到这个仓库，或 gh 登录的账号没有权限。",
  FEEDBACK_REPO_ISSUES_DISABLED: "这个仓库关闭了 issue。",
  FEEDBACK_REPO_PERMISSION: "gh 登录的账号对这个仓库只有只读权限；提交反馈要加标签，需要 triage 及以上权限。",
  FEEDBACK_GH_MISSING: "找不到 gh 命令；请安装 GitHub CLI，或在 gateway.json 的 feedback.github.gh 写上它的绝对路径。",
  FEEDBACK_GH_AUTH: "gh 还没登录 GitHub，请先运行 gh auth login。",
  FEEDBACK_GH_NETWORK: "连不上 GitHub；要经代理时，在 gateway.json 的 feedback.github.proxy 写上代理地址。",
  FEEDBACK_GH_TIMEOUT: "连接 GitHub 超时，请稍后再试。",
  FEEDBACK_GH_FAILED: "gh 没能查到这个仓库的信息，请稍后再试。",
};
