import { describe, expect, it } from "vitest";
import { buildMcpbManifest } from "../src/mcpb/manifest.js";

describe("buildMcpbManifest", () => {
  it("builds a node MCPB manifest that runs the stdio server with no vendored runtime or env", () => {
    const manifest = buildMcpbManifest({ version: "0.1.0-alpha.0", nodeVersionRange: "^24.11.0 || ^26.0.0" }) as {
      manifest_version: string;
      long_description: string;
      compatibility: { platforms: string[]; runtimes: { node: string } };
      server: {
        entry_point: string;
        mcp_config: { args: string[]; env?: unknown; platform_overrides?: unknown };
      };
      tools: Array<{ name: string }>;
    };

    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.compatibility.platforms).toEqual(["darwin", "linux", "win32"]);
    expect(manifest.compatibility.runtimes.node).toBe("^24.11.0 || ^26.0.0");
    expect(manifest.server.entry_point).toBe("dist/bin.js");
    // No `--sandbox deno` and no CTGOV_DENO_ROOT: stdio uses the isolated-vm sandbox (C11).
    expect(manifest.server.mcp_config.args).toEqual([
      // eslint-disable-next-line no-template-curly-in-string -- MCPB host placeholder, not a JS template
      "${__dirname}/dist/bin.js",
      "--stdio",
    ]);
    expect(manifest.server.mcp_config.env).toBeUndefined();
    expect(manifest.server.mcp_config.platform_overrides).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toMatch(/deno/i);
    expect(manifest.tools.map((tool) => tool.name)).toEqual(["search_api", "describe_schema", "execute"]);
  });
});
