// The documentation site's static handler (src/accounts/docs.ts) and its mount in the anonymous
// --public-docs server. The account-mode mount is tested in accounts.spec.ts.
import express from 'express';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOCS_PATH, docsPolicy, docsRoute } from '../src/accounts/docs.js';
import { startHttpServer, type HttpHandle } from '../src/server/http.js';

const INLINE = 'window.docs=1';
const hash = `'sha256-${createHash('sha256').update(INLINE).digest('base64')}'`;
let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'ctgov-docs-spec-'));
  writeFileSync(join(root, 'index.html'), `<html><script>${INLINE}</script><script src="/docs/x.js"></script><title>Docs</title></html>`);
  writeFileSync(join(root, '404.html'), '<html><title>Not found</title></html>');
  mkdirSync(join(root, '_astro'));
  writeFileSync(join(root, '_astro', 'a.abc123.js'), 'export {}');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function get(base: string, path: string, headers: Record<string, string> = {}) {
  const u = new URL(base);
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    httpRequest({ host: u.hostname, port: u.port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on('error', reject).end();
  });
}

describe('docs policy and handler', () => {
  it('allows only the pages\' own inline scripts, by hash, and nothing from elsewhere', () => {
    const policy = docsPolicy(root);
    expect(policy).toContain(`script-src 'self' 'wasm-unsafe-eval' ${hash}`);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it('is absent when the site is not built', () => {
    expect(docsRoute(join(root, 'missing'))).toBeUndefined();
  });

  describe('mounted in an Express app', () => {
    let server: Server, base = '';
    beforeAll(async () => {
      const app = express().use(DOCS_PATH, docsRoute(root)!);
      server = app.listen(0, '127.0.0.1');
      await new Promise((resolve) => server.once('listening', resolve));
      base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

    it('caches hashed assets for a year and pages for five minutes, and answers misses with the 404 page', async () => {
      expect((await get(base, '/docs/_astro/a.abc123.js')).headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect((await get(base, '/docs/')).headers['cache-control']).toBe('public, max-age=300');
      const miss = await get(base, '/docs/no-such/');
      expect(miss.status).toBe(404);
      expect(miss.body).toContain('Not found');
      expect(miss.headers['cache-control']).toBe('no-store');
      expect(miss.headers['content-security-policy']).toContain(hash);
    });

    it('redirects /docs to /docs/, keeping the query', async () => {
      const moved = await get(base, '/docs?x=1');
      expect([moved.status, moved.headers.location]).toEqual([301, '/docs/?x=1']);
    });

    it.skipIf(process.getuid?.() === 0)('reports a file it cannot read as a server error, not a 404', async () => {
      const file = join(root, 'locked.html');
      writeFileSync(file, '<html></html>');
      chmodSync(file, 0o000);
      try {
        expect((await get(base, '/docs/locked.html')).status).toBe(500);
      } finally {
        chmodSync(file, 0o600);
      }
    });
  });
});

describe('--public-docs serves the site; other modes do not', () => {
  const open: HttpHandle[] = [];
  afterAll(async () => { await Promise.all(open.map((h) => h.close())); });
  async function serve(opts: Parameters<typeof startHttpServer>[0]) {
    const h = await startHttpServer({ port: 0, host: '127.0.0.1', ...opts, docsRoot: root });
    open.push(h);
    return `http://127.0.0.1:${h.port}`;
  }

  it('serves /docs/ with its own CSP, redirects /docs, and applies the Host check', async () => {
    const base = await serve({ publicDocs: true });
    const page = await get(base, '/docs/');
    expect(page.status).toBe(200);
    expect(page.body).toContain('<title>Docs</title>');
    expect(page.headers['content-security-policy']).toContain(hash);
    expect(page.headers['x-powered-by']).toBeUndefined();
    const moved = await get(base, '/docs?q=1');
    expect([moved.status, moved.headers.location]).toEqual([301, '/docs/?q=1']);
    expect((await get(base, '/docs/nope/')).status).toBe(404);
    expect((await get(base, '/docs/', { host: 'evil.example' })).status).toBe(421);
    expect((await get(base, '/docsfoo')).status).toBe(404);
  });

  it('does not serve it with --insecure', async () => {
    const base = await serve({ insecure: true });
    const r = await get(base, '/docs/');
    expect(r.status).toBe(404);
    expect(JSON.parse(r.body)).toMatchObject({ error: 'not_found' });
  });
});
