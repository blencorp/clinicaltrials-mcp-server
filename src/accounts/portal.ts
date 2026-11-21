import express, { type Express, type Request, type Response } from 'express';
import { fromNodeHeaders } from 'better-auth/node';
import { verifyOAuthQueryParams } from '@better-auth/oauth-provider';
import type { AccountConfig } from './config.js';
import { ACCOUNT_MCP_PATH, PUBLIC_MCP_PATH } from './paths.js';
import type { Auth } from './provider.js';

/**
 * The portal's JSON API (same-origin, cookie-authenticated). Keyless: it shows the account, and
 * carries the consent step of an OAuth connection. No route accepts a credential, a URL or an owner.
 */
export function installPortal(
  app: Express, config: AccountConfig, auth: Auth,
  ipOf: (req: Request) => string | undefined,
) {
  const api = express.Router();
  api.use(express.json({ limit: '8kb' }));
  api.use((req, res, next) => {
    if (req.method !== 'GET' && (req.headers.origin !== config.origin || !req.is('application/json'))) {
      return res.status(403).json({ error: 'Invalid request origin.' });
    }
    next();
  });
  async function verified(req: Request) {
    const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    return session?.user.emailVerified ? session : undefined;
  }
  async function validQuery(value: unknown) {
    return typeof value === 'string' && value.length < 16384 &&
      await verifyOAuthQueryParams(value, config.authSecret) ? value : undefined;
  }
  const error = (res: Response, status: number, message: string) => res.status(status).json({ error: message });
  const mcpUrl = `${config.origin}${ACCOUNT_MCP_PATH}`;
  /** What the Consent page shows, or undefined when the signed query lacks the client or its redirect. */
  async function connection(query: string) {
    const params = new URLSearchParams(query);
    const clientId = params.get('client_id');
    const redirectUri = params.get('redirect_uri');
    if (!clientId || !redirectUri || !URL.canParse(redirectUri)) return undefined;
    const client = await (await auth.$context).adapter.findOne<{ name?: string }>({
      model: 'oauthClient', where: [{ field: 'clientId', value: clientId }],
    });
    const redirect = new URL(redirectUri);
    return { client: client?.name || 'This application', destination: redirect.host,
      local: ['localhost', '127.0.0.1', '[::1]'].includes(redirect.hostname) };
  }
  const EXPIRED = 'This connection request expired. Start again from your AI assistant.';
  async function continueWith(req: Request, res: Response, path: string, body: object) {
    const headers = fromNodeHeaders(req.headers);
    headers.delete('content-length');
    headers.set('content-type', 'application/json');
    headers.set('accept', 'application/json');
    // Forward only the client address trusted by Express, not a caller's spoofed chain.
    const ip = ipOf(req);
    if (ip) headers.set('x-forwarded-for', ip);
    else headers.delete('x-forwarded-for');
    const response = await auth.handler(new globalThis.Request(`${config.origin}/api/auth${path}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }));
    const cookies = response.headers.getSetCookie();
    if (cookies.length) res.setHeader('Set-Cookie', cookies);
    const result = await response.json().catch(() => ({})) as { url?: unknown; redirect_uri?: unknown };
    const url = response.status >= 300 && response.status < 400 ? response.headers.get('location') : result.url ?? result.redirect_uri;
    if (typeof url !== 'string' || response.status >= 400) return error(res, 400, 'Connection authorization failed.');
    res.json({ url: new URL(url, config.origin).toString() });
  }
  api.get('/config', (_req, res) => res.json({ google: true, email: false, mcpUrl, publicMcpUrl: `${config.origin}${PUBLIC_MCP_PATH}` }));
  api.get('/account', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    res.json({ email: logged.user.email, mcpUrl });
  });
  api.get('/consent', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    const query = await validQuery(req.query.oauth_query);
    const shown = query && await connection(query);
    if (!shown) return error(res, 400, EXPIRED);
    res.json({ ...shown, email: logged.user.email });
  });
  api.post('/consent', async (req, res) => {
    const logged = await verified(req);
    if (!logged) return error(res, 401, 'Sign in to continue.');
    const query = await validQuery(req.body?.oauth_query);
    if (!query || typeof req.body?.accept !== 'boolean') return error(res, 400, 'Connection authorization failed.');
    return continueWith(req, res, '/oauth2/consent', { oauth_query: query, accept: req.body.accept });
  });
  app.use('/api/portal', api);
}
