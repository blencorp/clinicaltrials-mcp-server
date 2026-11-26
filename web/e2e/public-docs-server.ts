// Serves the anonymous --public-docs server, the hosted service's mode, through the real
// startHttpServer: the docs-only landing page and policies (dist/web-docs) and /docs (site/dist).
// Used by playwright.config.ts for public-docs.spec.ts; a plain Node process, so Playwright's
// teardown stops it.
//
//   pnpm exec tsx web/e2e/public-docs-server.ts   (port 4176)
import { fileURLToPath } from 'node:url';
import { startHttpServer } from '../../src/server/http.js';

await startHttpServer({
  publicDocs: true,
  port: 4176,
  host: '127.0.0.1',
  docsRoot: fileURLToPath(new URL('../../site/dist', import.meta.url)),
  portalRoot: fileURLToPath(new URL('../../dist/web-docs', import.meta.url)),
});
