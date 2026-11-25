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
import { createAccountApp, allowedRedirect, lockTarget } from '../src/accounts/app.js';
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

describe('AUTH_LOCK_POOL_SIZE', () => {
  it('is optional, an integer from 2 to 200', () => {
    expect(loadAccountConfig(ENV).authLockPoolSize).toBeUndefined();
    expect(loadAccountConfig({ ...ENV, AUTH_LOCK_POOL_SIZE: '25' }).authLockPoolSize).toBe(25);
    for (const bad of ['0', '1', '201', 'many', '2.5'])
      expect(() => loadAccountConfig({ ...ENV, AUTH_LOCK_POOL_SIZE: bad }), bad).toThrow('AUTH_LOCK_POOL_SIZE');
  });
});

describe('token and revoke locks follow the operation Better Auth will run', () => {
  const form = 'application/x-www-form-urlencoded';
  const target = (path: string, fields: string, type: string | undefined = form) => lockTarget(path, type, Buffer.from(fields));
  it('revoke acts on token, refresh on refresh_token, a code exchange on code; other fields never choose', () => {
    expect(target('/oauth2/revoke', 'token=R&refresh_token=junk')).toEqual({ token: 'R' });
    expect(target('/oauth2/revoke', 'token=R&code=C')).toEqual({ token: 'R' });
    expect(target('/oauth2/revoke', 'refresh_token=R')).toBeUndefined();
    expect(target('/oauth2/token', 'grant_type=refresh_token&refresh_token=R&token=x')).toEqual({ token: 'R' });
    expect(target('/oauth2/token', 'grant_type=authorization_code&code=C&refresh_token=junk&token=x')).toEqual({ code: 'C' });
  });
  it('parses as Better Auth does: form only, BOM stripped, grant_type trimmed, scheme stripped from a revoked token', () => {
    expect(target('/oauth2/token', '{}&grant_type=refresh_token&refresh_token=R')).toEqual({ token: 'R' });
    expect(target('/oauth2/token', '\uFEFFgrant_type=refresh_token&refresh_token=R')).toEqual({ token: 'R' });
    expect(target('/oauth2/token', 'grant_type=refresh_token&refresh_token=R', `${form}; charset=utf-8`)).toEqual({ token: 'R' });
    expect(target('/oauth2/token', 'grant_type=+refresh_token+&refresh_token=R')).toEqual({ token: 'R' });
    expect(target('/oauth2/token', 'grant_type=%09authorization_code%0A&code=C')).toEqual({ code: 'C' });
    expect(target('/oauth2/revoke', 'token=Bearer+R')).toEqual({ token: 'R' });
    expect(target('/oauth2/revoke', 'token=bearer++R')).toEqual({ token: 'R' });
  });
  it('treats a repeated deciding field as ambiguous, and a repeated unrelated one as harmless', () => {
    expect(target('/oauth2/revoke', 'token=A&token=B')).toEqual({ ambiguous: true });
    expect(target('/oauth2/token', 'grant_type=refresh_token&refresh_token=A&refresh_token=B')).toEqual({ ambiguous: true });
    expect(target('/oauth2/token', 'grant_type=a&grant_type=refresh_token&refresh_token=A')).toEqual({ ambiguous: true });
    expect(target('/oauth2/token', 'grant_type=refresh_token&refresh_token=A&scope=a&scope=b')).toEqual({ token: 'A' });
  });
  it('takes no lock when there is nothing to lock: client_credentials, missing fields, other media types', () => {
    expect(target('/oauth2/token', 'grant_type=client_credentials&client_id=x')).toBeUndefined();
    expect(target('/oauth2/token', 'grant_type=authorization_code')).toBeUndefined();
    expect(target('/oauth2/token', 'grant_type=refresh_token')).toBeUndefined();
    expect(target('/oauth2/token', '')).toBeUndefined();
    expect(target('/oauth2/token', '{"grant_type":"refresh_token","refresh_token":"R"}', 'application/json')).toBeUndefined();
    expect(lockTarget('/oauth2/token', undefined, Buffer.from('grant_type=refresh_token&refresh_token=R'))).toBeUndefined();
    expect(lockTarget('/oauth2/token', form, undefined)).toBeUndefined();
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
  let supervisorDeps: Awaited<ReturnType<typeof buildSupervisor>>, pool: Pool, store: Store, server: Server, config: AccountConfig, docsRoot: string;
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
    const deps = supervisorDeps = await buildSupervisor({ ...cfg, dispatcher: mock });
    expect(await deps.sandbox?.available(), 'Deno is required for account integration tests').toBe(true);
    service = await createAccountApp(config, store, accountDependencies(deps, store, HOURLY), publicDependencies(deps), { lockWaitMs: 2000 });
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
  const mcpAs = (ip: string, bearer: string) => fetch(`${config.origin}/mcp/account`, { method: 'POST', headers: { authorization: `Bearer ${bearer}`, 'x-real-ip': ip } });
  it('limits failed token checks per IP before they reach the database', async () => {
    const bucket = async (key: string) => (await pool.query('SELECT count FROM request_limits WHERE bucket=$1', [digest(key)])).rows[0]?.count;
    const context = await service.auth.$context;
    const original = context.adapter.findOne;
    let lookups = 0;
    context.adapter.findOne = ((...args: Parameters<typeof original>) => { lookups++; return original(...args); }) as typeof original;
    onTestFinished(() => { context.adapter.findOne = original; });
    let accepted = 0;
    while ((await mcpAs('192.0.2.44', `made-up-${accepted}`)).status === 401 && accepted < 400) accepted++;
    expect(accepted).toBeGreaterThanOrEqual(100);
    expect(accepted).toBeLessThan(200);
    // Past the limit a made-up token costs no database round trip and no store write.
    const counted = await bucket('mcp-ip:192.0.2.44'), before = lookups;
    for (let i = 0; i < 10; i++) expect((await mcpAs('192.0.2.44', `more-${i}`)).status).toBe(429);
    expect(lookups).toBe(before);
    expect(await bucket('mcp-ip:192.0.2.44')).toBe(counted);
    expect((await mcpAs('192.0.2.45', 'made-up')).status).toBe(401);
  });
  it('spends the failure budget only on tokens proven invalid: valid tokens, and database errors, cost nothing', async () => {
    const valid = (await freshAccount('budget')).access_token;
    // Valid tokens from one shared IP are never throttled by the failure budget, even all at once.
    const statuses = await Promise.all(Array.from({ length: 45 }, () => mcpAs('192.0.2.120', valid).then(r => r.status)));
    expect(statuses).not.toContain(401);
    expect((await mcpAs('192.0.2.120', 'made-up')).status).toBe(401);
    // Mixed in with 30 valid requests, 100 forged ones leave about 20 of the 120 failures.
    for (let i = 0; i < 100; i++) expect((await mcpAs('192.0.2.121', `forged-${i}`)).status).toBe(401);
    for (let i = 0; i < 30; i++) await mcpAs('192.0.2.121', valid);
    let more = 0;
    while ((await mcpAs('192.0.2.121', `forged-more-${more}`)).status === 401 && more < 200) more++;
    expect(more).toBeGreaterThanOrEqual(15); expect(more).toBeLessThan(40);
    // A database error is not a failed token.
    const context = await service.auth.$context;
    const original = context.adapter.findOne;
    context.adapter.findOne = (async () => { throw new Error('database down'); }) as typeof original;
    try { for (let i = 0; i < 150; i++) expect((await mcpAs('192.0.2.122', `err-${i}`)).status).toBe(500); }
    finally { context.adapter.findOne = original; }
    expect((await mcpAs('192.0.2.122', 'after-errors')).status).toBe(401);
  });
  it('bounds token checks in flight per address, so concurrency cannot dodge the failure budget', async () => {
    const replica = await createAccountApp(config, store, accountDependencies(supervisorDeps, store, HOURLY), publicDependencies(supervisorDeps), { maxTokenChecksInFlight: 8 });
    server.removeListener('request', service.app); server.on('request', replica.app);
    onTestFinished(async () => { server.removeListener('request', replica.app); server.on('request', service.app); await replica.close(); });
    const context = await replica.auth.$context;
    const original = context.adapter.findOne;
    let release!: () => void;
    const gate = new Promise<void>(resolve => (release = resolve));
    let lookups = 0;
    context.adapter.findOne = (async (...args: Parameters<typeof original>) => { lookups++; await gate; return original(...args); }) as typeof original;
    onTestFinished(() => { release(); context.adapter.findOne = original; });
    const held = Array.from({ length: 8 }, (_, i) => mcpAs('192.0.2.150', `held-${i}`).then(r => r.status));
    await vi.waitFor(() => expect(lookups).toBe(8), { timeout: 15_000, interval: 25 });
    expect((await mcpAs('192.0.2.150', 'extra')).status, 'the ninth check is refused at once').toBe(429);
    expect(lookups).toBe(8);
    // Another address is not affected by this one's backlog.
    const other = mcpAs('192.0.2.151', 'other').then(r => r.status);
    await vi.waitFor(() => expect(lookups).toBe(9), { timeout: 15_000, interval: 25 });
    release();
    expect(await Promise.all(held)).toEqual(Array(8).fill(401));
    expect(await other).toBe(401);
    // The slots come back once the checks finish.
    expect((await mcpAs('192.0.2.150', 'after')).status).toBe(401);
  });
  it('counts one IPv6 /64 as one client in every limiter, and an IPv4-mapped address as its IPv4 client', async () => {
    let limited = false;
    for (let i = 0; i < 300 && !limited; i++) limited = (await mcpAs(`2001:db8:9:9::${i + 1}`, `forged-${i}`)).status === 429;
    expect(limited, 'the /64 shares one failure budget').toBe(true);
    expect((await mcpAs('2001:db8:9:9:aaaa::1', 'again')).status).toBe(429);
    expect((await mcpAs('2001:db8:9:a::1', 'again')).status).toBe(401);
    const bucket = async (key: string) => (await pool.query('SELECT count FROM request_limits WHERE bucket=$1', [digest(key)])).rows[0]?.count;
    expect(await bucket('mcp-ip:2001:db8:9:9::/64')).toBeGreaterThan(0);
    expect(await bucket('mcp-ip:2001:db8:9:9::1')).toBeUndefined();
    expect((await mcpAs('::ffff:192.0.2.160', 'x')).status).toBe(401);
    expect(await bucket('mcp-ip:192.0.2.160')).toBe(1);
  });
  /** Wraps the Better Auth handler for the rest of the test, counting token and revoke requests it runs. */
  function watchHandler(wrap?: (original: typeof service.auth.handler) => typeof service.auth.handler) {
    const original = service.auth.handler;
    const seen = { entered: 0 };
    const counting = (request: Request) => { if (/\/oauth2\/(token|revoke)$/.test(new URL(request.url).pathname)) seen.entered++; return original(request); };
    service.auth.handler = wrap ? wrap(counting as typeof original) : counting as typeof original;
    onTestFinished(() => { service.auth.handler = original; });
    return seen;
  }
  const rawPost = (path: string, body: string, headers: Record<string, string> = {}) => fetch(`${config.origin}/api/auth/oauth2/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body,
  });
  const lockId = (key: string) => BigInt.asIntN(64, BigInt(`0x${digest(key).slice(0, 16)}`)).toString();
  /** Holds one advisory lock in an open transaction until `done()`. */
  async function holdLock(key: string) {
    const hold = await pool.connect();
    await hold.query('BEGIN'); await hold.query('SELECT pg_advisory_xact_lock($1)', [lockId(key)]);
    let released = false;
    const done = async () => { if (released) return; released = true; await hold.query('ROLLBACK'); hold.release(); };
    onTestFinished(done);
    return done;
  }
  it('padded grants and scheme-prefixed revoke tokens wait on the same lock as the plain forms, and only that lock', async () => {
    const refreshAccount = await freshAccount('lock-padded'), revokeAccount = await freshAccount('lock-bearer');
    const flow = await authorize();
    const padded = new URLSearchParams({ client_id: refreshAccount.clientId, grant_type: ' refresh_token ', refresh_token: refreshAccount.refresh_token }).toString();
    const bearer = new URLSearchParams({ client_id: revokeAccount.clientId, token: `Bearer ${revokeAccount.refresh_token}`, refresh_token: 'made-up' }).toString();
    const code = new URLSearchParams({ client_id: flow.client.client_id, grant_type: '\tauthorization_code ', code: flow.code!, code_verifier: flow.verifier, redirect_uri: flow.client.redirect_uris[0], refresh_token: 'made-up', token: 'other' }).toString();
    const variants = [
      ['padded', 'token', padded, `user:${refreshAccount.userId}`],
      ['bearer', 'revoke', bearer, `user:${revokeAccount.userId}`],
      ['code', 'token', code, `code:${flow.code}`],
    ] as const;
    for (const [name, path, body, key] of variants) {
      const seen = watchHandler();
      const done = await holdLock(key);
      const started = Date.now();
      const waiting = await rawPost(path, body);
      expect(waiting.status, `${name} waits for the held lock`).toBe(503);
      expect(waiting.headers.get('retry-after')).toBeTruthy();
      expect(seen.entered, `${name} did not run under another lock`).toBe(0);
      expect(Date.now() - started).toBeLessThan(8000);
      await done();
    }
    // With nothing held they run (the lock was released and the connection came back).
    expect((await rawPost('token', padded)).status).toBe(200);
    expect((await rawPost('revoke', bearer)).status).toBe(200);
    expect((await rawPost('token', code)).status, 'the code works once').toBe(200);
    // Stray fields never choose the lock: a lock on another user's token does not block this revoke.
    const mine = await freshAccount('lock-mine'), theirs = await freshAccount('lock-theirs');
    const done = await holdLock(`user:${theirs.userId}`);
    const seen = watchHandler();
    const unaffected = await rawPost('revoke', new URLSearchParams({ client_id: mine.clientId, token: mine.refresh_token, refresh_token: theirs.refresh_token }).toString());
    expect(unaffected.status).toBe(200);
    expect(seen.entered).toBe(1);
    await done();
  });
  it('refuses repeated deciding fields, and requests with nothing to lock take no lock', async () => {
    const ambiguous = await rawPost('revoke', 'client_id=x&token=A&token=B');
    expect(ambiguous.status).toBe(400);
    expect((await ambiguous.json() as any).error).toBe('invalid_request');
    expect((await rawPost('token', 'grant_type=refresh_token&refresh_token=A&refresh_token=B')).status).toBe(400);
    expect((await rawPost('token', 'grant_type=a&grant_type=refresh_token&refresh_token=A')).status).toBe(400);
    const seen = watchHandler();
    // These would share one lock key if nothing-to-lock fell back to a constant; a held lock on
    // the old fallback keys must not make them wait.
    const dones = [await holdLock('code:'), await holdLock(`token:${digest('')}`)];
    const started = Date.now();
    expect((await rawPost('token', 'grant_type=client_credentials&client_id=n')).status).not.toBe(503);
    expect((await rawPost('token', 'not a form')).status).not.toBe(503);
    expect((await rawPost('token', 'grant_type=authorization_code&client_id=n')).status).not.toBe(503);
    expect((await fetch(`${config.origin}/api/auth/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"grant_type":"refresh_token","refresh_token":"R"}' })).status).not.toBe(503);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(seen.entered).toBe(4);
    for (const done of dones) await done();
  });
  it('same-token operations run one at a time, whatever extra fields they carry', async () => {
    const a = await freshAccount('lock-serial');
    const inside = { now: 0, max: 0 };
    watchHandler(original => async request => {
      if (!/\/oauth2\/(token|revoke)$/.test(new URL(request.url).pathname)) return original(request);
      inside.max = Math.max(inside.max, ++inside.now);
      await new Promise(resolve => setTimeout(resolve, 100));
      try { return await original(request); } finally { inside.now--; }
    });
    const base = { client_id: a.clientId };
    const results = await Promise.all([
      rawPost('token', new URLSearchParams({ ...base, grant_type: 'refresh_token', refresh_token: a.refresh_token }).toString()),
      rawPost('revoke', new URLSearchParams({ ...base, token: a.refresh_token, refresh_token: 'made-up' }).toString()),
      rawPost('token', new URLSearchParams({ ...base, grant_type: ' refresh_token', refresh_token: a.refresh_token, token: 'x' }).toString()),
    ]);
    expect(results.every(r => r.status < 500), results.map(r => r.status).join()).toBe(true);
    expect(inside.max).toBe(1);
  });
  it('answers 503 with Retry-After when the lock wait or the lock pool runs out, rolling back and freeing the connection', async () => {
    const [one, two] = [await freshAccount('wait-1'), await freshAccount('wait-2')];
    const refresh = (g: typeof one) => exchange(g.clientId, { grant_type: 'refresh_token', refresh_token: g.refresh_token });
    // A wait that outlasts lock_timeout fails instead of queueing forever.
    let hold!: () => void;
    const held = new Promise<void>(resolve => (hold = resolve));
    watchHandler(original => async request => {
      if (new URLSearchParams(await request.clone().text()).get('refresh_token') === one.refresh_token) await held;
      return original(request);
    });
    const slow = refresh(one);
    await new Promise(resolve => setTimeout(resolve, 200));
    const sameUser = await exchange(one.clientId, { grant_type: 'refresh_token', refresh_token: one.refresh_token });
    expect(sameUser.status).toBe(503);
    expect(sameUser.headers.get('retry-after')).toBeTruthy();
    hold();
    expect((await slow).status).toBe(200);
    // Nothing is left holding the lock or an open transaction.
    const idle = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE state = 'idle in transaction' AND query LIKE '%pg_advisory_xact_lock%' AND datname = current_database()");
    expect(idle.rows[0].n).toBe(0);
    expect((await refresh(two)).status).toBe(200);
    // With a pool of 2 and both connections waiting, a third request times out getting one.
    const small = await createAccountApp({ ...config, authLockPoolSize: 2 }, store, accountDependencies(supervisorDeps, store, HOURLY), publicDependencies(supervisorDeps), { lockWaitMs: 400 });
    server.removeListener('request', service.app); server.on('request', small.app);
    onTestFinished(async () => { server.removeListener('request', small.app); server.on('request', service.app); await small.close(); });
    const [a, b, c] = [await freshAccount('pool-a'), await freshAccount('pool-b'), await freshAccount('pool-c')];
    let open!: () => void;
    const gate = new Promise<void>(resolve => (open = resolve));
    const original = small.auth.handler;
    small.auth.handler = (async (request: Request) => {
      const t = new URLSearchParams(await request.clone().text()).get('refresh_token');
      if (t === a.refresh_token || t === b.refresh_token) await gate;
      return original(request);
    }) as typeof original;
    onTestFinished(open);
    const inFlight = [refresh(a), refresh(b)];
    await new Promise(resolve => setTimeout(resolve, 200));
    const starved = await refresh(c);
    expect(starved.status).toBe(503);
    expect(starved.headers.get('retry-after')).toBeTruthy();
    open();
    for (const r of await Promise.all(inFlight)) expect(r.status).toBe(200);
    expect((await refresh(c)).status, 'the pool recovered').toBe(200);
  });
  it('limits /oauth2/token and /oauth2/revoke per client address (an IPv6 /64 as one) before any lookup', async () => {
    const replica = await createAccountApp(config, store, accountDependencies(supervisorDeps, store, HOURLY), publicDependencies(supervisorDeps), { lockWaitMs: 300, tokenRequestLimit: { rps: 0.001, burst: 3 } });
    server.removeListener('request', service.app); server.on('request', replica.app);
    onTestFinished(async () => { server.removeListener('request', replica.app); server.on('request', service.app); await replica.close(); });
    const context = await replica.auth.$context;
    const original = context.adapter.findOne;
    let lookups = 0;
    context.adapter.findOne = ((...args: Parameters<typeof original>) => { lookups++; return original(...args); }) as typeof original;
    onTestFinished(() => { context.adapter.findOne = original; });
    const post = (path: string, ip: string, body: Record<string, string>) =>
      rawPost(path, new URLSearchParams({ client_id: 'nobody', ...body }).toString(), { 'x-real-ip': ip }).then(r => r.status);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push(await post('token', '192.0.2.131', { grant_type: 'refresh_token', refresh_token: 'x' }));
    expect(statuses.slice(3)).toEqual([429, 429, 429]);
    expect(statuses.slice(0, 3).every(s => s !== 429)).toBe(true);
    const before = lookups;
    expect(await post('revoke', '192.0.2.131', { token: 'x' })).toBe(429);
    expect(lookups, 'limited before the lock lookup').toBe(before);
    expect(await post('revoke', '192.0.2.132', { token: 'x' })).not.toBe(429);
    for (let i = 0; i < 3; i++) await post('revoke', `2001:db8:5:6::${i + 1}`, { token: 'x' });
    expect(await post('revoke', '2001:db8:5:6:ffff::1', { token: 'x' })).toBe(429);
    expect(await post('revoke', '2001:db8:5:7::1', { token: 'x' })).not.toBe(429);
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
