// Sticky two-turn cache bar over provider-debug `cache diagnosis:` lines.
// Shared by test/usage-from-turn-ended.test.ts and the local A/B harness; not
// part of the published package.

export const DEFAULT_WARM_READ_RATIO = 0.95

export type CacheDiagnosis = Record<string, string>

export function parseCacheDiagnosisLine(line: string): CacheDiagnosis | undefined {
  const idx = line.indexOf("cache diagnosis:")
  if (idx < 0) return undefined
  const fields: CacheDiagnosis = {}
  for (const part of line.slice(idx + "cache diagnosis:".length).trim().split(" ")) {
    const eq = part.indexOf("=")
    if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return fields.requestContext ? fields : undefined
}

/** `98.0%` → 0.98; anything else → undefined. */
export function readRatio(row: CacheDiagnosis | undefined): number | undefined {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(row?.rawReadRatio ?? "")
  return match ? Number(match[1]) / 100 : undefined
}

/**
 * The first warm Run must follow a seed of the same conversation, reuse its
 * RequestContext bytes, skip the system prompt, and read at least
 * `minWarmReadRatio` of its input from cache.
 */
export function evaluateStickyCacheTurns(
  lines: readonly string[],
  minWarmReadRatio = DEFAULT_WARM_READ_RATIO,
): { ok: boolean; failures: string[]; seed?: CacheDiagnosis; warm?: CacheDiagnosis } {
  const rows = lines.map(parseCacheDiagnosisLine).filter((row): row is CacheDiagnosis => !!row)
  const warmIndex = rows.findIndex((row) => row.continuity === "warm")
  if (warmIndex < 0) return { ok: false, failures: ["no continuity=warm turn"] }
  const warm = rows[warmIndex]!
  const seed = rows.slice(0, warmIndex).reverse().find((row) =>
    row.sessionKey === warm.sessionKey && row.conversationId === warm.conversationId)
  if (!seed) return { ok: false, failures: ["warm turn has no seed for this conversation"], warm }
  const failures: string[] = []
  if (warm.requestContext !== "reused") failures.push(`warm requestContext=${warm.requestContext}`)
  if (warm.requestContextHash !== seed.requestContextHash) failures.push("RequestContext hash changed")
  if (warm.systemPromptSent === "true") failures.push("systemPromptSent=true on warm turn")
  if (warm.toolsCategoryChurn !== "none") failures.push(`toolsCategoryChurn=${warm.toolsCategoryChurn}`)
  const ratio = readRatio(warm)
  if (ratio === undefined || ratio < minWarmReadRatio) failures.push(`rawReadRatio=${warm.rawReadRatio}`)
  return { ok: failures.length === 0, failures, seed, warm }
}
