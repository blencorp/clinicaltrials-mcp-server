import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Where the Docker image puts the built documentation site (site/, built with base `/docs`). */
export const DOCS_PATH = '/docs';

const INLINE_SCRIPT = /<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

function htmlFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return htmlFiles(path);
    return entry.name.endsWith('.html') ? [path] : [];
  });
}

/**
 * The docs share an origin with the portal's session cookies, so they get their own policy: inline
 * scripts run only if their hash is listed (computed once from the built pages), and search
 * (Pagefind) may compile WebAssembly. Inline styles stay allowed; they cannot run code.
 */
export function docsPolicy(root: string): string {
  const hashes = new Set<string>();
  for (const file of htmlFiles(root)) {
    for (const [, body = ''] of readFileSync(file, 'utf8').matchAll(INLINE_SCRIPT)) {
      if (body.trim()) hashes.add(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
    }
  }
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${[...hashes].sort().join(' ')}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Serves the built documentation site, or returns undefined when it is not there (an npm install
 * or a local build without `cd site && pnpm build`). Hashed assets under _astro/ are immutable;
 * pages are cached briefly so a deploy shows up within minutes.
 */
export function docsHandler(root: string): express.Handler | undefined {
  if (!existsSync(join(root, 'index.html'))) return undefined;
  const policy = docsPolicy(root);
  const files = express.static(root, {
    index: 'index.html',
    dotfiles: 'ignore',
    fallthrough: true,
    setHeaders: (res, path) => {
      res.setHeader('Content-Security-Policy', policy);
      res.setHeader(
        'Cache-Control',
        path.includes(`${join('/', '_astro')}/`) ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
      );
    },
  });
  const notFound = readFileSync(join(root, existsSync(join(root, '404.html')) ? '404.html' : 'index.html'), 'utf8');
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    files(req, res, (error?: unknown) => {
      // A read error (not a missing file) is the server's fault: report it, never as a 404.
      if (error) {
        // serve-static set the file's headers (Content-Length, caching) before the read failed; an
        // error response must not carry them, or a 500 is cached as the page.
        for (const name of ['content-length', 'content-type', 'last-modified', 'etag', 'accept-ranges', 'content-range']) res.removeHeader(name);
        res.setHeader('Cache-Control', 'no-store');
        return next(error);
      }
      res.status(404).set({ 'Content-Security-Policy': policy, 'Cache-Control': 'no-store' }).type('html').send(notFound);
    });
  };
}

/**
 * The handler to mount at DOCS_PATH: the site itself, plus a redirect from `/docs` to `/docs/`
 * (without the slash the index would be served at the wrong base). Undefined when the site is not
 * built. Shared by account mode (Express) and the anonymous `--public-docs` server.
 */
export function docsRoute(root: string): express.Handler | undefined {
  const docs = docsHandler(root);
  if (!docs) return undefined;
  return (req, res, next) => {
    const [path = '', query] = req.originalUrl.split('?');
    if (path !== DOCS_PATH) return docs(req, res, next);
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    res.redirect(301, `${DOCS_PATH}/${query === undefined ? '' : `?${query}`}`);
  };
}

/** The policy of the portal's own pages (landing, sign-in, policies): same-origin files only, nothing inline. */
export const PORTAL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

/** The pages of the anonymous `--public-docs` portal (web build mode `docs-only`), by URL path. */
const PUBLIC_PORTAL_PAGES: Record<string, string> = {
  '/': 'index.html',
  '/privacy-policy': 'privacy-policy.html',
  '/terms': 'terms.html',
};

/** Whether `path` is a page or asset that {@link publicPortalRoute} serves. */
export function isPublicPortalPath(path: string): boolean {
  return path.replace(/(?<=.)\/$/, '') in PUBLIC_PORTAL_PAGES || path.startsWith('/assets/');
}

/**
 * The landing page, privacy policy and terms of the anonymous `--public-docs` server, with their
 * assets: the `docs-only` build of web/ (dist/web-docs), which has no sign-in, account or consent
 * pages because that server has no sessions. Undefined when it is not built (`pnpm build:web`).
 */
export function publicPortalRoute(root: string): express.Router | undefined {
  // Every page must be there: a partial build would otherwise throw at startup, in readFileSync below.
  if (!Object.values(PUBLIC_PORTAL_PAGES).every((file) => existsSync(join(root, file)))) return undefined;
  const pages = new Map(Object.entries(PUBLIC_PORTAL_PAGES).map(([path, file]) => [path, readFileSync(join(root, file), 'utf8')]));
  return express
    .Router()
    .use('/assets', express.static(join(root, 'assets'), { immutable: true, maxAge: '1y', index: false }))
    .get([...pages.keys()], (req, res) => {
      res
        .set({ 'Content-Security-Policy': PORTAL_CSP, 'Cache-Control': 'public, max-age=300' })
        .type('html')
        .send(pages.get(req.path.replace(/(?<=.)\/$/, '')));
    });
}
