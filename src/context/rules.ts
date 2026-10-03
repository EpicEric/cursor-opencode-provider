import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { opencodeConfigFileNames, opencodeGlobalConfigDirs, opencodeProjectConfigDirs } from "./paths.js"

export type OpencodeJson = {
  instructions?: string[]
  permission?: unknown
  plugin?: string[]
  plugins?: string[]
  mcp?: Record<string, unknown>
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file)
    return true
  } catch {
    return false
  }
}

async function readJsonConfig(dir: string): Promise<OpencodeJson> {
  for (const name of opencodeConfigFileNames()) {
    const file = path.join(dir, name)
    if (!(await exists(file))) continue
    try {
      const raw = await readFile(file, "utf-8")
      const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
      return JSON.parse(stripped) as OpencodeJson
    } catch {
      return {}
    }
  }
  return {}
}

/** Same truthy rule as OpenCode's Flag.OPENCODE_DISABLE_PROJECT_CONFIG. */
export function isProjectConfigDisabled(): boolean {
  const value = process.env.OPENCODE_DISABLE_PROJECT_CONFIG?.toLowerCase()
  return value === "true" || value === "1"
}

function mergeConfig(base: OpencodeJson, overlay: OpencodeJson): OpencodeJson {
  return {
    ...base,
    ...overlay,
    instructions: [...(base.instructions ?? []), ...(overlay.instructions ?? [])],
    plugin: [...new Set([...(base.plugin ?? []), ...(overlay.plugin ?? [])])],
    plugins: [...new Set([...(base.plugins ?? []), ...(overlay.plugins ?? [])])],
    mcp: { ...(base.mcp ?? {}), ...(overlay.mcp ?? {}) },
    permission: overlay.permission ?? base.permission,
  }
}

/**
 * Merged `opencode.json` / `opencode.jsonc` for MCP server ids, plugin lists,
 * and interaction guidance. Instruction file bodies are not collected here.
 */
export async function loadMergedConfig(workspaceRoot: string): Promise<OpencodeJson> {
  const globalConfig = await readJsonConfig(opencodeGlobalConfigDirs()[0] ?? "")
  if (isProjectConfigDisabled()) return mergeConfig({}, globalConfig)

  // The bridge supplies native project config roots for an unchanged plugin:
  // The active host's project config directories are supplied by the path bridge; OpenCode defaults to .opencode.
  // Later roots have higher precedence, matching the host's native ordering.
  let projectConfig = await readJsonConfig(workspaceRoot)
  for (const configDir of opencodeProjectConfigDirs(workspaceRoot)) {
    projectConfig = mergeConfig(projectConfig, await readJsonConfig(configDir))
  }
  return mergeConfig(globalConfig, projectConfig)
}
