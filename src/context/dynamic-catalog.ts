import { resolveToolServerIdentity } from "../protocol/tools.js"

/**
 * Issue #29: Cursor keeps OpenCode `skill` and MCP tools off its native
 * top-level function list. Both OpenCode 1.x and OpenCode 2.0 reach the model
 * as MCP-shaped RequestContext ads, then GetDynamicTools / CallDynamicTool
 * (exec `mcp_args`). This module builds the shared routing guidance and the
 * skill-aware Mid-Conversation nudge used on both hosts.
 *
 * OpenCode 2 still needs `exposeDirectMcpTools` so MCP tools leave Code Mode
 * and enter the AI SDK catalog; without that step they never reach this
 * advertisement path at all.
 */

const MAX_NAMED_SKILLS = 8
const MAX_MCP_SERVERS_IN_GUIDANCE = 8
/** Synthetic server builtins and unknown tools are advertised under (`toolsToMcpDescriptors`). */
const DEFAULT_TOOL_SERVER = "opencode"

/** Common words that carry no skill-matching signal. */
const STOPWORDS = new Set([
  "about", "all", "and", "any", "are", "but", "can", "for", "from", "has", "have",
  "how", "into", "its", "not", "one", "only", "that", "the", "their", "them",
  "then", "there", "these", "this", "use", "used", "uses", "using", "via", "was",
  "what", "when", "which", "who", "why", "will", "with", "you", "your",
  // Host/MCP instruction boilerplate — otherwise a server-instruction dump
  // matches every firecrawl/search skill on "search"/"tools"/"server".
  "tool", "tools", "server", "servers", "call", "calls", "fetch", "search",
  "documentation", "library", "framework", "query", "please", "through",
])

/** An explicit question/request about skills, not incidental prose ("has the skills to"). */
const SKILL_INQUIRY = /\b(?:which|what|list|show|available|any|use|using|call|invoke|load|run)\b[^.?!\n]{0,40}\bskills?\b|\bskills?\b[^.?!\n]{0,40}\b(?:available|installed|loaded|exist|do you have|can you)\b/i

/** Description-only hits above this look like instruction-dump false positives. */
const MAX_DESCRIPTION_ONLY_MATCHES = 2

/**
 * Match against the live user utterance only. Mid-conversation / MCP instruction
 * injections and prior reminders must not re-trigger skill dumps.
 */
function skillMatchCorpus(userText: string): string {
  return userText
    .replace(/<system_reminder\b[^>]*>[\s\S]*?<\/system_reminder>/gi, " ")
    .replace(/<system-update\b[^>]*>[\s\S]*?<\/system-update>/gi, " ")
    .replace(/New MCP server instructions[\s\S]*?(?=\n[A-Z]|\n\n|$)/gi, " ")
}

export type AgentSkillLike = {
  /** OpenCode skill id (frontmatter `name`, else directory name). */
  id?: unknown
  full_path?: unknown
  description?: unknown
  content?: unknown
}

function listWithOverflow(items: readonly string[], limit: number): string {
  const shown = items.slice(0, limit).map((item) => `\`${item}\``).join(", ")
  const hidden = items.length - limit
  return hidden > 0 ? `${shown} (+${hidden} more)` : shown
}

/**
 * Configured MCP servers that own at least one advertised tool. Uses the same
 * server resolution as the RequestContext descriptors, so guidance never names
 * a server Cursor was not given. `toolNames` are OpenCode ids (alias
 * `sourceName` when present).
 */
export function listAdvertisedMcpServers(
  toolNames: Iterable<string>,
  knownMcpServers: Iterable<string> = [],
): string[] {
  const known = [...knownMcpServers]
  if (known.length === 0) return []
  const servers = new Set<string>()
  for (const name of toolNames) {
    const { server } = resolveToolServerIdentity(name, DEFAULT_TOOL_SERVER, known)
    if (server !== DEFAULT_TOOL_SERVER) servers.add(server)
  }
  return [...servers]
}

/** Skill id OpenCode's `skill` tool expects: the discovered id, else `…/skills/<id>/SKILL.md`. */
export function skillNameFromAgentSkill(skill: AgentSkillLike): string | undefined {
  const id = typeof skill.id === "string" ? skill.id.trim() : ""
  if (id) return id
  const fullPath = typeof skill.full_path === "string" ? skill.full_path.trim() : ""
  const parts = fullPath.split(/[\\/]+/).filter(Boolean)
  if (parts.length < 2 || parts.at(-1)!.toLowerCase() !== "skill.md") return undefined
  return parts.at(-2)
}

/**
 * Shared system-guidance line: name advertised dynamic-catalog tools and prefer
 * them over Grep/Shell when skills or project rules apply. Concrete skill ids
 * are deliberately absent: this line is part of the frozen baseline system
 * context, and per-turn ids go through `buildSkillCatalogNudge` instead.
 */
