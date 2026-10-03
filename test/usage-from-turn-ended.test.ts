import { describe, expect, it } from "bun:test"
import {
  buildLanguageModelV3UsageFromCounters,
  buildLanguageModelV3UsageFromTurnEnded,
  DEFAULT_WARM_READ_RATIO,
  evaluateStickyCacheTurns,
  formatCursorCacheDiagnostics,
  formatCursorTokenCategories,
  formatTurnUsageValidation,
  parseCacheDiagnosisLine,
  flatUsageFromV3,
  occupancyUsageFromTokenDetails,
  occupancyValidationCounters,
  OPENCODE_DISPLAY_ONLY_COST_METADATA,
  turnEndedCounter,
} from "../src/usage.js"

describe("turnEndedCounter", () => {
  it("truncates finite non-negative numbers", () => {
    expect(turnEndedCounter({ x: 12.9 }, "x")).toBe(12)
    expect(turnEndedCounter({ x: -1 }, "x")).toBe(0)
    expect(turnEndedCounter({ x: NaN }, "x")).toBe(0)
    expect(turnEndedCounter({}, "x")).toBe(0)
  })
})

describe("buildLanguageModelV3UsageFromTurnEnded", () => {
  const te = {
    input_tokens: 100,
    output_tokens: 50,
    cache_read: 10,
    cache_write: 5,
    reasoning_tokens: 7,
  }

  it("maps nested V3 usage from TurnEnded", () => {
    const usage = buildLanguageModelV3UsageFromTurnEnded(te)
    expect(usage.inputTokens?.total).toBe(100)
    expect(usage.inputTokens?.noCache).toBe(85)
    expect(usage.inputTokens?.cacheRead).toBe(10)
    expect(usage.inputTokens?.cacheWrite).toBe(5)
    expect(usage.outputTokens?.total).toBe(50)
    expect(usage.outputTokens?.text).toBe(43)
    expect(usage.outputTokens?.reasoning).toBe(7)
  })

  it("defaults missing reasoning_tokens to zero", () => {
    const usage = buildLanguageModelV3UsageFromTurnEnded({
      input_tokens: 1,
      output_tokens: 2,
      cache_read: 0,
      cache_write: 0,
    })
    expect(usage.outputTokens?.reasoning).toBe(0)
    expect(usage.outputTokens?.total).toBe(2)
  })

  it("projects V3 usage into flat counter fields", () => {
    const flat = flatUsageFromV3(buildLanguageModelV3UsageFromTurnEnded(te))
    expect(flat).toEqual({
      inputTokens: 85,
      outputTokens: 43,
      reasoningTokens: 7,
      cacheReadInputTokens: 10,
      cacheWriteInputTokens: 5,
    })
  })

  it("maps every request independently even when counters decrease between turns", () => {
    const usage = buildLanguageModelV3UsageFromTurnEnded({
      input_tokens: 42_563,
      output_tokens: 1_141,
      cache_read: 27_392,
      cache_write: 0,
      reasoning_tokens: 801,
    })
    expect(usage.inputTokens).toEqual({
      total: 42_563,
      noCache: 15_171,
      cacheRead: 27_392,
      cacheWrite: 0,
    })
    expect(usage.outputTokens).toEqual({
      total: 1_141,
      text: 340,
      reasoning: 801,
    })
  })

  it("does not dilute a prefix cache hit by multi-step TurnEnded aggregates", () => {
    const usage = buildLanguageModelV3UsageFromTurnEnded(
      {
        input_tokens: 94_836,
        output_tokens: 3_513,
        cache_read: 45_952,
        cache_write: 0,
        reasoning_tokens: 3_178,
      },
      { contextTotalTokens: 50_702, priorContextTokens: 45_243 },
    )
    expect(usage.inputTokens).toEqual({
      total: 47_189,
      noCache: 1_946,
      cacheRead: 45_243,
      cacheWrite: 0,
    })
    expect(usage.outputTokens?.total).toBe(3_513)
  })

  it("uses checkpoint occupancy as the total while preserving cache proportions", () => {
    const usage = buildLanguageModelV3UsageFromTurnEnded(
      {
        input_tokens: 100,
        output_tokens: 20,
        cache_read: 60,
        cache_write: 20,
        reasoning_tokens: 5,
      },
      { contextTotalTokens: 70 },
    )

    expect(usage.inputTokens).toEqual({
      total: 50,
      noCache: 10,
      cacheRead: 30,
      cacheWrite: 10,
    })
    expect(usage.outputTokens).toEqual({
      total: 20,
      text: 15,
      reasoning: 5,
    })
    expect(flatUsageFromV3(usage)).toEqual({
      inputTokens: 10,
      outputTokens: 15,
      reasoningTokens: 5,
      cacheReadInputTokens: 30,
      cacheWriteInputTokens: 10,
    })

    expect(formatTurnUsageValidation(
      {
        inputTokens: 100,
        outputTokens: 20,
        cacheRead: 60,
        cacheWrite: 20,
        reasoningTokens: 5,
      },
      usage,
      {
        usedTokens: 70,
        maxTokens: 100,
        breakdown: {
          totalUsedTokens: 70,
          maxTokens: 100,
          categories: [
            { id: "static", label: "Static", estimatedTokens: 40 },
            { id: "conversation", label: "Conversation", estimatedTokens: 30 },
          ],
        },
      },
    )).toBe(
      "turn usage validation: status=ok source=checkpoint-current-run " +
      "cursor=70/100(70.0%) rawTotal=120 sentTotal=70 totalMatch=true " +
      "input=50 inputParts=50 inputMatch=true output=20 outputParts=20 outputMatch=true " +
      "opencodeProjectedTotal=70 opencodeMatch=true breakdownTotal=70 categorySum=70 " +
      "breakdownMatch=true rawCachedRatio=80.0% sentCachedRatio=80.0% cacheRatioMatch=true",
    )
  })

  it("marks context checks unavailable without deriving occupancy from TurnEnded", () => {
    const counters = {
      inputTokens: 10,
      outputTokens: 2,
      cacheRead: 0,
      cacheWrite: 0,
      reasoningTokens: 0,
    }
    const validation = formatTurnUsageValidation(
      counters,
      buildLanguageModelV3UsageFromCounters({
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
      }),
    )
    expect(validation).toContain("status=ok source=unavailable cursor=unavailable")
    expect(validation).toContain("rawTotal=12 sentTotal=0 totalMatch=unavailable")
    expect(validation).toContain("opencodeProjectedTotal=0 opencodeMatch=true")
    expect(validation).toContain("breakdownMatch=unavailable")
    expect(validation).toContain("cacheRatioMatch=unavailable")
  })
})

