#!/usr/bin/env node
// Stages an MCPB (MCP Bundle) directory for `mcpb pack mcpb-build`.
// Run from the repo root, after `pnpm build`:  pnpm build && pnpm mcpb:prepare
import { mkdirSync, cpSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

/**
 * The MCPB manifest, shaped for @anthropic-ai/mcpb's manifest schema (v0.4; required: name,
 * version, description, author, server; the entry point lives inside `server`, not at the top
 * level). ClinicalTrials.gov needs no key, so there is no user_config and no env.
 */
export function buildManifest(pkg) {
  // The repository's address comes from package.json, so a move is changed there only.
  const repo = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
  return {
    manifest_version: '0.4',
    name: 'clinicaltrials-mcp-server',
    display_name: 'ClinicalTrials.gov MCP',
    version: pkg.version,
    description:
      'Code-mode MCP server for ClinicalTrials.gov: search studies, statistics and field metadata through the ctgov SDK, with no API key.',
    long_description:
      'Ask about registered clinical studies: conditions, interventions, sponsors, phases, status, eligibility, locations and results. ' +
      'The assistant writes small JavaScript programs that run in a sandbox (isolated-vm, or Deno) against the public ClinicalTrials.gov API; ' +
      'no API key is needed and nothing leaves your computer except those API requests. ' +
      'Independent open-source project; not affiliated with or endorsed by the U.S. National Library of Medicine or the NIH.',
    author: { name: 'BLEN, Inc.', url: 'https://blenlabs.com' },
    repository: { type: 'git', url: repo },
    homepage: pkg.homepage,
    documentation: pkg.homepage,
    support: pkg.bugs.url,
    privacy_policies: [`${repo}/blob/main/legal/privacy-policy.md`],
    license: pkg.license,
    keywords: ['clinicaltrials', 'clinical trials', 'clinicaltrials.gov', 'nlm', 'studies', 'code mode'],
    tools: [
      { name: 'search_api', description: 'Find ctgov SDK methods and response fields' },
      { name: 'describe_schema', description: 'Exact signature and fields for a method or namespace' },
      { name: 'execute', description: 'Run JavaScript against the ctgov SDK in a sandbox' },
    ],
    // Same range as package.json "engines": isolated-vm ships prebuilt binaries only for
    // those majors (darwin-arm64, linux-x64/arm64, win32-x64); elsewhere execute uses Deno.
    compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: pkg.engines.node } },
    server: {
      type: 'node',
      entry_point: 'dist/bin.js',
      mcp_config: {
        command: 'node',
        // ${__dirname} is expanded by the MCPB host to the unpacked bundle dir. The placeholder
        // is MCPB manifest syntax, deliberately not a template literal.
        /* eslint-disable-next-line no-template-curly-in-string */
        args: ['${__dirname}/dist/bin.js'],
      },
    },
  };
}

function main() {
  const root = resolve(process.cwd());
  const out = resolve(root, 'mcpb-build');
  if (existsSync(out)) rmSync(out, { recursive: true });
  mkdirSync(out, { recursive: true });

  cpSync(resolve(root, 'dist'), resolve(out, 'dist'), { recursive: true });
  cpSync(resolve(root, 'schema'), resolve(out, 'schema'), { recursive: true });
  cpSync(resolve(root, 'package.json'), resolve(out, 'package.json'));
  // Reproducible: the bundle installs exactly the tested lockfile.
  cpSync(resolve(root, 'pnpm-lock.yaml'), resolve(out, 'pnpm-lock.yaml'));
  // The bundle's own workspace root: carries the dependency overrides the lockfile was resolved
  // with (a frozen install refuses a mismatch), and stops pnpm from walking up to the repo root.
  cpSync(resolve(root, 'pnpm-workspace.yaml'), resolve(out, 'pnpm-workspace.yaml'));
  // Keeps better-auth's optional peers (vitest, react) out of the production graph.
  cpSync(resolve(root, '.pnpmfile.cjs'), resolve(out, '.pnpmfile.cjs'));
  for (const f of ['LICENSE', 'NOTICE', 'README.md']) cpSync(resolve(root, f), resolve(out, f));

  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  writeFileSync(resolve(out, 'manifest.json'), JSON.stringify(buildManifest(pkg), null, 2));

  // The bundle must carry its production node_modules — Claude Desktop runs it
  // with a plain `node`, with no install step. Hoisted layout: pnpm's default
  // symlink store does not survive zipping. --ignore-scripts skips native builds:
  // isolated-vm loads its shipped prebuilt binary at runtime (Node 24/26 on the
  // common platforms); elsewhere execute falls back to Deno or reports
  // SandboxUnavailable with instructions.
  // The copied pnpm-workspace.yaml makes mcpb-build/ its own workspace root, so this
  // installs (and --prod-prunes) the bundle's node_modules, never the repo root's.
  execFileSync(
    'pnpm',
    ['install', '--prod', '--frozen-lockfile', '--ignore-scripts', '--config.node-linker=hoisted'],
    { cwd: out, stdio: 'inherit' },
  );

  // Fail loudly here rather than at `mcpb pack` time.
  execFileSync(
    process.execPath,
    [resolve(root, 'node_modules/@anthropic-ai/mcpb/dist/cli/cli.js'), 'validate', resolve(out, 'manifest.json')],
    { stdio: 'inherit' },
  );

  console.log('mcpb-build/ prepared at', out);
  console.log('next: pnpm mcpb:pack   (packs mcpb-build/ into a .mcpb)');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}
