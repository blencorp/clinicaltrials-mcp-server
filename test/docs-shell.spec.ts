// The shell templates in the docs run as written, with `npx` replaced by a stub that records its
// arguments and environment. A template the shell breaks before it reaches the command (an
// unquoted `<placeholder>` is read as redirection) never calls the stub. No network.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

interface Call { args: string[]; env: Record<string, string> }
const FILES = ['README.md', 'site/src/content/docs/self-host.mdx'];
const PACKAGE = '@blen/clinicaltrials-mcp-server';

/** The ```bash blocks of a Markdown file that call npx, with the line each starts on. */
function bashBlocks(file: string): { line: number; body: string }[] {
  const lines = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n');
  const blocks: { line: number; body: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== '```bash') continue;
    const end = lines.indexOf('```', i + 1);
    const body = lines.slice(i + 1, end).join('\n');
    if (/\bnpx /.test(body)) blocks.push({ line: i + 1, body });
    i = end;
  }
  return blocks;
}
const invocations = (body: string) => body.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n').match(/\bnpx /g)?.length ?? 0;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctgov-docs-shell-'));
  const stub = join(dir, 'npx');
  writeFileSync(stub, `#!/bin/sh\nnode -e 'const e = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("CTGOV_")));\nrequire("fs").appendFileSync(process.argv[1], JSON.stringify({ args: process.argv.slice(2), env: e }) + "\\n")' "${join(dir, 'calls.jsonl')}" "$@"\n`);
  chmodSync(stub, 0o755);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function run(script: string) {
  const record = join(dir, 'calls.jsonl');
  rmSync(record, { force: true });
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } });
  let calls: Call[] = [];
  try { calls = readFileSync(record, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Call); } catch { /* the script never reached the stub */ }
  return { status: r.status, stderr: r.stderr, calls };
}

describe.each(FILES)('shell templates in %s', (file) => {
  const blocks = bashBlocks(file);
  it('has templates to check', () => expect(blocks.length).toBeGreaterThan(0));
  it.each(blocks.map((b) => [`line ${b.line}`, b.body] as const))('%s reaches every npx call with whole URLs', (_where, body) => {
    const { status, stderr, calls } = run(body);
    expect(stderr).toBe('');
    expect(status).toBe(0);
    expect(calls).toHaveLength(invocations(body));
    for (const call of calls) {
      expect(call.args[0]).toBe(PACKAGE);
      for (const name of ['CTGOV_AUTH_ISSUER', 'CTGOV_AUTH_AUDIENCE', 'CTGOV_AUTH_JWKS_URL', 'CTGOV_PUBLIC_ORIGIN']) {
        if (call.env[name]) expect(() => new URL(call.env[name]!), name).not.toThrow();
      }
    }
  });
});

describe('the OIDC template', () => {
  it.each(FILES)('in %s passes the issuer, audience, JWKS URL and origin as whole URLs', (file) => {
    const call = run(bashBlocks(file).find((b) => b.body.includes('CTGOV_AUTH_PROVIDER'))!.body).calls.at(-1)!;
    expect(call.env).toMatchObject({
      CTGOV_AUTH_PROVIDER: 'clerk',
      CTGOV_AUTH_ISSUER: 'https://your-tenant.clerk.accounts.dev',
      CTGOV_AUTH_AUDIENCE: 'https://your-host.example.com/mcp',
      CTGOV_AUTH_JWKS_URL: 'https://your-tenant.clerk.accounts.dev/.well-known/jwks.json',
      CTGOV_PUBLIC_ORIGIN: 'https://your-host.example.com',
    });
  });
});

describe('the template check itself', () => {
  it('fails when the shell reads a placeholder as redirection', () => {
    const { status, calls } = run(`CTGOV_AUTH_ISSUER=https://<tenant>.example.com npx ${PACKAGE} --http`);
    expect(status).not.toBe(0);
    expect(calls).toEqual([]);
  });
});