describe("occupancyUsageFromTokenDetails", () => {
  it("keeps OpenCode's Copilot cost override at zero so occupancy snapshots are not billed", () => {
    expect(OPENCODE_DISPLAY_ONLY_COST_METADATA).toEqual({
      copilot: { totalNanoAiu: 0 },
    })
  })

  it("places occupancy on a snapshot whose TUI sum equals usedTokens and output > 0", () => {
    const details = { usedTokens: 153_744, maxTokens: 256_000 }
    const prior = { usedTokens: 123_651, maxTokens: 256_000 }
    const usage = occupancyUsageFromTokenDetails(details, prior)
    expect(usage.outputTokens?.total).toBe(1)
    expect(usage.outputTokens?.text).toBe(1)
    expect(usage.outputTokens?.reasoning).toBe(0)
    expect((usage.inputTokens?.total ?? 0) + (usage.outputTokens?.total ?? 0)).toBe(153_744)
    expect(usage.inputTokens?.cacheRead).toBe(123_651)
    expect(usage.inputTokens?.cacheWrite).toBe(0)
    expect(usage.inputTokens?.noCache).toBe(153_744 - 1 - 123_651)
    const validation = formatTurnUsageValidation(
      occupancyValidationCounters(details, prior),
      usage,
      details,
      "checkpoint-current-run",
    )
    expect(validation).toContain("status=ok")
    expect(validation).toContain("sentTotal=153744")
    expect(validation).toContain("opencodeProjectedTotal=153744")
  })

  it("still totals usedTokens when no prior occupancy is known", () => {
    const usage = occupancyUsageFromTokenDetails({ usedTokens: 40, maxTokens: 256_000 })
    expect(usage.outputTokens?.total).toBe(1)
    expect(usage.inputTokens?.total).toBe(39)
    expect(usage.inputTokens?.cacheRead).toBe(0)
  })

  it("emits empty usage when occupancy is not yet known", () => {
    expect(occupancyUsageFromTokenDetails({ usedTokens: 0, maxTokens: 256_000 })).toEqual({
      inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 0, text: 0, reasoning: 0 },
    })
  })

  it("validates TurnEnded/stop occupancy against prefix counters, not request aggregates", () => {
    // Live self-verify shape: aggregate TurnEnded cache ratio ≠ prior-prefix
    // occupancy ratio. Comparing those falsely flipped status=mismatch.
    const details = {
      usedTokens: 89_575,
      maxTokens: 256_000,
      breakdown: {
        totalUsedTokens: 89_575,
        maxTokens: 256_000,
        categories: [
          { id: "system_prompt", label: "System Prompt", estimatedTokens: 484 },
          { id: "tools", label: "Tools", estimatedTokens: 7_732 },
          { id: "rules", label: "Rules", estimatedTokens: 2_713 },
          { id: "skills", label: "Skills", estimatedTokens: 2_512 },
          { id: "mcp", label: "MCP", estimatedTokens: 636 },
          { id: "subagents", label: "Subagents", estimatedTokens: 903 },
          { id: "summarized_conversation", label: "Summarized", estimatedTokens: 0 },
          { id: "conversation", label: "Conversation", estimatedTokens: 74_595 },
        ],
      },
    }
    const prior = { usedTokens: 87_353, maxTokens: 256_000 }
    const usage = occupancyUsageFromTokenDetails(details, prior)
    const turnEndedCounters = {
      inputTokens: 176_981,
      outputTokens: 322,
      cacheRead: 173_440,
      cacheWrite: 0,
      reasoningTokens: 0,
    }

    expect(formatTurnUsageValidation(
      turnEndedCounters,
      usage,
      details,
      "checkpoint-current-run",
    )).toContain("status=mismatch")

    const validation = formatTurnUsageValidation(
      occupancyValidationCounters(details, prior),
      usage,
      details,
      "checkpoint-current-run",
    )
    expect(validation).toContain("status=ok")
    expect(validation).toContain("sentTotal=89575")
    expect(validation).toContain("totalMatch=true")
    expect(validation).toContain("breakdownMatch=true")
    expect(validation).toContain("cacheRatioMatch=true")
    expect(validation).toContain("rawTotal=89576")
    expect(occupancyValidationCounters(details, prior)).toEqual({
      inputTokens: 89_575,
      outputTokens: 1,
      cacheRead: 87_353,
      cacheWrite: 0,
      reasoningTokens: 0,
    })
  })
})

