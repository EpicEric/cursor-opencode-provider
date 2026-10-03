import path from "node:path"
import {
  extractHostSubagentCatalog,
  toolsToMcpDescriptors,
  type HostSubagentDefinition,
  type OpencodeToolDef,
} from "../protocol/tools.js"
import {
  loadMergedConfig,
  type OpencodeJson,
} from "./rules.js"
import { collectPlugins } from "./plugins.js"
import { collectGit } from "./git.js"
import { collectProjectLayout } from "./layout.js"
import { buildEnv } from "./env.js"
import { ensureOpencodeProjectDir } from "./paths.js"
import { holdCapabilityOverlay } from "./overlay.js"
import { traceRequestContextPaths } from "../debug.js"

export type BuildRequestContextInput = {
  workspaceRoot: string
  tools?: OpencodeToolDef[]
  providerIdentifier?: string
  /** When set, skills/subagents/plugins are epoch-held for this conversation. */
  conversationId?: string
  /**
   * Preloaded merged `opencode.json` from the same Run (e.g. for interaction
   * guidance MCP server ids). Skips a second `loadMergedConfig` disk read.
   */
  mergedConfig?: OpencodeJson
}

export const DYNAMIC_REQUEST_CONTEXT_KEYS = [
  "tools",
  "custom_subagents",
  "mcp_file_system_options",
  "mcp_meta_tool_options",
  "web_search_enabled",
  "web_fetch_enabled",
  "custom_subagents_info_complete",
  "mcp_file_system_info_complete",
  "mcp_info_complete",
  "hooks_additional_context",
] as const

export type DynamicRequestContextKey = typeof DYNAMIC_REQUEST_CONTEXT_KEYS[number]

/** Host system prompt already carries these; never keep them on a frozen base. */
export const HOST_DUPLICATED_REQUEST_CONTEXT_KEYS = [
  "rules",
  "agent_skills",
  "agent_skills_info_complete",
] as const

type AdvertisedSubagentCatalog = {
  agents: HostSubagentDefinition[]
  complete: boolean
}

/**
 * Advertise only what the host `task` / `subagent` catalog already named.
 */
function buildAdvertisedSubagentCatalog(
  hostSubagents: ReturnType<typeof extractHostSubagentCatalog>,
): AdvertisedSubagentCatalog {
  if (!hostSubagents.executor) return { agents: [], complete: true }
  return { agents: hostSubagents.agents, complete: hostSubagents.complete }
}

function stripHostDuplicatedRequestContextFields(context: Record<string, unknown>): void {
  for (const key of HOST_DUPLICATED_REQUEST_CONTEXT_KEYS) delete context[key]
}

/**
 * Full RequestContext payload for live UMA + exec #10 reply.
 * Workspace env/git/layout plus host-advertised tools and subagents.
 * The provider never looks in Cursor's own directories.
 */
export async function buildRequestContext(
  input: BuildRequestContextInput,
): Promise<Record<string, unknown>> {
  const workspaceRoot = path.resolve(input.workspaceRoot || process.cwd())
  const config = input.mergedConfig ?? await loadMergedConfig(workspaceRoot)
  const [dynamic, git, layout] = await Promise.all([
    buildDynamicRequestContextFromDiscovery(input, workspaceRoot, config),
    collectGit(workspaceRoot),
    collectProjectLayout(workspaceRoot),
  ])

  const base: Record<string, unknown> = {
    env: buildEnv(workspaceRoot),
    repository_info: git.repositoryInfo,
    git_repos: git.gitRepos,
    project_layouts: [layout],
    rules_info_complete: true,
    env_info_complete: true,
    repository_info_complete: true,
    git_repo_info_complete: true,
    git_status_info_complete: true,
  }
  const ctx = materializeRequestContext(base, dynamic)

  traceRequestContextPaths("buildRequestContext", ctx)
  return ctx
}

