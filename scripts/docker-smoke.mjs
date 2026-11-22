// Runs INSIDE the Docker image (see the `docker` job in .github/workflows/ci.yml):
//   docker run --rm -v "$PWD/scripts/docker-smoke.mjs:/app/docker-smoke.mjs:ro" --entrypoint node IMAGE docker-smoke.mjs
// It starts a loopback OIDC/JWKS issuer (an http JWKS URL is only accepted on loopback, and inside
// the container loopback is the container), starts the authenticated server and checks that `execute`
// runs in the Deno process sandbox for a 2026-07-28 request with a valid bearer token, that a request
// without one is refused, and that the anonymous docs-only server refuses `execute` outright.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

const PROTOCOL = '2026-07-28';
const ISSUER = 'http://127.0.0.1:9100';
const ORIGIN = 'http://127.0.0.1:8080';
const AUDIENCE = `${ORIGIN}/mcp`;
const children = [];
const fail = (msg) => { console.error(`FAIL: ${msg}`); cleanup(); process.exit(1); };
const check = (cond, msg) => { if (!cond) fail(msg); console.log(`ok: ${msg}`); };
function cleanup() { for (const c of children) c.kill('SIGKILL'); }

const { privateKey, publicKey } = await generateKeyPair('ES256');
const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
const jwks = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ keys: [jwk] })); });
await new Promise((r) => jwks.listen(9100, '127.0.0.1', r));
children.push({ kill: () => jwks.close() });

function start(args, env, port) {
  const child = spawn('node', ['dist/bin.js', '--http', '--port', String(port), '--host', '0.0.0.0', ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  children.push(child);
  return { child, stderr: () => stderr };
}

async function ready(port) {
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail(`the server on ${port} did not become healthy`);
}

const meta = { 'io.modelcontextprotocol/protocolVersion': PROTOCOL, 'io.modelcontextprotocol/clientInfo': { name: 'docker-smoke', version: '0' }, 'io.modelcontextprotocol/clientCapabilities': {} };
async function rpc(port, method, params, token) {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL, 'mcp-method': method, ...(params.name ? { 'mcp-name': params.name } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta: meta } }),
  });
  const text = await r.text();
  const data = text.split('\n').find((l) => l.startsWith('data:'));
  return { status: r.status, body: text.startsWith('{') ? JSON.parse(text) : data ? JSON.parse(data.slice(5)) : text };
}

// 1. Authenticated: Deno sandbox.
const auth = start([], {
  CTGOV_PUBLIC_ORIGIN: ORIGIN, CTGOV_AUTH_PROVIDER: 'generic-oidc', CTGOV_AUTH_ISSUER: ISSUER,
  CTGOV_AUTH_AUDIENCE: AUDIENCE, CTGOV_AUTH_JWKS_URL: `${ISSUER}/jwks`, CTGOV_AUTH_SCOPES: 'ctgov:read',
}, 8080);
await ready(8080);
const token = await new SignJWT({ scope: 'ctgov:read' }).setProtectedHeader({ alg: 'ES256', kid: 'k1' })
  .setSubject('smoke').setIssuer(ISSUER).setAudience(AUDIENCE).setIssuedAt().setExpirationTime('5m').sign(privateKey);

const denied = await rpc(8080, 'tools/list', {});
check(denied.status === 401, 'a request without a bearer token is refused (401)');
const run = await rpc(8080, 'tools/call', { name: 'execute', arguments: { code: 'return 1 + 41' } }, token);
check(run.status === 200 && run.body.result?.structuredContent?.ok === true && run.body.result.structuredContent.value === 42, 'execute returns 42 for an authenticated 2026-07-28 request');
check(/"executor":"deno"/.test(auth.stderr()), 'the server selected the Deno sandbox');
const escape = await rpc(8080, 'tools/call', { name: 'execute', arguments: { code: 'return globalThis' } }, token);
check(escape.body.result?.isError === true && escape.body.result.structuredContent?.error?.name === 'PolicyError', 'the preflight refuses globalThis');
auth.child.kill('SIGTERM');

// 2. Anonymous docs-only (the image default): no execute.
const docs = start(['--public-docs'], { CTGOV_PUBLIC_ORIGIN: 'http://127.0.0.1:8081' }, 8081);
await ready(8081);
const tools = await rpc(8081, 'tools/list', {});
check(JSON.stringify(tools.body.result?.tools?.map((t) => t.name)) === '["search_api","describe_schema"]', 'docs-only lists search_api and describe_schema only');
const refused = await rpc(8081, 'tools/call', { name: 'execute', arguments: { code: 'return 1' } });
check(refused.body.error?.code === -32602 && /not found/.test(refused.body.error.message), 'docs-only refuses execute as an unknown tool');
check(!/sandbox/.test(docs.stderr()) || /"executor":"none"/.test(docs.stderr()), 'docs-only never resolves a sandbox');

cleanup();
console.log('docker smoke passed');
process.exit(0);
