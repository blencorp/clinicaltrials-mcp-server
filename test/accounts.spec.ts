import { describe, it, expect, beforeAll, afterAll, vi, onTestFinished } from 'vitest';
import { createServer, get as httpGet, type Server } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { testUtils } from 'better-auth/plugins';
import fetchCookie from 'fetch-cookie';
import { CookieJar } from 'tough-cookie';
import { MockAgent } from 'undici';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { randomToken, digest } from '../src/accounts/crypto.js';
import { Store } from '../src/accounts/store.js';
import { createAccountApp, allowedRedirect } from '../src/accounts/app.js';
import { accountDependencies, publicDependencies, AccountQuota } from '../src/accounts/runtime.js';
import { loadAccountConfig, type AccountConfig } from '../src/accounts/config.js';
import { buildSupervisor, type SupervisorConfig } from '../src/supervisor/index.js';
import { buildCatalog } from '../src/server/toolCatalog.js';
import { supervisorCfg, CTGOV_ORIGIN, API } from './helpers.js';

const ENV = {
  CTGOV_PUBLIC_ORIGIN: 'https://ctgov.example.com', BETTER_AUTH_SECRET: 'x'.repeat(32),
  DATABASE_URL: 'postgres://u:p@localhost/db', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret',
};

describe('account configuration', () => {
  it('needs only the origin, database, auth secret and Google credentials: no API key, no encryption keyring', () => {
    const config = loadAccountConfig(ENV);
    expect(config).toMatchObject({ origin: 'https://ctgov.example.com', production: true });
    expect(Object.keys(config)).not.toContain('keyring');
    for (const name of Object.keys(ENV)) {
      expect(() => loadAccountConfig({ ...ENV, [name]: undefined }), name).toThrow(`Missing configuration: ${name}`);
    }
  });
  it('rejects unsafe origins, short secrets, bad quotas and unsafe OAuth redirects', () => {
    for (const origin of ['http://ctgov.example.com', 'https://ctgov.example.com/path', 'https://user:pw@ctgov.example.com', 'http://localhost:3000'])
      expect(() => loadAccountConfig({ ...ENV, CTGOV_PUBLIC_ORIGIN: origin }), origin).toThrow('HTTPS origin');
    expect(loadAccountConfig({ ...ENV, NODE_ENV: 'development', CTGOV_PUBLIC_ORIGIN: 'http://127.0.0.1:3000' }).origin).toBe('http://127.0.0.1:3000');
    expect(() => loadAccountConfig({ ...ENV, BETTER_AUTH_SECRET: 'short' })).toThrow('at least 32');
    expect(() => loadAccountConfig({ ...ENV, CTGOV_SUBJECT_DAILY_QUOTA: '0' })).toThrow('positive integer');
    expect(() => loadAccountConfig({ ...ENV, CTGOV_CLIENT_IP_HEADER: 'bad header' })).toThrow('header name');
    expect(allowedRedirect('https://client.example/cb')).toBe(true);
    expect(allowedRedirect('http://127.0.0.1:9/cb')).toBe(true);
    for (const bad of ['http://evil.example/cb', 'https://u:p@client.example/cb', 'https://client.example/cb#x', 'java' + 'script:alert(1)', 5])
      expect(allowedRedirect(bad), String(bad)).toBe(false);
  });
});

describe('the anonymous catalog', () => {
  it('offers search_api and describe_schema only: execute is not registered, even though a sandbox exists', async () => {
    const deps = await buildSupervisor(supervisorCfg({ sandbox: 'auto', tools: 'all' }));
    const names = (d: typeof deps) => buildCatalog(d).map(t => t.name);
    expect(names(deps)).toEqual(['search_api', 'describe_schema', 'execute']);
    expect(names(publicDependencies(deps))).toEqual(['search_api', 'describe_schema']);
  });
});

describe('account quota', () => {
  it('counts per account in the store, keyed by the owner, and reports when the window ends', async () => {
    const calls: unknown[][] = [];
    const store = { consume: async (...a: unknown[]) => { calls.push(a); return { allowed: true, resetAt: 1 }; } } as unknown as Store;
    expect(await new AccountQuota(store, 7).consume('u1')).toEqual({ allowed: true, resetAt: 1 });
    expect(calls).toEqual([['ctgov:user:u1', 7, 3600]]);
  });
});