describe("Cursor cache diagnostics", () => {
  const prior = {
    usedTokens: 40_000,
    maxTokens: 256_000,
    breakdown: {
      totalUsedTokens: 40_000,
      maxTokens: 256_000,
      categories: [
        { id: "system_prompt", label: "System Prompt", estimatedTokens: 1_000 },
        { id: "tools", label: "Tools", estimatedTokens: 9_000 },
        { id: "conversation", label: "Conversation", estimatedTokens: 30_000 },
      ],
    },
  }
  const current = {
    usedTokens: 45_000,
    maxTokens: 256_000,
    breakdown: {
      totalUsedTokens: 45_000,
      maxTokens: 256_000,
      categories: [
        { id: "system_prompt", label: "System Prompt", estimatedTokens: 1_000 },
        { id: "tools", label: "Tools", estimatedTokens: 9_000 },
        { id: "conversation", label: "Conversation", estimatedTokens: 35_000 },
      ],
    },
  }

  it("prints checkpoint categories as compact JSON", () => {
    expect(formatCursorTokenCategories(current)).toBe(
      '{"system_prompt":1000,"tools":9000,"conversation":35000}',
    )
    expect(formatCursorTokenCategories(undefined)).toBe("unavailable")
  })

  it("separates warm-prefix evidence from Cursor's aggregate cache ratio", () => {
    expect(formatCursorCacheDiagnostics(
      {
        inputTokens: 50_000,
        outputTokens: 2_000,
        cacheRead: 20_000,
        cacheWrite: 5_000,
        reasoningTokens: 1_000,
      },
      current,
      prior,
      {
        sessionKey: "ses_cache",
        conversationId: "conversation-cache",
        conversationGroupId: "group-cache",
        modelId: "cursor/default",
        startedWithCheckpoint: true,
        requestContextReused: true,
        requestContextHash: "0123456789abcdef-rest",
        systemPromptHash: "fedcba9876543210-rest",
        checkpointUpdates: 4,
        tokenDetailUpdates: 3,
        pumpPasses: 2,
        stepStarts: 3,
        stepCompletes: 3,
        displayToolCalls: 1,
        execRequests: 5,
      },
    )).toBe(
      "cache diagnosis: sessionKey=ses_cache conversationId=conversation-cache " +
      "conversationGroupId=group-cache model=cursor/default continuity=warm " +
      "rawInput=50000 rawCacheRead=20000 " +
      "rawCacheWrite=5000 rawUncached=25000 rawReadRatio=40.0% rawWriteRatio=10.0% " +
      "priorContext=40000 currentContext=45000 contextDelta=5000 " +
      "rawReadVsPriorContext=50.0% sameSizedCategoryTokens=10000 " +
      'categoryDelta={"system_prompt":0,"tools":0,"conversation":5000} ' +
      "toolsCategoryChurn=none " +
      "requestContext=reused requestContextHash=0123456789abcdef " +
      "systemPromptHash=fedcba9876543210 systemPromptSent=false " +
      "checkpointUpdates=4 tokenDetailUpdates=3 " +
      "pumpPasses=2 steps=3/3 displayToolCalls=1 execRequests=5 " +
      "createPlanInTurn=false switchModeInTurn=false " +
      "perModelCallCache=unavailable",
    )
  })

  it("marks a seeded Run as cold instead of implying a cache failure", () => {
    const line = formatCursorCacheDiagnostics(
      {
        inputTokens: 10_000,
        outputTokens: 100,
        cacheRead: 0,
        cacheWrite: 0,
        reasoningTokens: 0,
      },
      current,
      undefined,
      {
        conversationId: "conversation-cold",
        startedWithCheckpoint: false,
        requestContextReused: false,
        requestContextHash: "abc",
        checkpointUpdates: 1,
        tokenDetailUpdates: 1,
        pumpPasses: 1,
        stepStarts: 1,
        stepCompletes: 1,
        displayToolCalls: 0,
        execRequests: 1,
      },
    )
    expect(line).toContain("continuity=cold")
    expect(line).toContain("priorContext=unavailable")
    expect(line).toContain("rawReadVsPriorContext=n/a")
    expect(line).toContain("sameSizedCategoryTokens=unavailable")
    expect(line).toContain("categoryDelta=unavailable")
    expect(line).toContain("toolsCategoryChurn=none")
    expect(line).toContain("systemPromptSent=true")
  })

  it("flags upstream tools-category churn when the request-context overlay was reused", () => {
    const line = formatCursorCacheDiagnostics(
      {
        inputTokens: 50_000,
        outputTokens: 1_000,
        cacheRead: 25_000,
        cacheWrite: 0,
        reasoningTokens: 0,
      },
      {
        usedTokens: 27_000,
        maxTokens: 256_000,
        breakdown: {
          totalUsedTokens: 27_000,
          maxTokens: 256_000,
          categories: [
            { id: "system_prompt", label: "System Prompt", estimatedTokens: 1_000 },
            { id: "tools", label: "Tools", estimatedTokens: 9_633 },
            { id: "conversation", label: "Conversation", estimatedTokens: 16_367 },
          ],
        },
      },
      {
        usedTokens: 24_000,
        maxTokens: 256_000,
        breakdown: {
          totalUsedTokens: 24_000,
          maxTokens: 256_000,
          categories: [
            { id: "system_prompt", label: "System Prompt", estimatedTokens: 1_000 },
            { id: "tools", label: "Tools", estimatedTokens: 9_000 },
            { id: "conversation", label: "Conversation", estimatedTokens: 14_000 },
          ],
        },
      },
      {
        conversationId: "conversation-tools-churn",
        startedWithCheckpoint: true,
        requestContextReused: true,
        requestContextHash: "abc",
        checkpointUpdates: 2,
        tokenDetailUpdates: 2,
        pumpPasses: 1,
        stepStarts: 1,
        stepCompletes: 1,
        displayToolCalls: 1,
        execRequests: 1,
      },
    )
    expect(line).toContain("toolsCategoryChurn=upstream-stable-overlay")
    expect(line).toContain('"tools":633')
  })

  it("tags Runs where CreatePlan or SwitchMode ran in-turn", () => {
    const line = formatCursorCacheDiagnostics(
      {
        inputTokens: 50_000,
        outputTokens: 1_000,
        cacheRead: 25_000,
        cacheWrite: 0,
        reasoningTokens: 0,
      },
      current,
      undefined,
      {
        conversationId: "conversation-plan-switch-tags",
        startedWithCheckpoint: false,
        requestContextReused: false,
        requestContextHash: "abc",
        checkpointUpdates: 1,
        tokenDetailUpdates: 1,
        pumpPasses: 1,
        stepStarts: 1,
        stepCompletes: 1,
        displayToolCalls: 1,
        execRequests: 1,
        createPlanInTurn: true,
        switchModeInTurn: true,
      },
    )
    expect(line).toContain("createPlanInTurn=true switchModeInTurn=true")
  })
})

