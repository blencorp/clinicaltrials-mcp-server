import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { prerender } from './prerender.ts';
import { thirdPartyNotices } from './third-party-notices.ts';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// Two builds of the same sources. The default is the account-mode portal (dist/web). Mode
// `docs-only` is what the anonymous `--public-docs` server serves (dist/web-docs): `@/brand` is
// replaced by src/docs-only/brand.tsx (no accounts) and only the pages that server has are built,
// all prerendered. See `build:web` in package.json.
export default defineConfig(({ mode }) => {
  const docsOnly = mode === 'docs-only';
  return {
    root: here('.'),
    plugins: [
      react(),
      tailwindcss(),
      thirdPartyNotices({ stylesheets: [here('./src/index.css')] }),
      docsOnly
        ? prerender({
            entry: 'src/docs-only/prerender.tsx',
            template: 'docs-only.html',
            routes: { 'index.html': '/', 'privacy-policy.html': '/privacy-policy', 'terms.html': '/terms' },
          })
        : prerender({ entry: 'src/prerender.tsx', routes: { 'privacy-policy.html': '/privacy-policy', 'terms.html': '/terms' } }),
    ],
    resolve: {
      alias: [
        ...(docsOnly ? [{ find: /^@\/brand$/, replacement: here('./src/docs-only/brand.tsx') }] : []),
        { find: '@', replacement: here('./src') },
      ],
    },
    build: {
      outDir: here(docsOnly ? '../dist/web-docs' : '../dist/web'),
      emptyOutDir: true,
      ...(docsOnly ? { rollupOptions: { input: here('./docs-only.html') } } : {}),
      // The page CSP allows only same-origin files: no inline scripts or styles.
      modulePreload: { polyfill: false },
      assetsInlineLimit: 0,
    },
  };
});
