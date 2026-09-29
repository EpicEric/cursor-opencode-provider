import { describe, expect, it } from "bun:test"
import {
  buildDynamicCatalogRoutingInstruction,
  buildSkillCatalogChangeReminder,
  takeSkillCatalogChangeReminder,
  resetSkillCatalogAdmissionsForTests,
  listAdvertisedMcpServers,
  skillNameFromAgentSkill,
} from "../src/context/dynamic-catalog.js"

describe("listAdvertisedMcpServers", () => {
  it("names only configured servers that own an advertised tool", () => {
    expect(
      listAdvertisedMcpServers(
        [
          "skill",
          "read",
          "apply_patch",
          "cursor_image_save",
          "foo_bar",
          "context7_query-docs",
          "codesearch_find",
          "todowrite",
          "github_create_pull_request",
        ],
        ["github", "context7", "codesearch", "unused"],
      ),
    ).toEqual(["context7", "codesearch", "github"])
  })

  it("never infers servers from underscores without config", () => {
    expect(listAdvertisedMcpServers(["apply_patch", "foo_bar", "context7_query-docs"])).toEqual([])
  })

  it("resolves sanitized and prefix-overlapping server ids like the descriptors", () => {
    expect(
      listAdvertisedMcpServers(["my_docs_search", "git_hub_issue", "git_log"], ["my.docs", "git", "git_hub"]),
    ).toEqual(["my_docs", "git_hub", "git"])
  })
})

describe("skillNameFromAgentSkill", () => {
  it("prefers the discovered OpenCode id over the directory name", () => {
    expect(
      skillNameFromAgentSkill({
        id: "renamed-in-frontmatter",
        full_path: "/repo/.opencode/skills/ab-probe/SKILL.md",
      }),
    ).toBe("renamed-in-frontmatter")
  })

  it("falls back to the skills/<id>/SKILL.md directory name", () => {
    expect(
      skillNameFromAgentSkill({
        full_path: "/repo/.opencode/skills/ab-probe/SKILL.md",
      }),
    ).toBe("ab-probe")
    expect(
      skillNameFromAgentSkill({
        full_path: "C:\\repo\\.opencode\\skills\\win-skill\\SKILL.md",
      }),
    ).toBe("win-skill")
  })

  it("returns undefined for paths that are not SKILL.md files", () => {
    expect(skillNameFromAgentSkill({ full_path: "/repo/notes/other.md" })).toBeUndefined()
    expect(skillNameFromAgentSkill({ full_path: "SKILL.md" })).toBeUndefined()
    expect(skillNameFromAgentSkill({ full_path: "   " })).toBeUndefined()
    expect(skillNameFromAgentSkill({})).toBeUndefined()
  })
})

describe("buildDynamicCatalogRoutingInstruction", () => {
  it("returns undefined without skill or configured MCP tools", () => {
    expect(
      buildDynamicCatalogRoutingInstruction({
        toolNames: ["read", "grep", "custom_websearch", "apply_patch"],
      }),
    ).toBeUndefined()
  })

  it("names skill and configured MCP servers for GetDynamicTools routing", () => {
    const line = buildDynamicCatalogRoutingInstruction({
      toolNames: ["skill", "context7_query-docs", "read"],
      knownMcpServers: ["context7"],
    })
    expect(line).toContain("including `skill` and MCP servers such as `context7`")
    expect(line).toContain("GetDynamicTools / CallDynamicTool")
    expect(line).toContain("before Grep/Shell fallbacks")
    expect(line).toContain("Use the `skill` tool to load a skill when a task matches its description")
    expect(line).toContain("does not need to be invoked again")
  })

  it("reports servers beyond the listed limit", () => {
    const servers = Array.from({ length: 10 }, (_, i) => `srv${i}`)
    const line = buildDynamicCatalogRoutingInstruction({
      toolNames: servers.map((server) => `${server}_tool`),
      knownMcpServers: servers,
    })
    expect(line).toContain("`srv7` (+2 more)")
    expect(line).not.toContain("`srv8`")
  })
})