describe("sticky-session cache diagnosis", () => {
  const stats = {
    sessionKey: "ses_cache",
    conversationId: "conversation-cache",
    conversationGroupId: "group-cache",
    modelId: "cursor/default",
    requestContextHash: "0123456789abcdef-rest",
    systemPromptHash: "fedcba9876543210-rest",
    checkpointUpdates: 1,
    tokenDetailUpdates: 1,
    pumpPasses: 1,
    stepStarts: 1,
    stepCompletes: 1,
    displayToolCalls: 0,
    execRequests: 1,
  } as const

  const seedLine = formatCursorCacheDiagnostics(
    {
      inputTokens: 24_000,
      outputTokens: 100,
      cacheRead: 20_000,
      cacheWrite: 0,
      reasoningTokens: 0,
    },
    undefined,
    undefined,
    {
      ...stats,
      startedWithCheckpoint: false,
      requestContextReused: false,
    },
  )

  const warmLine = formatCursorCacheDiagnostics(
    {
      inputTokens: 24_500,
      outputTokens: 20,
      cacheRead: 24_000,
      cacheWrite: 0,
      reasoningTokens: 0,
    },
    undefined,
    {
      usedTokens: 12_000,
      maxTokens: 200_000,
    },
    {
      ...stats,
      startedWithCheckpoint: true,
      requestContextReused: true,
    },
  )

  it("round-trips diagnosis fields from the formatter", () => {
    const parsed = parseCacheDiagnosisLine(warmLine)
    expect(parsed).toMatchObject({
      continuity: "warm",
      requestContext: "reused",
      systemPromptSent: false,
      toolsCategoryChurn: "none",
      rawInput: 24_500,
      rawCacheRead: 24_000,
    })
    expect(parsed?.rawReadRatio).toBe(0.98)
    expect(parsed?.requestContextHash).toBe("0123456789abcdef")
  })

  it("passes a seed then warm reused prefix above the ratio bar", () => {
    const verdict = evaluateStickyCacheTurns([seedLine, warmLine])
    expect(verdict.ok).toBe(true)
    expect(verdict.failures).toEqual([])
    expect(verdict.warm?.rawReadRatio).toBeGreaterThanOrEqual(DEFAULT_WARM_READ_RATIO)
  })

  it("ignores an interleaved lifecycle Run with a different conversation id", () => {
    const other = formatCursorCacheDiagnostics(
      {
        inputTokens: 8_000,
        outputTokens: 10,
        cacheRead: 4_000,
        cacheWrite: 0,
        reasoningTokens: 0,
      },
      undefined,
      undefined,
      {
        ...stats,
        conversationId: "conversation-title",
        startedWithCheckpoint: false,
        requestContextReused: false,
      },
    )
    const verdict = evaluateStickyCacheTurns([seedLine, other, warmLine])
    expect(verdict.ok).toBe(true)
    expect(verdict.seed?.conversationId).toBe("conversation-cache")
  })

  it("fails one-shot cold Runs that never continue", () => {
    const verdict = evaluateStickyCacheTurns([seedLine])
    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toEqual(["no continuity=warm turn"])
  })

  it("fails a warm Run that rebuilt RequestContext or missed cache", () => {
    const rebuilt = formatCursorCacheDiagnostics(
      {
        inputTokens: 24_500,
        outputTokens: 20,
        cacheRead: 10_000,
        cacheWrite: 0,
        reasoningTokens: 0,
      },
      undefined,
      {
        usedTokens: 12_000,
        maxTokens: 200_000,
      },
      {
        ...stats,
        startedWithCheckpoint: true,
        requestContextReused: false,
        requestContextHash: "ffffffffffffffff-rest",
      },
    )
    const verdict = evaluateStickyCacheTurns([seedLine, rebuilt])
    expect(verdict.ok).toBe(false)
    expect(verdict.failures).toEqual(expect.arrayContaining([
      "warm requestContext=built (expected reused)",
      "RequestContext hash changed",
      expect.stringMatching(/^rawReadRatio /),
    ]))
  })
})
