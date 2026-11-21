import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// dist/web/THIRD_PARTY_NOTICES.txt ships in the npm package and the image. It must name every
// package whose code is in the portal: the runtime libraries in the JavaScript and the CSS
// packages Tailwind compiles in. Build tools (Vite and its plugins) generate the bundle but put
// none of their own code in it.
const notices = new URL('../dist/web/THIRD_PARTY_NOTICES.txt', import.meta.url);
const BUILD_TOOLS = ['vite', '@vitejs/plugin-react', '@tailwindcss/vite'];

/** Bare package names imported by web/src (client code) and its stylesheet. */
function bundled(): string[] {
  const names = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(tsx?|css)$/.test(entry.name)) {
        for (const [, spec] of readFileSync(path, 'utf8').matchAll(/(?:from\s+|@import\s+|import\s+)['"]([^'"]+)['"]/g)) {
          if (spec!.startsWith('.') || spec!.startsWith('@/') || spec!.startsWith('node:')) continue;
          const parts = spec!.split('/');
          names.add(spec!.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!);
        }
      }
    }
  };
  walk(new URL('../web/src', import.meta.url).pathname);
  return [...names].filter((n) => !BUILD_TOOLS.includes(n)).sort();
}

describe.skipIf(!existsSync(notices))('third-party notices (needs pnpm build)', () => {
  it('lists every bundled runtime package with its license text', () => {
    const text = readFileSync(notices, 'utf8');
    const listed = new Set([...text.matchAll(/^(@?[^@\s]+)@\S+ — /gm)].map((m) => m[1]));
    const expected = bundled();
    expect(expected).toContain('react');
    expect(expected.filter((name) => !listed.has(name))).toEqual([]);
    expect(text).toMatch(/Permission is hereby granted|Apache License|ISC License/);
  });
});
