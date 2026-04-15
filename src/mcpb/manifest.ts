import { TOOL_CATALOG } from "../server/toolCatalog.js";

export interface McpbDenoTarget {
  platform: NodeJS.Platform;
  arch: string;
  binaryRelativePath: string;
}

export interface BuildMcpbManifestOptions {
  version: string;
  nodeVersionRange: string;
  denoTargets: readonly McpbDenoTarget[];
}

interface McpbConfig {
  command: string;
  args: string[];
  env: {
    CTGOV_DENO_ROOT: string;
  };
}

export function buildMcpbManifest(opts: BuildMcpbManifestOptions): Record<string, unknown> {
  if (opts.denoTargets.length === 0) {
    throw new Error("At least one Deno bundle target is required.");
  }

  const platformSet = Array.from(new Set(opts.denoTargets.map((target) => target.platform)));
  const bundledTargets = Array.from(
    new Set(opts.denoTargets.map((target) => `${target.platform}-${target.arch}`)),
  );

  const mcpConfig: McpbConfig = {
    command: "node",
    args: ["${__dirname}/dist/bin.js", "--stdio", "--sandbox", "deno"],
    env: {
      CTGOV_DENO_ROOT: "${__dirname}/vendor/deno",
    },
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
      "This MCPB bundles per-platform Deno sandbox helpers so the `execute` tool can run without asking end users to install Deno themselves.",
      "",
      `Included targets: ${bundledTargets.join(", ")}.`,
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
      platforms: platformSet,
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
