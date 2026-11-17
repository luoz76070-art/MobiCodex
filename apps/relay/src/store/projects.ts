import fs from "node:fs/promises";
import path from "node:path";
import type { CodexStore } from "./codexStore.js";

export type CodexProject = { name: string; cwd: string };

async function directory(value: unknown): Promise<string | null> {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0")) return null;
  try {
    const cwd = await fs.realpath(value);
    return (await fs.stat(cwd)).isDirectory() ? cwd : null;
  } catch { return null; }
}

/** Desktop state is optional, versioned by the host, and never authoritative for thread control. */
async function desktopRoots(codexHome: string): Promise<unknown[]> {
  try {
    const state: unknown = JSON.parse(await fs.readFile(path.join(codexHome, ".codex-global-state.json"), "utf8"));
    if (!state || typeof state !== "object" || Array.isArray(state)) return [];
    const record = state as Record<string, unknown>, roots: unknown[] = [];
    const projects = record["local-projects"];
    if (projects && typeof projects === "object") {
      for (const project of Object.values(projects)) {
        if (project && typeof project === "object" && Array.isArray(project.rootPaths)) roots.push(...project.rootPaths);
      }
    }
    for (const [key, value] of Object.entries(record)) {
      if ((key === "electron-saved-workspace-roots" || key.startsWith("electron-owner-value:electron-saved-workspace-roots:")) && Array.isArray(value)) roots.push(...value);
    }
    return roots;
  } catch { return []; }
}

export function createProjectCatalog(store: Pick<CodexStore, "listThreads">, codexHome: string, defaultCwd: string) {
  async function list(): Promise<CodexProject[]> {
    const candidates: unknown[] = [defaultCwd, ...await desktopRoots(codexHome)];
    const limit = 200;
    for (let offset = 0; ; offset += limit) {
      const page = await store.listThreads(limit, offset, "", 0);
      candidates.push(...page.map(thread => thread.cwd));
      if (page.length < limit) break;
    }
    const known = new Set<string>();
    for (const candidate of new Set(candidates)) {
      const cwd = await directory(candidate);
      if (cwd) known.add(cwd);
    }
    return [...known].sort().map(cwd => ({ name: path.basename(cwd) || cwd, cwd }));
  }
  return {
    list,
    async requireKnown(value: unknown): Promise<string> {
      const cwd = await directory(value);
      if (cwd && (await list()).some(project => project.cwd === cwd)) return cwd;
      throw Object.assign(new Error("unknown_project"), { code: "unknown_project", statusCode: 400 });
    },
  };
}
