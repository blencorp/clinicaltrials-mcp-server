// The npm install path is advertised only once the package exists: `distribution.npm` in
// site/product.mjs is the one switch (false until the first publication). While it is false the
// README says so, and so do the pages that mention `npx`; once it is true those notes must be gone.
// Flipping it: set it to true, delete the "not yet published" notes this test names, and check
// `npm view @blen/clinicaltrials-mcp-server version` first.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { distribution } from '../site/product.mjs';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe(`npm install paths (distribution.npm = ${distribution.npm})`, () => {
  const notes: [string, string][] = [['README.md', 'Not yet published to npm']];
  it.each(notes)('%s carries its "not yet published" note only while unpublished', (file, note) => {
    expect(read(file).includes(note)).toBe(!distribution.npm);
  });

  it.each(['site/src/content/docs/index.mdx', 'site/src/content/docs/connect.mdx', 'site/src/content/docs/self-host.mdx'])(
    '%s reads the switch instead of advertising npx unconditionally',
    (file) => expect(read(file)).toContain('distribution.npm'),
  );
});