export function buildDynamicCatalogRoutingInstruction(options: {
  toolNames: Iterable<string>
  knownMcpServers?: Iterable<string>
}): string | undefined {
  const names = [...options.toolNames]
  const hasSkill = names.includes("skill")
  const mcpServers = listAdvertisedMcpServers(names, options.knownMcpServers)
  if (!hasSkill && mcpServers.length === 0) return undefined

  const extras: string[] = []
  if (hasSkill) extras.push("`skill`")
  if (mcpServers.length > 0) {
    extras.push(`MCP servers such as ${listWithOverflow(mcpServers, MAX_MCP_SERVERS_IN_GUIDANCE)}`)
  }

  return (
    `- OpenCode host tools that are not in Cursor's native top-level list (including ${extras.join(" and ")}) ` +
    "are reached through GetDynamicTools / CallDynamicTool (or the host's equivalent dynamic catalog). " +
    "When a skill matches or project rules name an MCP server, discover and call those tools that way " +
    "before Grep/Shell fallbacks. Do not narrate that they are unavailable."
  )
}

function wordTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  )
}

function descriptionMatchesUserText(description: string, userTokens: ReadonlySet<string>): boolean {
  let hits = 0
  let distinctive = false
  for (const token of wordTokens(description)) {
    if (!userTokens.has(token)) continue
    hits += 1
    if (token.length >= 8) distinctive = true
    if (hits >= 2) return true
  }
  // Single distinctive token (library names, skill ids) is enough.
  return distinctive
}

function nameMatchesUserText(name: string, userText: string): boolean {
  const haystack = userText.toLowerCase()
  const candidates = [name.toLowerCase(), ...name.toLowerCase().split(/[-_]+/).filter((part) => part.length >= 5)]
  for (const candidate of [...new Set(candidates)]) {
    const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(`(?<![a-z0-9_-])${escaped}(?![a-z0-9_-])`).test(haystack)) return true
  }
  return false
}

/**
 * Mid-Conversation nudge after RequestContext skills are known. Prefer skills
 * that match the user turn; otherwise stay quiet unless the user asked about
 * skills explicitly (avoids dumping dozens of firecrawl-* ids every turn).
 * `hasSkillTool` must reflect what the host permits this turn, not the
 * epoch-held advertisement.
 */
export function buildSkillCatalogNudge(options: {
  hasSkillTool: boolean
  skills: readonly AgentSkillLike[]
  userText?: string
  /**
   * Host skill parameter key from the advertised schema.
   * OpenCode 1.x: `name`. OpenCode 2.0: `id`.
   */
  skillArgKey?: "name" | "id"
}): string | undefined {
  if (!options.hasSkillTool || options.skills.length === 0) return undefined
  const userText = skillMatchCorpus(options.userText ?? "")
  const userTokens = wordTokens(userText)
  const skillInquiry = SKILL_INQUIRY.test(userText)

  const named = options.skills
    .map((skill) => {
      const name = skillNameFromAgentSkill(skill)
      if (!name) return undefined
      const description = typeof skill.description === "string" ? skill.description : ""
      const nameHit = nameMatchesUserText(name, userText)
      const descHit = !!description && descriptionMatchesUserText(description, userTokens)
      return { name, nameHit, descHit }
    })
    .filter((row): row is { name: string; nameHit: boolean; descHit: boolean } => !!row)

  if (named.length === 0) return undefined

  const nameMatched = named.filter((row) => row.nameHit)
  const descOnly = named.filter((row) => row.descHit && !row.nameHit)
  // Mass description-only hits are almost always instruction-dump noise
  // (MCP server blurbs sharing "search"/"tools" with firecrawl skills).
  const descMatched = descOnly.length <= MAX_DESCRIPTION_ONLY_MATCHES ? descOnly : []

  const selected = nameMatched.length > 0
    ? [...nameMatched, ...descMatched]
    : skillInquiry
      ? named
      : descMatched
  if (selected.length === 0) return undefined

  const ids = [...new Set(selected.map((row) => row.name))]
  // Prefer the advertised schema key; fall back to naming both so a stale
  // Mid-Conversation hint cannot contradict GetDynamicTools on either host.
  const argKey = options.skillArgKey
  const callHint = argKey
    ? `Call \`skill\` with \`{ "${argKey}": "<skill-id>" }\` (host schema key is \`${argKey}\`) `
    : "Call `skill` with the skill identifier using the parameter key from GetDynamicTools " +
      "(`name` on OpenCode 1.x, `id` on OpenCode 2.0) "
  return (
    "<system_reminder>\n" +
    "OpenCode skills are invoked with the host `skill` tool through GetDynamicTools / CallDynamicTool " +
    `(MCP server \`${DEFAULT_TOOL_SERVER}\`, tool \`skill\`), not by Grep/Read of SKILL.md. ` +
    `Relevant skill id(s) this turn: ${listWithOverflow(ids, MAX_NAMED_SKILLS)}. ` +
    callHint +
    "before answering from memory or falling back to shell/search tools.\n" +
    "</system_reminder>"
  )
}
