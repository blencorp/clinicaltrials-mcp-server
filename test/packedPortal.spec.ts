// The npm artifact, as a user gets it: pack, unpack, start `--public-docs` from the unpacked
// package, and follow every link on the landing page and the policies. The package does not ship
// the documentation site (only the Docker image does), so the pages must link to the hosted copy
// and every same-origin link must work. Needs `pnpm build` (CI builds before testing).
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base, site } from '../site/product.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const built = existsSync(join(root, 'dist/web-docs/index.html'));
if (!built && process.env.CI) throw new Error('dist is missing: run `pnpm build` before `pnpm test` in CI');

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });

describe.skipIf(!built)('the packed npm artifact (needs pnpm build)', () => {
  let dir: string;
  let server: ChildProcess;
  let origin = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ctgov-packed-'));
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', dir], { cwd: root, encoding: 'utf8' })) as { filename: string }[];
    execFileSync('tar', ['-xzf', join(dir, packed[0]!.filename), '-C', dir]);
    // The unpacked package runs against the repository's installed dependencies.
    symlinkSync(join(root, 'node_modules'), join(dir, 'package/node_modules'));
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    server = spawn(process.execPath, ['dist/bin.js', '--http', '--public-docs', '--host', '127.0.0.1', '--port', String(port)], { cwd: join(dir, 'package'), stdio: 'ignore' });
    for (let i = 0; i < 100; i++) {
      if (await fetch(`${origin}/health`).then((r) => r.ok, () => false)) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('the packed server did not start');
  }, 60_000);
  afterAll(() => {
    server?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(['/', '/privacy-policy', '/terms'])('%s: every link works or points at the hosted documentation', async (path) => {
    const html = await (await fetch(`${origin}${path}`)).text();
    const hrefs = [...new Set([...html.matchAll(/href="([^"#]*)[^"]*"/g)].map((m) => m[1]!).filter(Boolean))];
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs.filter((h) => h.startsWith('/'))) {
      expect(href, `${path} links to ${href}, which the package does not serve`).not.toMatch(/^\/docs(\/|$)/);
      expect((await fetch(`${origin}${href}`)).status, href).toBe(200);
    }
    // The documentation links are to the hosted site, never to a /docs this package lacks.
    const docs = hrefs.filter((h) => h.startsWith(`${site}${base}/`));
    expect(docs.length).toBeGreaterThan(0);
  });
});
