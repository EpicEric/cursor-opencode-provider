import { describe, expect, it } from "bun:test"
import {
  buildDynamicCatalogRoutingInstruction,
  buildSkillCatalogNudge,
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

describe("buildSkillCatalogNudge", () => {
  const skills = [
    {
      full_path: "/repo/.opencode/skills/ab-probe/SKILL.md",
      description: "Returns the ab-probe marker token for issue 29 tests",
    },
    {
      full_path: "/repo/.opencode/skills/firecrawl/SKILL.md",
      description: "Search and scrape the web via Firecrawl",
    },
  ]

  it("stays quiet without a skill tool or matching turn", () => {
    expect(
      buildSkillCatalogNudge({
        hasSkillTool: false,
        skills,
        userText: "what is the ab-probe marker?",
      }),
    ).toBeUndefined()
    expect(
      buildSkillCatalogNudge({
        hasSkillTool: true,
        skills,
        userText: "refactor the parser",
      }),
    ).toBeUndefined()
  })

  it("nudge matched skill ids through CallDynamicTool", () => {
    const nudge = buildSkillCatalogNudge({
      hasSkillTool: true,
      skills,
      userText: "what is the ab-probe marker?",
      skillArgKey: "name",
    })
    expect(nudge).toContain("<system_reminder>")
    expect(nudge).toContain("`ab-probe`")
    expect(nudge).toContain("GetDynamicTools / CallDynamicTool")
    expect(nudge).toContain("tool `skill`")
    expect(nudge).toContain('{ "name": "<skill-id>" }')
    expect(nudge).toContain("host schema key is `name`")
    expect(nudge).not.toContain("`firecrawl`")
  })

  it("nudges OpenCode 2 skill calls with id", () => {
    const nudge = buildSkillCatalogNudge({
      hasSkillTool: true,
      skills,
      userText: "what is the ab-probe marker?",
      skillArgKey: "id",
    })
    expect(nudge).toContain('{ "id": "<skill-id>" }')
    expect(nudge).toContain("host schema key is `id`")
  })

  it("lists skills when the user explicitly asks about skills", () => {
    const nudge = buildSkillCatalogNudge({
      hasSkillTool: true,
      skills,
      userText: "which skills are available?",
    })
    expect(nudge).toContain("`ab-probe`")
    expect(nudge).toContain("`firecrawl`")
  })

  it("uses word boundaries for skill names", () => {
    const nudge = buildSkillCatalogNudge({
      hasSkillTool: true,
      skills: [{ full_path: "/r/skills/plan/SKILL.md", description: "" }],
      userText: "explain the planner",
    })
    expect(nudge).toBeUndefined()
    expect(
      buildSkillCatalogNudge({
        hasSkillTool: true,
        skills: [{ full_path: "/r/skills/plan/SKILL.md", description: "" }],
        userText: "use plan, please",
      }),
    ).toContain("`plan`")
  })

  it("matches short description words", () => {
    const nudge = buildSkillCatalogNudge({
      hasSkillTool: true,
      skills: [{ full_path: "/r/skills/cloud/SKILL.md", description: "AWS CLI helper" }],
      userText: "how do I configure the aws cli profile?",
    })
    expect(nudge).toContain("`cloud`")
  })

  it("ignores incidental prose about skills", () => {
    expect(
      buildSkillCatalogNudge({
        hasSkillTool: true,
        skills,
        userText: "the team has the skills to refactor this",
      }),
    ).toBeUndefined()
  })

  it("ignores MCP server-instruction dumps that would mass-match firecrawl skills", () => {
    const firecrawlSkills = [
      {
        id: "find-skills",
        full_path: "/r/skills/find-skills/SKILL.md",
        description: "Find and install skills from the open agent skills ecosystem",
      },
      {
        id: "firecrawl-build-search",
        full_path: "/r/skills/firecrawl-build-search/SKILL.md",
        description: "Search the web via Firecrawl tools and servers",
      },
      {
        id: "firecrawl-build-scrape",
        full_path: "/r/skills/firecrawl-build-scrape/SKILL.md",
        description: "Scrape documentation and fetch library pages through Firecrawl tools",
      },
      {
        id: "firecrawl-deep-research",
        full_path: "/r/skills/firecrawl-deep-research/SKILL.md",
        description: "Deep research using search tools and documentation servers",
      },
    ]
    const mcpDump =
      `<system-update>\nNew MCP server instructions are available:\n` +
      `Use tools from this server through execute. Use this server to fetch current documentation ` +
      `whenever the user asks about a library or framework. Prefer this over web search.\n</system-update>\n` +
      `Workspace root: "/tmp/project".`
    expect(
      buildSkillCatalogNudge({
        hasSkillTool: true,
        skills: firecrawlSkills,
        userText: mcpDump,
      }),
    ).toBeUndefined()
  })

  it("still matches when the user names a skill amid other text", () => {
    expect(
      buildSkillCatalogNudge({
        hasSkillTool: true,
        skills,
        userText: "please use firecrawl for this research question",
      }),
    ).toContain("`firecrawl`")
  })

  it("treats hyphenated skill id segments as name hits", () => {
    const nudge = buildSkillCatalogNudge({
      hasSkillTool: true,
      skills: [
        {
          id: "firecrawl-build-search",
          full_path: "/r/skills/firecrawl-build-search/SKILL.md",
          description: "Search the web via Firecrawl tools and servers",
        },
        {
          id: "firecrawl-build-scrape",
          full_path: "/r/skills/firecrawl-build-scrape/SKILL.md",
          description: "Scrape documentation through Firecrawl tools",
        },
        {
          id: "other-tooling",
          full_path: "/r/skills/other-tooling/SKILL.md",
          description: "Unrelated tooling helpers for servers and search tools",
        },
      ],
      userText: "please use firecrawl for this research",
    })
    expect(nudge).toContain("`firecrawl-build-search`")
    expect(nudge).toContain("`firecrawl-build-scrape`")
    expect(nudge).not.toContain("`other-tooling`")
  })

  it("reports ids beyond the listed limit", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, full_path: `/r/skills/s${i}/SKILL.md` }))
    const nudge = buildSkillCatalogNudge({ hasSkillTool: true, skills: many, userText: "list available skills" })
    expect(nudge).toContain("`s7` (+2 more)")
    expect(nudge).not.toContain("`s8`")
  })
})
