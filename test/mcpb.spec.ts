import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildManifest } from '../scripts/mcpb-prepare.mjs';

// The MCPB manifest must satisfy @anthropic-ai/mcpb's manifest schema — the old
// DXT-shaped manifest (top-level entry_point/runtime/transport, no author or
// server) was rejected by `mcpb validate` and made packing impossible.
describe('mcpb manifest', () => {
  const pkg = {
    version: '9.9.9',
    engines: { node: '^24.11.0 || ^26.0.0' },
    repository: { type: 'git', url: 'git+https://github.com/example-org/ctgov-repo.git' },
    homepage: 'https://github.com/example-org/ctgov-repo#readme',
    bugs: { url: 'https://github.com/example-org/ctgov-repo/issues' },
  };

  it('builds a v0.4 manifest with the required author and server blocks', () => {
    const m = buildManifest(pkg);
    expect(m.author.name).toBeTruthy();
    expect(m.server.type).toBe('node');
    expect(m.server.entry_point).toBe('dist/bin.js');
    expect(m.server.mcp_config.command).toBe('node');
    expect(m.server.mcp_config.args.join(' ')).toContain('dist/bin.js');
    expect(m.version).toBe('9.9.9');
    expect(m.compatibility.runtimes.node).toBe(pkg.engines.node);
    // ClinicalTrials.gov needs no key: nothing to configure, nothing in the environment.
    expect('user_config' in m).toBe(false);
    expect('env' in m.server.mcp_config).toBe(false);
    // MCPB manifest placeholder syntax, not a template literal.
    // eslint-disable-next-line no-template-curly-in-string
    expect(m.server.mcp_config.args).toEqual(['${__dirname}/dist/bin.js']);
    // Links come from package.json, so a repository move changes one file.
    expect([m.repository.url, m.homepage, m.documentation, m.support, ...m.privacy_policies]).toEqual([
      'https://github.com/example-org/ctgov-repo',
      'https://github.com/example-org/ctgov-repo#readme',
      'https://github.com/example-org/ctgov-repo#readme',
      'https://github.com/example-org/ctgov-repo/issues',
      'https://github.com/example-org/ctgov-repo/blob/main/legal/privacy-policy.md',
    ]);
    expect(m.tools.map((t) => t.name)).toEqual(['search_api', 'describe_schema', 'execute']);
    // Legacy DXT keys must not reappear at the top level.
    expect('entry_point' in m).toBe(false);
    expect('runtime' in m).toBe(false);
    expect('transport' in m).toBe(false);
  });

  it('passes the official mcpb validator', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcpb-manifest-test-'));
    const manifestPath = join(dir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(buildManifest(pkg), null, 2));
    const r = spawnSync(
      process.execPath,
      ['node_modules/@anthropic-ai/mcpb/dist/cli/cli.js', 'validate', manifestPath],
      { encoding: 'utf8' },
    );
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  });
});

// Versions that must be copied by hand (Dockerfile, workflows) cannot drift from their
// source of truth: a Dependabot bump to one of them fails here until the others follow.
describe('toolchain pins', () => {
  it('Deno and pnpm versions agree across package.json, the Dockerfile and CI', () => {
    const read = (p: string) => readFileSync(p, 'utf8');
    const dockerfile = read('deploy/Dockerfile');
    const ci = read('.github/workflows/ci.yml');
    const packageManager = (JSON.parse(read('package.json')) as { packageManager: string }).packageManager;
    expect({
      pnpm: /npm install -g --ignore-scripts (pnpm@\S+)/.exec(dockerfile)?.[1],
      deno: /denoland\/deno:bin-(\S+?)@sha256:/.exec(dockerfile)?.[1],
    }).toEqual({
      pnpm: packageManager,
      deno: /deno-version: v(\S+)/.exec(ci)?.[1],
    });
  });
});
