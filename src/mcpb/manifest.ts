import { TOOL_CATALOG } from "../server/toolCatalog.js";

export interface BuildMcpbManifestOptions {
  version: string;
  nodeVersionRange: string;
}

/**
 * The bundle runs the stdio server with a plain `node`. `execute` uses isolated-vm, whose
 * prebuilt binaries ship in the package for Node 24 and 26 on macOS arm64, Linux x64/arm64 and
 * Windows x64; elsewhere `execute` reports why it is unavailable and the other tools still work.
 */
export function buildMcpbManifest(opts: BuildMcpbManifestOptions): Record<string, unknown> {
  const mcpConfig = {
    command: "node",
    // eslint-disable-next-line no-template-curly-in-string -- MCPB host placeholder, not a JS template
    args: ["${__dirname}/dist/bin.js", "--stdio"],
  };

  return {
    manifest_version: "0.3",
    name: "clinicaltrial-mcp-server",
    display_name: "ClinicalTrials.gov Explorer (by BLEN)",
    version: opts.version,
    description:
      "Explore the ClinicalTrials.gov API through three code-mode MCP tools for endpoint search, field documentation lookup, and sandboxed SDK execution.",
    long_description: [
      "ClinicalTrials.gov Explorer packages the local stdio server from `@blen/clinicaltrial-mcp-server` as a Claude Desktop extension.",
      "",
      "`execute` runs your code in an isolated-vm sandbox bundled with the extension (Node 24 or 26 on macOS arm64, Linux x64/arm64 and Windows x64); nothing else needs installing.",
    ].join("\n"),
    author: {
      name: "Blen",
      email: "opensource@blencorp.com",
    },
    repository: {
      type: "git",
      url: "https://github.com/blencorp/claude-playground.git",
    },
    homepage: "https://github.com/blencorp/claude-playground",
    documentation:
      "https://github.com/blencorp/claude-playground#readme",
    support: "https://github.com/blencorp/claude-playground/issues",
    license: "MIT",
    keywords: [
      "mcp",
      "model-context-protocol",
      "clinicaltrials",
      "clinical-trials",
      "anthropic",
      "claude",
      "desktop-extension",
    ],
    privacy_policies: [
      "https://github.com/blencorp/claude-playground/blob/main/legal/privacy-policy.md",
      "https://www.nlm.nih.gov/privacy.html",
    ],
    compatibility: {
      platforms: ["darwin", "linux", "win32"],
      runtimes: {
        node: opts.nodeVersionRange,
      },
    },
    server: {
      type: "node",
      entry_point: "dist/bin.js",
      mcp_config: mcpConfig,
    },
    tools: TOOL_CATALOG.map(({ name, description }) => ({
      name,
      description,
    })),
  };
}
