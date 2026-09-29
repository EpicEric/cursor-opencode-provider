/**
 * Epoch-hold live RequestContext overlay lists (skills, subagents, plugins).
 *
 * Same policy as the tool catalog: first nonempty freeze is UTF-16 by id,
 * equal ids keep frozen bytes (including content), new ids append at the
 * tail, shrink keeps the epoch advertisement. Discovery still runs every
 * Run; this only canonicalizes what is advertised.
 */

export const MAX_OVERLAY_HOLDS = 256

export type OverlaySkill = {
  id: string
  full_path: string
  content: string
  description: string
}

export type OverlaySubagent = {
  full_path: string
  name: string
  description: string
  prompt: string
}

export type OverlayPlugin = {
  id: string
  line: string
}

export type OverlayHold = {
  skills: OverlaySkill[]
  subagents: OverlaySubagent[]
  plugins: OverlayPlugin[]
}

export type OverlayWire = {
  skills: Array<{ full_path: string; content: string; description: string }>
  subagents: OverlaySubagent[]
  plugins: OverlayPlugin[]
}

const byConversationId = new Map<string, OverlayHold>()

function utf16(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function inFixedOrder<T>(items: readonly T[], idOf: (item: T) => string): T[] {
  return items
    .map((item) => ({ ...item }))
    .sort((left, right) => utf16(idOf(left), idOf(right)))
}

function holdList<T>(cached: T[] | undefined, incoming: readonly T[], idOf: (item: T) => string): T[] {
  const orderedIncoming = inFixedOrder(incoming, idOf)
  if (!cached || cached.length === 0) return orderedIncoming
  const cachedIds = new Set(cached.map(idOf))
  const hasNew = orderedIncoming.some((item) => !cachedIds.has(idOf(item)))
  if (!hasNew) return cached
  const newcomers = inFixedOrder(
    orderedIncoming.filter((item) => !cachedIds.has(idOf(item))),
    idOf,
  )
  return [...cached, ...newcomers]
}

function remember(conversationId: string, hold: OverlayHold): OverlayHold {
  const stored = {
    skills: structuredClone(hold.skills),
    subagents: structuredClone(hold.subagents),
    plugins: structuredClone(hold.plugins),
  }
  byConversationId.delete(conversationId)
  byConversationId.set(conversationId, stored)
  while (byConversationId.size > MAX_OVERLAY_HOLDS) {
    const oldest = byConversationId.keys().next().value as string | undefined
    if (!oldest) break
    byConversationId.delete(oldest)
  }
  return stored
}

function skillId(skill: OverlaySkill): string {
  return skill.id || skill.full_path
}

function toWire(hold: OverlayHold): OverlayWire {
  return {
    skills: hold.skills.map(({ full_path, content, description }) => ({
      full_path,
      content,
      description,
    })),
    subagents: hold.subagents,
    plugins: hold.plugins,
  }
}

/** Merge live discovery into the conversation overlay epoch. */
export function holdCapabilityOverlay(
  conversationId: string,
  live: OverlayHold,
): OverlayWire {
  if (!conversationId) {
    return toWire({
      skills: inFixedOrder(live.skills, skillId),
      subagents: inFixedOrder(live.subagents, (agent) => agent.name),
      plugins: inFixedOrder(live.plugins, (plugin) => plugin.id),
    })
  }
  const cached = byConversationId.get(conversationId)
  const next: OverlayHold = {
    skills: holdList(cached?.skills, live.skills, skillId),
    subagents: holdList(cached?.subagents, live.subagents, (agent) => agent.name),
    plugins: holdList(cached?.plugins, live.plugins, (plugin) => plugin.id),
  }
  if (next.skills.length === 0 && next.subagents.length === 0 && next.plugins.length === 0) {
    byConversationId.delete(conversationId)
    return toWire(next)
  }
  return toWire(remember(conversationId, next))
}

/**
 * Epoch-held skills with their OpenCode ids. The wire shape drops `id`
 * (`AgentSkill` has no name field), but the host `skill` tool needs it.
 */
export function getHeldOverlaySkills(conversationId: string): OverlaySkill[] {
  return structuredClone(byConversationId.get(conversationId)?.skills ?? [])
}

export function clearOverlayHold(conversationId: string): void {
  byConversationId.delete(conversationId)
}

export function transferOverlayHold(previousConversationId: string, nextConversationId: string): void {
  if (!previousConversationId || !nextConversationId) return
  const hold = byConversationId.get(previousConversationId)
  byConversationId.delete(previousConversationId)
  byConversationId.delete(nextConversationId)
  if (!hold) return
  remember(nextConversationId, hold)
}

export function resetOverlayHoldsForTests(): void {
  byConversationId.clear()
}
