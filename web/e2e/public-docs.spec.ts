import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// BLEN's hosted service runs `--http --public-docs`: anonymous, documentation tools only, no
// sessions. Its landing page and policies are the `docs-only` build of the portal, served by the
// real server (web/e2e/public-docs-server.ts). They must read the same without accounts.
test.use({ baseURL: 'http://127.0.0.1:4176' });

const PAGES = [
  { path: '/', heading: /studies in your AI assistant/i },
  { path: '/privacy-policy', heading: /privacy policy/i },
  { path: '/terms', heading: /terms of service/i },
];
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
const ACCOUNT_LINK = /\/(sign-in|account|consent)(\/|\?|#|$)|\/mcp\/account/;

for (const { path, heading } of PAGES) {
  test.describe(path, () => {
    test('shows no sign-in or account link, and makes no session request', async ({ page }) => {
      const api: string[] = [];
      page.on('request', (r) => (new URL(r.url()).pathname.startsWith('/api/') ? api.push(r.url()) : undefined));
      const problems: string[] = [];
      page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning' ? problems.push(m.text()) : undefined));
      page.on('pageerror', (e) => problems.push(e.message));
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      // Hydration has finished once the landing page shows this server's own address.
      if (path === '/') await expect(page.getByText('http://127.0.0.1:4176/mcp')).toBeVisible();
      const hrefs = await page.locator('a[href]').evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
      expect(hrefs.filter((href) => ACCOUNT_LINK.test(href))).toEqual([]);
      await expect(page.getByRole('link', { name: /sign in|account/i })).toHaveCount(0);
      await expect(page.getByText(/create an account/i)).toHaveCount(0);
      expect(api).toEqual([]);
      expect(problems).toEqual([]);
    });

    test('reads without JavaScript', async ({ browser }) => {
      const context = await browser.newContext({ javaScriptEnabled: false });
      const page = await context.newPage();
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.getByRole('main')).toBeVisible();
      await context.close();
    });

    for (const scheme of ['light', 'dark'] as const) {
      for (const viewport of [{ width: 1280, height: 800 }, { width: 320, height: 640 }]) {
        test(`has no axe violations and reflows (${scheme}, ${viewport.width}px)`, async ({ browser }) => {
          const context = await browser.newContext({ colorScheme: scheme, viewport });
          const page = await context.newPage();
          await page.goto(path);
          await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
          const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
          expect(violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
          expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
          await context.close();
        });
      }
    }
  });
}

test('an unknown path is the server\'s JSON 404, and the account routes do not exist', async ({ request }) => {
  for (const path of ['/sign-in', '/account', '/mcp/account', '/no-such-page']) {
    const response = await request.get(path);
    expect([path, response.status()]).toEqual([path, 404]);
  }
});
