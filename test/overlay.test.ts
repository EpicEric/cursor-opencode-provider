import { beforeEach, describe, expect, it } from "bun:test"
import {
  holdCapabilityOverlay,
  resetOverlayHoldsForTests,
  transferOverlayHold,
} from "../src/context/overlay.js"

const zebra = {
  full_path: "",
  name: "zebra",
  description: "z",
  prompt: "z-prompt",
}
const alpha = {
  full_path: "",
  name: "alpha",
  description: "a",
  prompt: "a-prompt",
}

describe("holdCapabilityOverlay", () => {
  beforeEach(() => {
    resetOverlayHoldsForTests()
  })

  it("UTF-16-sorts the first nonempty freeze", () => {
    const held = holdCapabilityOverlay("conv", {
      subagents: [zebra, alpha],
      plugins: [
        { id: "zeta", line: "opencode-plugin:local:zeta" },
        { id: "alpha", line: "opencode-plugin:local:alpha" },
      ],
    })
    expect(held.subagents.map((agent) => agent.name)).toEqual(["alpha", "zebra"])
    expect(held.plugins.map((plugin) => plugin.id)).toEqual(["alpha", "zeta"])
  })

  it("keeps frozen subagent bytes when the name set is unchanged", () => {
    holdCapabilityOverlay("conv", { subagents: [zebra], plugins: [] })
    const held = holdCapabilityOverlay("conv", {
      subagents: [{ ...zebra, description: "new", prompt: "changed" }],
      plugins: [],
    })
    expect(held.subagents).toEqual([zebra])
  })

  it("appends a new subagent at the tail instead of re-sorting", () => {
    holdCapabilityOverlay("conv", { subagents: [zebra], plugins: [] })
    const held = holdCapabilityOverlay("conv", { subagents: [alpha, zebra], plugins: [] })
    expect(held.subagents.map((agent) => agent.name)).toEqual(["zebra", "alpha"])
  })

  it("holds removed subagents and plugins", () => {
    holdCapabilityOverlay("conv", {
      subagents: [zebra],
      plugins: [{ id: "zeta", line: "opencode-plugin:local:zeta" }],
    })
    const held = holdCapabilityOverlay("conv", { subagents: [], plugins: [] })
    expect(held.subagents.map((agent) => agent.name)).toEqual(["zebra"])
    expect(held.plugins.map((plugin) => plugin.id)).toEqual(["zeta"])
  })

  it("transfers the hold across a conversation remint", () => {
    holdCapabilityOverlay("prev", { subagents: [zebra], plugins: [] })
    transferOverlayHold("prev", "next")
    const grown = holdCapabilityOverlay("next", {
      subagents: [alpha, { ...zebra, prompt: "changed" }],
      plugins: [],
    })
    expect(grown.subagents.map((agent) => agent.prompt)).toEqual(["z-prompt", "a-prompt"])
  })
})
