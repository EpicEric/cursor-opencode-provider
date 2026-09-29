import { beforeEach, describe, expect, it } from "bun:test"
import {
  getHeldOverlaySkills,
  holdCapabilityOverlay,
  resetOverlayHoldsForTests,
  transferOverlayHold,
} from "../src/context/overlay.js"

const zebra = {
  id: "zebra",
  full_path: "/skills/zebra/SKILL.md",
  content: "z-body",
  description: "z",
}
const alpha = {
  id: "alpha",
  full_path: "/skills/alpha/SKILL.md",
  content: "a-body",
  description: "a",
}

describe("holdCapabilityOverlay", () => {
  beforeEach(() => {
    resetOverlayHoldsForTests()
  })

  it("UTF-16-sorts the first nonempty freeze", () => {
    const held = holdCapabilityOverlay("conv", {
      skills: [zebra, alpha],
      subagents: [
        { full_path: "", name: "general", description: "g", prompt: "g" },
        { full_path: "", name: "explore", description: "e", prompt: "e" },
      ],
      plugins: [
        { id: "zeta", line: "opencode-plugin:local:zeta" },
        { id: "alpha", line: "opencode-plugin:local:alpha" },
      ],
    })
    expect(held.skills.map((skill) => skill.full_path)).toEqual([
      "/skills/alpha/SKILL.md",
      "/skills/zebra/SKILL.md",
    ])
    expect(held.subagents.map((agent) => agent.name)).toEqual(["explore", "general"])
    expect(held.plugins.map((plugin) => plugin.id)).toEqual(["alpha", "zeta"])
  })

  it("keeps frozen skill bytes when the name set is unchanged", () => {
    holdCapabilityOverlay("conv", {
      skills: [zebra],
      subagents: [],
      plugins: [],
    })
    const held = holdCapabilityOverlay("conv", {
      skills: [{ ...zebra, content: "changed", description: "new" }],
      subagents: [],
      plugins: [],
    })
    expect(held.skills).toEqual([{
      full_path: zebra.full_path,
      content: "z-body",
      description: "z",
    }])
  })

  it("appends a new skill at the tail instead of re-sorting", () => {
    holdCapabilityOverlay("conv", {
      skills: [zebra],
      subagents: [],
      plugins: [],
    })
    const held = holdCapabilityOverlay("conv", {
      skills: [alpha, zebra],
      subagents: [],
      plugins: [],
    })
    expect(held.skills.map((skill) => skill.full_path)).toEqual([
      "/skills/zebra/SKILL.md",
      "/skills/alpha/SKILL.md",
    ])
  })

  it("holds removed skills, subagents, and plugins", () => {
    holdCapabilityOverlay("conv", {
      skills: [zebra],
      subagents: [{ full_path: "", name: "explore", description: "e", prompt: "e" }],
      plugins: [{ id: "zeta", line: "opencode-plugin:local:zeta" }],
    })
    const held = holdCapabilityOverlay("conv", {
      skills: [],
      subagents: [],
      plugins: [],
    })
    expect(held.skills).toHaveLength(1)
    expect(held.subagents.map((agent) => agent.name)).toEqual(["explore"])
    expect(held.plugins.map((plugin) => plugin.id)).toEqual(["zeta"])
  })

  it("transfers the hold across a conversation remint", () => {
    holdCapabilityOverlay("prev", {
      skills: [zebra],
      subagents: [],
      plugins: [],
    })
    transferOverlayHold("prev", "next")
    const grown = holdCapabilityOverlay("next", {
      skills: [alpha, { ...zebra, content: "changed" }],
      subagents: [],
      plugins: [],
    })
    expect(grown.skills.map((skill) => skill.content)).toEqual(["z-body", "a-body"])
  })

  it("exposes held skill ids that the wire shape drops", () => {
    const held = holdCapabilityOverlay("conv", { skills: [zebra, alpha], subagents: [], plugins: [] })
    expect(held.skills[0]).not.toHaveProperty("id")
    expect(getHeldOverlaySkills("conv").map((skill) => skill.id)).toEqual(["alpha", "zebra"])
    expect(getHeldOverlaySkills("missing")).toEqual([])
  })
})
