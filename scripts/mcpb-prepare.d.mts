export interface McpbManifest {
  manifest_version: string;
  name: string;
  display_name: string;
  version: string;
  description: string;
  documentation: string;
  homepage: string;
  support: string;
  privacy_policies: string[];
  repository: { type: string; url: string };
  author: { name: string; url?: string };
  server: {
    type: 'node';
    entry_point: string;
    mcp_config: { command: string; args: string[] };
  };
  compatibility: { platforms: string[]; runtimes: { node: string } };
  tools: Array<{ name: string; description: string }>;
  license: string;
}

export declare function buildManifest(pkg: { version: string; license?: string; engines: { node: string } }): McpbManifest;
