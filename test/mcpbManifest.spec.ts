import { describe, expect, it } from "vitest";
import { buildMcpbManifest } from "../src/mcpb/manifest.js";

describe("buildMcpbManifest", () => {
  it("builds a multi-platform node MCPB manifest with bundled Deno helpers", () => {
    const manifest = buildMcpbManifest({
      version: "0.1.0-alpha.0",
      nodeVersionRange: ">=20.10",
      denoTargets: [
        {
          platform: "darwin",
          arch: "arm64",
          binaryRelativePath: "vendor/deno/darwin-arm64/deno",
        },
        {
          platform: "darwin",
          arch: "x64",
          binaryRelativePath: "vendor/deno/darwin-x64/deno",
        },
        {
          platform: "win32",
          arch: "x64",
          binaryRelativePath: "vendor/deno/win32-x64/deno.exe",
        },
      ],
    }) as {
      manifest_version: string;
      compatibility: { platforms: string[]; runtimes: { node: string } };
      server: {
        entry_point: string;
        mcp_config: {
          args: string[];
          env: { CTGOV_DENO_ROOT: string };
          platform_overrides?: unknown;
        };
      };
      tools: Array<{ name: string }>;
    };

    expect(manifest.manifest_version).toBe("0.3");
    expect(manifest.compatibility.platforms).toEqual(["darwin", "win32"]);
    expect(manifest.compatibility.runtimes.node).toBe(">=20.10");
    expect(manifest.server.entry_point).toBe("dist/bin.js");
    expect(manifest.server.mcp_config.args).toEqual([
      "${__dirname}/dist/bin.js",
      "--stdio",
      "--sandbox",
      "deno",
    ]);
    expect(manifest.server.mcp_config.env.CTGOV_DENO_ROOT).toBe("${__dirname}/vendor/deno");
    expect(manifest.server.mcp_config.platform_overrides).toBeUndefined();
    expect(manifest.tools.map((tool) => tool.name)).toEqual([
      "search_api",
      "describe_schema",
      "execute",
    ]);
  });
});