const database = process.env.TEST_DATABASE_URL;
describe.skipIf(!database)('account HTTP / OAuth with PostgreSQL', () => {
  let pool: Pool, store: Store, server: Server, config: AccountConfig, docsRoot: string;
  let service: Awaited<ReturnType<typeof createAccountApp>>;
  let helper: ReturnType<ReturnType<typeof testUtils>['init']>['context']['test'];
  let alice: any, bob: any, browser: typeof fetch, other: typeof fetch;
  const schema = `ctgov_test_${randomBytes(8).toString('hex')}`;
  let mock: MockAgent;
  // The quota is low enough to reach in a test; everything else is a production default.
  const HOURLY = 5;
  const cfg: SupervisorConfig = supervisorCfg({ sandbox: 'deno', processIsolation: true, tools: 'all' });
  const send = (client: typeof fetch, path: string, body: object, origin?: string) => client(`${config.origin}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: origin ?? config.origin }, body: JSON.stringify(body),
  });
  async function login(userId: string) {
    const logged = await helper.login({ userId });
    const jar = new CookieJar();
    for (const cookie of logged.cookies) await jar.setCookie(`${cookie.name}=${cookie.value}; Path=/`, config.origin);
    return fetchCookie(fetch, jar) as typeof fetch;
  }
  function signedQuery(url: string) {
    const params = new URL(url, config.origin).searchParams;
    const names = new Set(params.getAll('ba_param'));
    const out = new URLSearchParams();
    for (const [k, v] of params) if (k === 'sig' || k === 'ba_param' || names.has(k)) out.append(k, v);
    return out.toString();
  }
  async function register() {
    const response = await send(fetch, '/api/auth/oauth2/register', {
      client_name: 'Test assistant', redirect_uris: ['https://client.example/callback'],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
    });
    expect(response.status, await response.clone().text()).toBe(201);
    return await response.json() as any;
  }
  async function beginAuthorization(clientBrowser = browser) {
    const client = await register();
    const verifier = randomToken();
    const state = randomToken();
    const query = new URLSearchParams({
      client_id: client.client_id, redirect_uri: client.redirect_uris[0], response_type: 'code',
      scope: 'ctgov:read offline_access', resource: `${config.origin}/mcp/account`,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state,
    });
    let response = await clientBrowser(`${config.origin}/api/auth/oauth2/authorize?${query}`, {
      headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' },
    });
    if (response.headers.get('content-type')?.includes('application/json')) {
      const result = await response.json() as any;
      expect(result.redirect, JSON.stringify(result)).toBe(true);
      response = await clientBrowser(new URL(result.url, config.origin));
    }
    // Keyless: the sign-in lands straight on the consent step (there is no key step).
    expect(new URL(response.url).pathname).toBe('/consent');
    return { client, verifier, state, oauth_query: signedQuery(response.url) };
  }
  async function authorize(clientBrowser = browser, accept = true) {
    const { client, verifier, state, oauth_query } = await beginAuthorization(clientBrowser);
    const info = await clientBrowser(`${config.origin}/api/portal/consent?oauth_query=${encodeURIComponent(oauth_query)}`);
    expect(info.status).toBe(200);
    const consent = await send(clientBrowser, '/api/portal/consent', { oauth_query, accept });
    expect(consent.status, await consent.clone().text()).toBe(200);
    const callback = new URL((await consent.json() as any).url);
    expect(callback.origin).toBe('https://client.example');
    expect(callback.searchParams.get('state')).toBe(state);
    return { client, verifier, code: callback.searchParams.get('code'), callback };
  }
  const exchange = (clientId: string, body: Record<string, string>) => fetch(`${config.origin}/api/auth/oauth2/token`, {
    method: 'POST', body: new URLSearchParams({ client_id: clientId, ...body }),
  });
  async function token(clientBrowser = browser) {
    const a = await authorize(clientBrowser);
    const response = await exchange(a.client.client_id, { grant_type: 'authorization_code', code: a.code!, code_verifier: a.verifier, redirect_uri: a.client.redirect_uris[0] });
    expect(response.status, await response.clone().text()).toBe(200);
    return { ...await response.json() as any, clientId: a.client.client_id };
  }
  async function mcp(token: string | undefined, code = 'return 42;', path = '/mcp/account') {
    const response = await fetch(`${config.origin}${path}`, {
      method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'execute', 'Mcp-Protocol-Version': '2026-07-28' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'execute', arguments: { code }, _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'auth-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {},
      } } }),
    });
    return { status: response.status, body: await response.text() };
  }
  const version = () => mock.get(CTGOV_ORIGIN).intercept({ path: `${API}/version`, method: 'GET' })
    .reply(200, { apiVersion: '2.0.5', dataTimestamp: '2026-11-20T09:00:00' }, { headers: { 'content-type': 'application/json' } });
  const PROGRAM = 'return (await ctgov.version()).apiVersion;';
  beforeAll(async () => {
    const admin = new Pool({ connectionString: database });
    await admin.query(`CREATE SCHEMA ${schema}`); await admin.end();
    pool = new Pool({ connectionString: database, options: `-c search_path=${schema}` });
    store = new Store(pool);
    await store.initialize();
    // A minimal built docs site: /docs must be wired with its own CSP inside the account app.
    docsRoot = mkdtempSync(join(tmpdir(), 'ctgov-docs-'));
    writeFileSync(join(docsRoot, 'index.html'), '<html><script>window.docs=1</script><title>Docs</title></html>');
    server = createServer();
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    config = { origin: `http://127.0.0.1:${(server.address() as any).port}`, production: false,
      databaseUrl: database!, authSecret: randomToken(), googleClientId: 'fixture-google', googleClientSecret: 'fixture-secret',
      clientIpHeader: 'x-real-ip', docsRoot };
    // Upstream ClinicalTrials.gov calls go through an injected MockAgent, never the global dispatcher.
    mock = new MockAgent(); mock.disableNetConnect();
    const deps = await buildSupervisor({ ...cfg, dispatcher: mock });
    expect(await deps.sandbox?.available(), 'Deno is required for account integration tests').toBe(true);
    service = await createAccountApp(config, store, accountDependencies(deps, store, HOURLY), publicDependencies(deps));
    server.on('request', service.app);
    helper = testUtils().init((await service.auth.$context) as unknown as Parameters<ReturnType<typeof testUtils>['init']>[0]).context.test;
    alice = await helper.saveUser(helper.createUser({ email: 'alice@example.test', emailVerified: true }));
    bob = await helper.saveUser(helper.createUser({ email: 'bob@example.test', emailVerified: true }));
    browser = await login(alice.id); other = await login(bob.id);
  });
  afterAll(async () => {
    await mock?.close(); await service?.close();
    if (docsRoot) rmSync(docsRoot, { recursive: true, force: true });
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (pool) { await pool.query(`DROP SCHEMA ${schema} CASCADE`); await pool.end(); }
  });
  it('registers desktop clients with loopback HTTP redirects even without application_type', async () => {
    for (const uri of ['http://127.0.0.1:33418/callback', 'http://localhost:33418/callback', 'http://[::1]:33418/callback']) {
      const r = await send(fetch, '/api/auth/oauth2/register', {
        client_name: 'Desktop client', redirect_uris: [uri], token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      });
      expect(r.status, `${uri}: ${await r.clone().text()}`).toBe(201);
    }
    expect((await send(fetch, '/api/auth/oauth2/register', { redirect_uris: ['http://evil.example/cb'] })).status).toBe(400);
    expect((await send(fetch, '/api/auth/oauth2/authorize', { client_id: 'x', redirect_uri: 'http://evil.example/cb', response_type: 'code' })).status).toBe(400);
  });
  it('discovers OAuth with the ctgov:read scope, challenges anonymous callers, and offers Google sign-in', async () => {
    const metadata = await fetch(`${config.origin}/.well-known/oauth-protected-resource/mcp/account`);
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toMatchObject({ resource: `${config.origin}/mcp/account` });
    const challenge = await fetch(`${config.origin}/mcp/account`, { method: 'POST' });
    expect(challenge.status).toBe(401);
    expect(challenge.headers.get('www-authenticate')).toContain(`resource_metadata="${config.origin}/.well-known/oauth-protected-resource/mcp/account"`);
    expect(challenge.headers.get('www-authenticate')).toContain('scope="ctgov:read"');
    const discovery = await fetch(`${config.origin}/.well-known/oauth-authorization-server`);
    expect(await discovery.json()).toMatchObject({ authorization_endpoint: `${config.origin}/api/auth/oauth2/authorize`, scopes_supported: expect.arrayContaining(['ctgov:read']) });
    expect((await mcp('invalid')).status).toBe(401);
    const google = await send(fetch, '/api/auth/sign-in/social', { provider: 'google', callbackURL: '/account' });
    expect(google.status, await google.clone().text()).toBe(200);
    expect(new URL((await google.json() as any).url).hostname).toBe('accounts.google.com');
  });
  it('closes every Better Auth path the portal does not use: no email sign-in, no account linking or edits', async () => {
    for (const [method, path] of [
      ['POST', '/api/auth/sign-in/email'], ['POST', '/api/auth/sign-up/email'], ['POST', '/api/auth/link-social'],
      ['POST', '/api/auth/update-user'], ['POST', '/api/auth/change-email'], ['POST', '/api/auth/change-password'],
      ['POST', '/api/auth/forget-password'], ['POST', '/api/auth/reset-password'],
    ] as const) {
      for (const client of [fetch, browser]) {
        const r = await send(client, path, { email: 'a@example.test', password: 'x'.repeat(12), name: 'A', provider: 'google', callbackURL: '/' });
        // The paths Better Auth is told to disable are 404; the email routes answer 400 ("not enabled").
        const closed = ['/api/auth/link-social', '/api/auth/update-user', '/api/auth/change-email'].includes(path);
        expect(closed ? [404] : [400, 404], `${method} ${path}`).toContain(r.status);
        expect(r.status).toBeLessThan(500);
        await r.arrayBuffer();
      }
    }
    // What the portal does use stays open.
    expect((await browser(`${config.origin}/api/auth/get-session`)).status).toBe(200);
  });
  // Needs the Vite bundle: `pnpm build` (CI builds before testing). Skipped, not failed, without it.
  const webBuilt = existsSync(new URL('../dist/web/index.html', import.meta.url));
  const navigate = (path: string, headers: Record<string, string> = {}) => {
    const { port, host } = new URL(config.origin);
    return new Promise<{ status?: number; type?: string; csp?: string | string[]; body: string }>((resolve, reject) =>
      httpGet({ host: '127.0.0.1', port, path, headers: { host, 'sec-fetch-mode': 'navigate', accept: 'text/html', ...headers } }, (res) => {
        let body = '';
        res.setEncoding('utf8').on('data', (chunk: string) => (body += chunk)).on('end', () =>
          resolve({ status: res.statusCode, type: res.headers['content-type'], csp: res.headers['content-security-policy'], body }));
      }).on('error', reject));
  };
  it.skipIf(!webBuilt)('serves the portal and policies with same-origin assets and a script-restricting CSP (needs pnpm build)', async () => {
    for (const path of ['/', '/sign-in', '/account', '/consent', '/privacy-policy', '/terms', '/error']) {
      const page = await fetch(`${config.origin}${path}`);
      expect(page.status, path).toBe(200);
      expect(page.headers.get('content-security-policy')).toBe(
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
      expect(page.headers.get('x-frame-options')).toBe('DENY');
      const html = await page.text();
      const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(match => match[1]);
      expect(assets.length).toBeGreaterThanOrEqual(2);
      for (const asset of assets) {
        const response = await fetch(`${config.origin}${asset}`);
        expect(response.status).toBe(200);
        await response.arrayBuffer();
      }
    }
    expect(await (await fetch(`${config.origin}/api/portal/config`)).json()).toMatchObject({ google: true, email: false });
  });
  it.skipIf(!webBuilt)('answers browser navigations with the portal pages for 404 and 429, and API clients with short text (needs pnpm build)', async () => {
    // 404: the portal's not-found page; the removed /connect step is gone, not a portal route.
    for (const path of ['/no-such-page', '/connect']) {
      const page = await navigate(path);
      expect(page.status, path).toBe(404);
      expect(page.type).toContain('text/html');
      expect(page.body).toContain('/assets/');
    }
    const api = await fetch(`${config.origin}/no-such-page`, { headers: { accept: 'application/json' } });
    expect(api.status).toBe(404);
    expect(await api.text()).toBe('Not found');
    // 429: a small standalone page for a browser, text for an API client. (Portal pages and assets
    // sit before the per-IP limiter; the portal API is behind it.)
    const ip = '203.0.113.200';
    for (let i = 0; i < 600; i++) await store.allow(`http:${ip}`, 600, 60);
    const limited = await navigate('/api/portal/account', { 'x-real-ip': ip });
    expect(limited.status).toBe(429);
    expect(limited.type).toContain('text/html');
    expect(limited.body).toContain('Too many requests');
    expect(limited.body).toContain('ClinicalTrials.gov MCP');
    const limitedApi = await fetch(`${config.origin}/api/portal/account`, { headers: { 'x-real-ip': ip } });
    expect(limitedApi.status).toBe(429);
    expect(await limitedApi.text()).toBe('Too many requests');
    // 500 is covered below, which needs no web build.
  });
  it('answers a browser navigation that fails with an explicit error document, whatever the URL', async () => {
    // The portal's index.html routes by the unchanged URL, so serving it for a failure under
    // /api/auth/* (or any non-portal path) would render "Page not found". Nothing of the failure
    // is echoed.
    const failures: [string, () => { mockRestore(): void }, Record<string, string>][] = [
      ['/api/portal/account', () => vi.spyOn(store, 'allow').mockRejectedValueOnce(new Error('connection refused db.internal')), { 'x-real-ip': '203.0.113.201' }],
      ['/mcp/account', () => vi.spyOn(store, 'allow').mockRejectedValueOnce(new Error('connection refused db.internal')), { authorization: 'Bearer x', 'x-real-ip': '203.0.113.203' }],
      ['/api/auth/get-session', () => vi.spyOn(service.auth, 'handler').mockRejectedValueOnce(new Error('connection refused db.internal')), { 'x-real-ip': '203.0.113.204' }],
    ];
    for (const [path, fail, headers] of failures) {
      const spy = fail();
      const broken = await navigate(path, headers);
      spy.mockRestore();
      expect(broken.status, path).toBe(500);
      expect(broken.type, path).toContain('text/html');
      expect(broken.body, path).toContain('<h1>Something went wrong</h1>');
      expect(broken.body, path).not.toContain('/assets/');
      expect(broken.body, path).not.toContain('db.internal');
      expect(broken.csp, path).toContain("default-src 'none'");
    }
    // An API client keeps the JSON answer.
    const spy = vi.spyOn(store, 'allow').mockRejectedValueOnce(new Error('connection refused db.internal'));
    const brokenApi = await fetch(`${config.origin}/mcp/account`, { headers: { authorization: 'Bearer x', 'x-real-ip': '203.0.113.202' } });
    spy.mockRestore();
    expect(brokenApi.status).toBe(500);
    expect(brokenApi.headers.get('content-type')).toContain('application/json');
    expect(await brokenApi.text()).not.toContain('db.internal');
  });
  // The policy URLs are registered as the connector's privacy policy, so their text must be in the
  // HTML itself (web/prerender.ts), not only rendered by the script. node:http: no JavaScript runs.
  it.skipIf(!webBuilt)('serves the policy pages with their text in the HTML, without running JavaScript (needs pnpm build)', async () => {
    const plain = (html: string) => {
      // Strip tags until none are left: one pass can leave a tag assembled from the pieces around a removed one.
      let text = html;
      for (let prev = ''; prev !== text; ) { prev = text; text = text.replace(/<[^>]*>/g, ''); }
      return text.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
    };
    for (const { path, title, source } of [
      { path: '/privacy-policy', title: 'Privacy policy', source: 'privacy-policy.md' },
      { path: '/terms', title: 'Terms of service', source: 'terms.md' },
    ]) {
      const headings = [...readFileSync(new URL(`../legal/${source}`, import.meta.url), 'utf8').matchAll(/^## (.+)$/gm)].map((m) => m[1]!);
      expect(headings.length).toBeGreaterThan(3);
      for (const url of [path, `${path}/`]) {
        const page = await navigate(url, { 'sec-fetch-mode': 'cors' });
        expect(page.status, url).toBe(200);
        expect(page.csp).toContain("script-src 'self'");
        expect(page.body).toMatch(new RegExp(`<title>${title} · `));
        expect(page.body).toMatch(new RegExp(`<h1[^>]*>${title}</h1>`));
        expect(page.body).toContain('<main id="main"');
        const text = plain(page.body);
        for (const heading of headings) expect(text, heading).toContain(heading);
        expect(page.body).toContain('<script type="module"');
        expect(page.body).not.toMatch(/<script(?![^>]*\bsrc=)/);
      }
    }
    // The privacy policy describes this mode: Google identity and hashed tokens, and no API keys.
    const text = plain((await navigate('/privacy-policy')).body);
    expect(text).toMatch(/Google account identity/);
    expect(text).toMatch(/hashed/);
    expect(text).toMatch(/no API keys/i);
  });
  it('refuses a host the account origin does not name, except /health', async () => {
    const { port } = new URL(config.origin);
    const status = (path: string) => new Promise<number | undefined>((resolve, reject) =>
      httpGet({ host: '127.0.0.1', port, path, headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    expect(await status('/')).toBe(421);
    expect(await status('/mcp')).toBe(421);
    expect(await status('/health')).toBe(200);
    expect(await (await fetch(`${config.origin}/health`)).json()).toMatchObject({ status: 'ok', protocol: '2026-07-28', sandbox: 'deno' });
  });
  it('serves the documentation site at /docs with its own CSP, behind the Host check', async () => {
    const moved = await fetch(`${config.origin}/docs?q=1`, { redirect: 'manual' });
    expect(moved.status).toBe(301);
    expect(moved.headers.get('location')).toBe('/docs/?q=1');
    const page = await fetch(`${config.origin}/docs/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>Docs</title>');
    // The docs policy replaces the portal's, and allows the inline script only by its hash.
    expect(page.headers.get('content-security-policy')).toContain(`'sha256-${createHash('sha256').update('window.docs=1').digest('base64')}'`);
    expect(page.headers.get('cache-control')).toBe('public, max-age=300');
    // fetch cannot set Host (a forbidden header), so the rebinding check goes through node:http.
    const { port } = new URL(config.origin);
    const status = await new Promise<number | undefined>((resolve, reject) =>
      httpGet({ host: '127.0.0.1', port, path: '/docs/', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    expect(status).toBe(421);
  });
  // OAuth 2.0 lets a client with one registered URI omit redirect_uri. Better Auth refuses that, so
  // a signed Consent query always names one; the portal still answers 400, not 500, without it.
  it('refuses an authorization request without redirect_uri before the Consent page', async () => {
    const client = await register();
    const query = new URLSearchParams({
      client_id: client.client_id, response_type: 'code', scope: 'ctgov:read', resource: `${config.origin}/mcp/account`,
      code_challenge: createHash('sha256').update(randomToken()).digest('base64url'), code_challenge_method: 'S256', state: randomToken(),
    });
    let response = await browser(`${config.origin}/api/auth/oauth2/authorize?${query}`, { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' } });
    if (response.headers.get('content-type')?.includes('application/json')) response = await browser(new URL((await response.json() as any).url, config.origin));
    expect(new URL(response.url).pathname).not.toBe('/consent');
    await response.arrayBuffer();
  });
  it('goes straight from sign-in to consent, and the portal API takes no key or credential field', async () => {
    const { oauth_query } = await beginAuthorization();
    // The consent info lists no key state; there is no key route at all.
    const info = await (await browser(`${config.origin}/api/portal/consent?oauth_query=${encodeURIComponent(oauth_query)}`)).json() as any;
    expect(info).toMatchObject({ client: 'Test assistant', destination: 'client.example', email: 'alice@example.test' });
    expect(Object.keys(info).sort()).toEqual(['client', 'destination', 'email', 'local']);
    for (const path of ['/api/portal/keys', '/api/portal/keys/delete', '/api/portal/connect', '/api/portal/claude']) {
      const r = await send(browser, path, { apiKey: 'a'.repeat(32) });
      expect(r.status, path).toBe(404);
      await r.arrayBuffer();
    }
    expect(await (await browser(`${config.origin}/api/portal/account`)).json()).toEqual({ email: 'alice@example.test', mcpUrl: `${config.origin}/mcp/account` });
    // Other accounts' data and unauthenticated callers are not served.
    expect((await fetch(`${config.origin}/api/portal/account`)).status).toBe(401);
  });
  it('keys per-IP limits on the trusted client header, not the proxy address', async () => {
    const bucket = async (key: string) => (await pool.query('SELECT count FROM request_limits WHERE bucket=$1', [digest(key)])).rows[0]?.count;
    for (const ip of ['203.0.113.5', '203.0.113.5', '198.51.100.7'])
      expect((await fetch(`${config.origin}/mcp/account`, { method: 'POST', headers: { authorization: 'Bearer nope', 'x-real-ip': ip } })).status).toBe(401);
    expect(await bucket('mcp-ip:203.0.113.5')).toBe(2);
    expect(await bucket('mcp-ip:198.51.100.7')).toBe(1);
  });
  it('limits failed token checks per IP before they reach the database', async () => {
    const bucket = async (key: string) => (await pool.query('SELECT count FROM request_limits WHERE bucket=$1', [digest(key)])).rows[0]?.count;
    const post = (ip: string) => fetch(`${config.origin}/mcp/account`, { method: 'POST', headers: { authorization: 'Bearer made-up', 'x-real-ip': ip } });
    const statuses = await Promise.all(Array.from({ length: 125 }, () => post('192.0.2.44').then(r => r.status)));
    expect(statuses.filter(s => s === 401).length).toBeGreaterThanOrEqual(120);
    expect(statuses.filter(s => s === 429).length).toBeGreaterThan(0);
    const counted = await bucket('mcp-ip:192.0.2.44');
    const more = await Promise.all(Array.from({ length: 10 }, () => post('192.0.2.44').then(r => r.status)));
    expect(await bucket('mcp-ip:192.0.2.44')).toBe(counted + more.filter(s => s === 401).length);
    expect((await post('192.0.2.45')).status).toBe(401);
  });
  it('serves only search_api and describe_schema at /mcp without sign-in: no execute, and no upstream call', async () => {
    const listTools = async (token?: string) => {
      const r = await fetch(`${config.origin}/mcp`, {
        method: 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'Mcp-Method': 'tools/list', 'Mcp-Protocol-Version': '2026-07-28' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'auth-test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {},
        } } }),
      });
      return { status: r.status, body: await r.text() };
    };
    const listed = await listTools();
    expect(listed.status).toBe(200);
    const names = (JSON.parse(listed.body).result.tools as { name: string }[]).map(t => t.name);
    expect(names).toEqual(['search_api', 'describe_schema']);
    // A bearer token is not required, and one sent here is ignored rather than checked.
    expect((await listTools('not-a-token')).status).toBe(200);
    // A direct execute call is refused even though tools/list never offered it.
    const direct = await mcp(undefined, 'return 42;', '/mcp');
    expect(direct.body).toMatch(/not found|Unknown tool/i);
    expect(direct.body).not.toContain('"value":42');
    // MCP's Origin rule: other sites' browsers are refused; the server's own origin passes.
    expect((await fetch(`${config.origin}/mcp`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    expect((await fetch(`${config.origin}/mcp`, { method: 'POST', headers: { origin: config.origin, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' })).status).not.toBe(403);
    expect(await (await fetch(`${config.origin}/api/portal/config`)).json()).toMatchObject({
      mcpUrl: `${config.origin}/mcp/account`, publicMcpUrl: `${config.origin}/mcp`,
    });
  });
  it('signs out mid-connection the way the Sign out button does, ending that session only', async () => {
    const session = await login(alice.id);
    const { oauth_query } = await beginAuthorization(session);
    const consent = `${config.origin}/api/portal/consent?oauth_query=${encodeURIComponent(oauth_query)}`;
    expect((await session(consent)).status).toBe(200);
    // The button posts '{}' to Better Auth directly, without the page's signed query.
    expect((await send(session, '/api/auth/sign-out', {})).status).toBe(200);
    expect((await session(consent)).status).toBe(401);
    expect((await browser(`${config.origin}/api/portal/account`)).status).toBe(200);
  });
  it('enforces consent denial, signed queries, and PKCE', async () => {
    expect((await send(browser, '/api/portal/consent', { oauth_query: 'client_id=attacker', accept: true })).status).toBe(400);
    const denied = await authorize(browser, false);
    expect(denied.code).toBeNull(); expect(denied.callback.searchParams.get('error')).toBe('access_denied');
    const a = await authorize();
    expect((await exchange(a.client.client_id, { grant_type: 'authorization_code', code: a.code!, code_verifier: randomToken(), redirect_uri: a.client.redirect_uris[0] })).status).toBe(400);
  });
  it('runs execute only for a signed-in account, in Deno, and keeps each token with its owner', async () => {
    // Anonymous: no token, no execution.
    expect((await mcp(undefined)).status).toBe(401);
    const a = await token(), b = await token(other);
    version().times(2);
    const [ra, rb] = await Promise.all([mcp(a.access_token, PROGRAM), mcp(b.access_token, PROGRAM)]);
    for (const r of [ra, rb]) { expect(r.status).toBe(200); expect(r.body).toContain('2.0.5'); }
  });
  const freshAccount = async (name: string) => {
    const user = await helper.saveUser(helper.createUser({ email: `${name}-${randomBytes(4).toString('hex')}@example.test`, emailVerified: true }));
    return { ...await token(await login(user.id)), userId: user.id as string };
  };
  const studyReply = { statusCode: 200, data: { protocolSection: { identificationModule: { nctId: 'NCT00000001' } } }, responseOptions: { headers: { 'content-type': 'application/json' } } };
  it('applies hourly per-account limits in PostgreSQL, separately per account', async () => {
    const first = await freshAccount('quota-a'), second = await freshAccount('quota-b');
    mock.get(CTGOV_ORIGIN).intercept({ path: `${API}/version`, method: 'GET' }).reply(200, { apiVersion: '2.0.5' }, { headers: { 'content-type': 'application/json' } }).times(2 * HOURLY);
    const many = (n: number) => `const out = []; for (let i = 0; i < ${n}; i++) { try { out.push((await ctgov.version()).apiVersion); } catch (e) { out.push(e.name); } } return out;`;
    const run = async (t: { access_token: string }, n: number) => JSON.parse((await mcp(t.access_token, many(n))).body).result.structuredContent.value as string[];
    // Exhaust the first account: its full allowance, then refusals.
    const used = await run(first, HOURLY + 2);
    expect(used.filter(v => v === '2.0.5')).toHaveLength(HOURLY);
    expect(used.filter(v => v === 'SubjectQuotaExceeded')).toHaveLength(2);
    // The second account is untouched: its whole allowance succeeds (no refusal is acceptable
    // before it), and only then does its own limit apply.
    const other = await run(second, HOURLY + 1);
    expect(other.slice(0, HOURLY)).toEqual(Array(HOURLY).fill('2.0.5'));
    expect(other[HOURLY]).toBe('SubjectQuotaExceeded');
    // The first account stays exhausted; the counter is in the database, keyed by the hashed owner.
    expect(await run(first, 1)).toEqual(['SubjectQuotaExceeded']);
    const count = async (userId: string) => (await pool.query('SELECT count FROM request_limits WHERE bucket=$1', [digest(`ctgov:user:${userId}`)])).rows[0].count;
    expect(await count(first.userId)).toBeGreaterThan(HOURLY);
    expect(await count(second.userId)).toBeGreaterThan(HOURLY);
  });
  it('limits simultaneous executions per account with Busy, not a queue, independent of other accounts', async () => {
    const a = await freshAccount('busy-a'), b = await freshAccount('busy-b');
    // Upstream replies are held until released, so executions overlap by construction (the Deno
    // sandbox has no timers to hold them with).
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let entered = 0;
    mock.get(CTGOV_ORIGIN).intercept({ path: p => p.startsWith(`${API}/studies/NCT`), method: 'GET' }).reply(async () => { entered++; await gate; return studyReply; }).times(5);
    const reached = (n: number) => vi.waitFor(() => expect(entered).toBeGreaterThanOrEqual(n), { timeout: 15_000, interval: 25 });
    // Distinct studies, so nothing coalesces the held upstream requests into one.
    let n = 0;
    const call = (t: { access_token: string }) => mcp(t.access_token, `await ctgov.studies.get('NCT0000000${++n}'); return 'done';`);
    const base = entered;
    const held = [call(a), call(a)];
    // A failing assertion must not leave the held executions waiting on the barrier.
    onTestFinished(release);
    await reached(base + 2);
    // The per-account limit is 2: a third simultaneous execution is refused at once, not queued.
    const refused = await call(a);
    expect(refused.body).toContain('Busy');
    expect(entered).toBe(base + 2);
    // Another account is not affected by a's occupied slots.
    const independent = call(b);
    await reached(base + 3);
    release();
    for (const r of await Promise.all([...held, independent])) expect(r.body).toContain('done');
    // Slots recover once the executions finish.
    await vi.waitFor(async () => {
      const again = await Promise.all([call(a), call(a)]);
      for (const r of again) { expect(r.body).not.toContain('Busy'); expect(r.body).toContain('done'); }
    }, { timeout: 15_000, interval: 100 });
  });
  it('supports the official MCP client and rejects expired, wrong-resource, under-scoped and disabled-client tokens', async () => {
    const a = await token();
    const client = new Client({ name: 'official-auth-test', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${config.origin}/mcp/account`), {
      requestInit: { headers: { Authorization: `Bearer ${a.access_token}` } },
    }));
    expect((await client.listTools()).tools.map(t => t.name)).toEqual(['search_api', 'describe_schema', 'execute']);
    await client.close();
    const adapter = (await service.auth.$context).adapter;
    const where = [{ field: 'token', value: digest(a.access_token) }];
    const row = await adapter.findOne<any>({ model: 'oauthAccessToken', where });
    for (const [update, status] of [
      [{ expiresAt: new Date(0) }, 401],
      [{ resources: ['https://other.example/mcp'] }, 401],
      [{ scopes: ['offline_access'] }, 403],
    ] as const) {
      await adapter.update({ model: 'oauthAccessToken', where, update });
      expect((await mcp(a.access_token)).status).toBe(status);
      await adapter.update({ model: 'oauthAccessToken', where, update: { expiresAt: row.expiresAt, resources: row.resources, scopes: row.scopes } });
    }
    await adapter.update({ model: 'oauthClient', where: [{ field: 'clientId', value: a.clientId }], update: { disabled: true } });
    expect((await mcp(a.access_token)).status).toBe(401);
    const stored = await pool.query('SELECT token FROM "oauthAccessToken"');
    expect(JSON.stringify(stored.rows)).not.toContain(a.access_token);
  });
  it('rejects unverified accounts, foreign browser origins, oversized bodies and unsafe client redirects; serves hosted connectors', async () => {
    const unverified = await helper.saveUser(helper.createUser({ email: 'unverified@example.test', emailVerified: false }));
    const unverifiedBrowser = await login(unverified.id);
    expect((await unverifiedBrowser(`${config.origin}/api/portal/account`)).status).toBe(401);
    const cross = await fetch(`${config.origin}/api/portal/account`, { headers: { origin: 'https://evil.example' } });
    expect(cross.status).toBe(403);
    expect((await send(browser, '/api/portal/consent', { oauth_query: 'x'.repeat(9000), accept: true })).status).toBe(413);
    expect((await send(fetch, '/api/auth/oauth2/register', { redirect_uris: ['http://evil.example/cb'] })).status).toBe(400);
    const a = await token();
    // Hosted connectors send their own Origin on the signed-in endpoint; with a valid bearer token
    // (never a cookie) and the Host check in place, they must be served.
    for (const origin of ['https://claude.ai', 'https://chatgpt.com']) {
      const hosted = await fetch(`${config.origin}/mcp/account`, {
        method: 'POST',
        headers: { authorization: `Bearer ${a.access_token}`, origin, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      expect(hosted.status, origin).toBe(200);
      expect(hosted.headers.get('access-control-allow-origin')).toBe('*');
    }
    // The anonymous endpoint has no token to check, so those sites' pages are refused there.
    for (const origin of ['https://claude.ai', 'https://chatgpt.com', 'https://evil.example'])
      expect((await fetch(`${config.origin}/mcp`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).status, origin).toBe(403);
    await (await service.auth.$context).adapter.update({ model: 'user', where: [{ field: 'id', value: alice.id }], update: { emailVerified: false } });
    expect((await mcp(a.access_token)).status).toBe(401);
    await (await service.auth.$context).adapter.update({ model: 'user', where: [{ field: 'id', value: alice.id }], update: { emailVerified: true } });
  });
  it('rotates refresh tokens and honors access token revocation', async () => {
    const a = await token();
    const response = await exchange(a.clientId, { grant_type: 'refresh_token', refresh_token: a.refresh_token });
    expect(response.status, await response.clone().text()).toBe(200);
    const refreshed = await response.json() as any;
    expect(refreshed.refresh_token).not.toBe(a.refresh_token);
    expect((await mcp(refreshed.access_token)).status).toBe(200);
    const revoke = await fetch(`${config.origin}/api/auth/oauth2/revoke`, { method: 'POST', body: new URLSearchParams({ client_id: a.clientId, token: refreshed.access_token, token_type_hint: 'access_token' }) });
    expect(revoke.status).toBe(200); expect((await mcp(refreshed.access_token)).status).toBe(401);
    expect((await exchange(a.clientId, { grant_type: 'refresh_token', refresh_token: a.refresh_token })).status).toBe(400);
  });
});
