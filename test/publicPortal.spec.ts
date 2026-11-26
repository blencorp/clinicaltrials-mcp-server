// The landing page, /privacy-policy and /terms of the anonymous --public-docs server (BLEN's hosted
// service): served from the `docs-only` build of web/ (dist/web-docs), which must never offer a
// sign-in or link to /sign-in, /account or /mcp/account, because that server has no sessions.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PORTAL_CSP } from '../src/accounts/docs.js';
import { startHttpServer, type HttpHandle } from '../src/server/http.js';

const BUILT = fileURLToPath(new URL('../dist/web-docs/', import.meta.url));
const built = existsSync(join(BUILT, 'index.html'));
if (!built && process.env.CI) throw new Error('dist/web-docs is missing: run `pnpm build` before `pnpm test` in CI');

function get(base: string, path: string, init: { method?: string; headers?: Record<string, string> } = {}) {
  const u = new URL(base);
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
    httpRequest({ host: u.hostname, port: u.port, path, ...init }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
    }).on('error', reject).end();
  });
}

const open: HttpHandle[] = [];
afterAll(async () => { await Promise.all(open.map((h) => h.close())); });
async function serve(opts: Parameters<typeof startHttpServer>[0]) {
  const h = await startHttpServer({ port: 0, host: '127.0.0.1', ...opts });
  open.push(h);
  return `http://127.0.0.1:${h.port}`;
}

describe('--public-docs portal pages (fixture build)', () => {
  let root: string;
  let base: string;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'ctgov-portal-spec-'));
    for (const [file, title] of [['index.html', 'Home'], ['privacy-policy.html', 'Privacy'], ['terms.html', 'Terms']] as const) {
      writeFileSync(join(root, file), `<html><title>${title}</title></html>`);
    }
    mkdirSync(join(root, 'assets'));
    writeFileSync(join(root, 'assets', 'app-abc123.js'), 'export {}');
    base = await serve({ publicDocs: true, portalRoot: root });
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('serves /, /privacy-policy and /terms as HTML with the portal CSP, with or without a trailing slash', async () => {
    for (const [path, title] of [['/', 'Home'], ['/privacy-policy', 'Privacy'], ['/privacy-policy/', 'Privacy'], ['/terms', 'Terms']] as const) {
      const r = await get(base, path);
      expect([path, r.status, r.body]).toEqual([path, 200, `<html><title>${title}</title></html>`]);
      expect(r.headers['content-type']).toMatch(/^text\/html/);
      expect(r.headers['content-security-policy']).toBe(PORTAL_CSP);
      expect(r.headers['cache-control']).toBe('public, max-age=300');
      expect(r.headers['x-powered-by']).toBeUndefined();
    }
  });

  it('serves hashed assets as immutable and answers a missing asset or any other path with the JSON 404', async () => {
    const asset = await get(base, '/assets/app-abc123.js');
    expect([asset.status, asset.headers['cache-control']]).toEqual([200, 'public, max-age=31536000, immutable']);
    for (const path of ['/assets/missing.js', '/sign-in', '/account', '/mcp/account', '/consent']) {
      const r = await get(base, path);
      expect([path, r.status, JSON.parse(r.body).error]).toEqual([path, 404, 'not_found']);
    }
  });

  it('answers a write to a page with the JSON 404 and keeps the Host check in front of the pages', async () => {
    expect((await get(base, '/', { method: 'POST' })).status).toBe(404);
    expect((await get(base, '/', { headers: { host: 'evil.example' } })).status).toBe(421);
  });

  it('is not served with --insecure, nor when the portal is not built', async () => {
    expect((await get(await serve({ insecure: true, portalRoot: root }), '/')).status).toBe(404);
    expect((await get(await serve({ publicDocs: true, portalRoot: join(root, 'missing') }), '/')).status).toBe(404);
  });
});

describe.skipIf(!built)('the built docs-only portal (needs pnpm build)', () => {
  const PAGES = ['/', '/privacy-policy', '/terms'];

  it('serves a landing page that connects to /mcp and offers no sign-in or account', async () => {
    const base = await serve({ publicDocs: true });
    const home = (await get(base, '/')).body;
    expect(home).toContain('<h1');
    expect(home).toContain('Read the docs');
    expect(home).toContain('href="/docs/"');
    expect(home).not.toMatch(/Create an account|Sign in/i);
  });

  it.each(PAGES)('%s links to no sign-in, account or consent page', async (path) => {
    const base = await serve({ publicDocs: true });
    const r = await get(base, path);
    expect(r.status).toBe(200);
    expect(r.body).toContain('<main');
    expect(r.body.match(/href="[^"]*"/g)?.filter((h) => /\/(sign-in|account|consent)\b|mcp\/account/.test(h))).toEqual([]);
  });
});