describe("buildSkillCatalogChangeReminder", () => {
  const skills = [
    {
      id: "ab-probe",
      full_path: "/repo/.opencode/skills/ab-probe/SKILL.md",
      description: "Returns the ab-probe marker token for issue 29 tests",
    },
    {
      id: "firecrawl",
      full_path: "/repo/.opencode/skills/firecrawl/SKILL.md",
      description: "Search and scrape the web via Firecrawl",
    },
  ]

  it("stays quiet without a skill tool", () => {
    expect(
      buildSkillCatalogChangeReminder({
        hasSkillTool: false,
        skills,
        previousSkillIds: null,
      }).text,
    ).toBeUndefined()
    expect(
      buildSkillCatalogChangeReminder({
        hasSkillTool: false,
        skills,
        previousSkillIds: ["ab-probe"],
      }).text,
    ).toBeUndefined()
  })

  it("stays quiet on first admission (OpenCode baseline, not Mid-Conversation)", () => {
    const result = buildSkillCatalogChangeReminder({
      hasSkillTool: true,
      skills,
      previousSkillIds: null,
      skillArgKey: "name",
    })
    expect(result.text).toBeUndefined()
    expect(result.nextSkillIds).toEqual(["ab-probe", "firecrawl"])
  })

  it("stays quiet when the admitted catalog is unchanged", () => {
    expect(
      buildSkillCatalogChangeReminder({
        hasSkillTool: true,
        skills,
        previousSkillIds: ["ab-probe", "firecrawl"],
      }).text,
    ).toBeUndefined()
  })

  it("emits an OpenCode-shaped supersede when the catalog grows", () => {
    const result = buildSkillCatalogChangeReminder({
      hasSkillTool: true,
      skills,
      previousSkillIds: ["ab-probe"],
      skillArgKey: "name",
    })
    expect(result.text).toContain("<system_reminder>")
    expect(result.text).toContain("The available skills have changed")
    expect(result.text).toContain("Use the skill tool to load a skill when a task matches its description")
    expect(result.text).toContain("does not need to be invoked again")
    expect(result.text).toContain("<available_skills>")
    expect(result.text).toContain("<name>ab-probe</name>")
    expect(result.text).toContain("<name>firecrawl</name>")
    expect(result.text).toContain('{ "name": "<skill-id>" }')
    expect(result.text).toContain("host schema key is `name`")
    expect(result.text).not.toContain("Relevant skill id(s) this turn")
    expect(result.nextSkillIds).toEqual(["ab-probe", "firecrawl"])
  })

  it("uses id in the OpenCode 2 call hint and skill entries", () => {
    const result = buildSkillCatalogChangeReminder({
      hasSkillTool: true,
      skills,
      previousSkillIds: [],
      skillArgKey: "id",
    })
    expect(result.text).toContain('{ "id": "<skill-id>" }')
    expect(result.text).toContain("<id>ab-probe</id>")
    expect(result.text).toContain("host schema key is `id`")
  })

  it("clears guidance when the catalog becomes empty after admission", () => {
    const result = buildSkillCatalogChangeReminder({
      hasSkillTool: true,
      skills: [],
      previousSkillIds: ["ab-probe"],
    })
    expect(result.text).toContain("Skill guidance is no longer available")
    expect(result.nextSkillIds).toEqual([])
  })
})

describe("takeSkillCatalogChangeReminder", () => {
  const skills = [
    {
      id: "ocp-dev",
      full_path: "/repo/.claude/skills/ocp-dev/SKILL.md",
      description: "Wire OCP hosts for local development",
    },
  ]

  it("admits once silently then stays quiet on identical catalogs", () => {
    resetSkillCatalogAdmissionsForTests()
    expect(
      takeSkillCatalogChangeReminder("conv-a", {
        hasSkillTool: true,
        skills,
        skillArgKey: "name",
      }),
    ).toBeUndefined()
    expect(
      takeSkillCatalogChangeReminder("conv-a", {
        hasSkillTool: true,
        skills,
        skillArgKey: "name",
      }),
    ).toBeUndefined()
  })

  it("reminds only after the held catalog gains a skill", () => {
    resetSkillCatalogAdmissionsForTests()
    takeSkillCatalogChangeReminder("conv-b", {
      hasSkillTool: true,
      skills,
      skillArgKey: "name",
    })
    const grown = takeSkillCatalogChangeReminder("conv-b", {
      hasSkillTool: true,
      skills: [
        ...skills,
        {
          id: "ab-probe",
          full_path: "/repo/.opencode/skills/ab-probe/SKILL.md",
          description: "marker",
        },
      ],
      skillArgKey: "name",
    })
    expect(grown).toContain("The available skills have changed")
    expect(grown).toContain("<name>ab-probe</name>")
    expect(grown).toContain("<name>ocp-dev</name>")
  })
})