async function buildDynamicRequestContextFromDiscovery(
  input: BuildRequestContextInput,
  workspaceRoot: string,
  config: OpencodeJson,
): Promise<Record<string, unknown>> {
  const providerIdentifier = input.providerIdentifier ?? "opencode"
  const tools = input.tools ?? []
  const plugins = await collectPlugins(workspaceRoot, config)

  const mcpServerNames = Object.keys(config.mcp ?? {})
  const slim = toolsToMcpDescriptors(tools, providerIdentifier, mcpServerNames, { namesOnly: true })
  const projectDir = ensureOpencodeProjectDir(workspaceRoot)
  const hostSubagents = extractHostSubagentCatalog(tools)
  const advertisedSubagents = buildAdvertisedSubagentCatalog(hostSubagents)
  const customSubagents = advertisedSubagents.agents.map((agent) => ({
    full_path: "",
    name: agent.name,
    description: agent.description || "Host-configured subagent.",
    prompt: `Delegate to the host-configured ${agent.name} subagent; its host instructions and tools apply.`,
  }))
  const livePlugins = plugins.map((p) => ({
    id: p.id,
    line: `opencode-plugin:${p.source}:${p.id}`,
  }))
  const overlay = input.conversationId
    ? holdCapabilityOverlay(input.conversationId, {
        skills: [],
        subagents: customSubagents,
        plugins: livePlugins,
      })
    : { skills: [], subagents: customSubagents, plugins: livePlugins }

  const dynamic: Record<string, unknown> = {
    mcp_file_system_options: {
      enabled: true,
      // Cursor metadata root (mcps / agent-tools), not the git workspace.
      workspace_project_dir: projectDir,
    },
    mcp_meta_tool_options: {
      enabled: true,
      ...(slim.length > 0 ? { mcp_descriptors: slim } : {}),
    },
    // This provider always rejects native web_search/web_fetch interaction
    // queries with a headless-UI reason (see interactions.ts). Advertise that
    // unavailability up front so Cursor prefers the collision-safe
    // custom_web* aliases instead of routing through a query doomed to fail.
    web_search_enabled: false,
    web_fetch_enabled: false,
    custom_subagents_info_complete: advertisedSubagents.complete,
    mcp_file_system_info_complete: true,
    mcp_info_complete: true,
  }
  if (overlay.subagents.length > 0) dynamic.custom_subagents = overlay.subagents

  if (overlay.plugins.length > 0) {
    dynamic.hooks_additional_context = overlay.plugins.map((p) => p.line).join("\n")
  }

  return dynamic
}

/** Rediscover only capability/plugin sections that may change during a chat. */
export async function buildDynamicRequestContext(
  input: BuildRequestContextInput,
): Promise<Record<string, unknown>> {
  const workspaceRoot = path.resolve(input.workspaceRoot || process.cwd())
  const config = input.mergedConfig
    ? input.mergedConfig
    : await loadMergedConfig(workspaceRoot)
  return buildDynamicRequestContextFromDiscovery(input, workspaceRoot, config)
}

/** Keep expensive workspace state frozen while replacing every live capability field. */
export function materializeRequestContext(
  base: Record<string, unknown>,
  dynamic: Record<string, unknown>,
): Record<string, unknown> {
  const context = structuredClone(base)
  stripHostDuplicatedRequestContextFields(context)
  for (const key of DYNAMIC_REQUEST_CONTEXT_KEYS) delete context[key]
  for (const key of DYNAMIC_REQUEST_CONTEXT_KEYS) {
    if (Object.hasOwn(dynamic, key)) context[key] = structuredClone(dynamic[key])
  }
  return context
}

/** Strip live capability fields before retaining/persisting a conversation base. */
export function requestContextBase(
  context: Record<string, unknown>,
): Record<string, unknown> {
  const base = structuredClone(context)
  stripHostDuplicatedRequestContextFields(base)
  for (const key of DYNAMIC_REQUEST_CONTEXT_KEYS) delete base[key]
  return base
}
