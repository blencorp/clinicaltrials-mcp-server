import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockAgent } from 'undici';
import { gzipSync } from 'node:zlib';
import { HttpClient, type HttpError, ResponseTooLargeError, parseRetryAfter } from '../src/util/httpClient.js';
import { UpstreamGate } from '../src/util/upstreamGate.js';
import { loopback, until, CTGOV_ORIGIN, API } from './helpers.js';

let agent: MockAgent;
beforeEach(() => { agent = new MockAgent(); agent.disableNetConnect(); });
afterEach(async () => { await agent.close(); });

const json = { headers: { 'content-type': 'application/json' } };
const client = (extra: ConstructorParameters<typeof HttpClient>[0] = {}) =>
  new HttpClient({ dispatcher: agent, cacheTtlMs: 0, retries: 0, ...extra });
const pool = () => agent.get(CTGOV_ORIGIN);

describe('HttpClient requests', () => {
  it('sends GET with the user agent, gzip and JSON accept, comma-joined arrays and true/false booleans', async () => {
    let seen: Record<string, unknown> = {};
    pool().intercept({ path: p => p.startsWith(`${API}/studies`), method: 'GET' }).reply(opts => {
      seen = { path: opts.path, headers: opts.headers };
      return { statusCode: 200, data: '{}', responseOptions: json };
    });
    await client({ userAgent: 'ua/1' }).call({ path: '/studies', query: { fields: ['NCTId', 'BriefTitle'], countTotal: true, skip: undefined, pageSize: 0, sort: 'x:desc' } });
    expect(seen.path).toBe(`${API}/studies?fields=NCTId%2CBriefTitle&countTotal=true&pageSize=0&sort=x%3Adesc`);
    expect(seen.headers).toMatchObject({ 'user-agent': 'ua/1', accept: 'application/json', 'accept-encoding': 'gzip' });
  });

  it('parses JSON, returns csv or malformed bodies as text and an empty 200 as null', async () => {
    pool().intercept({ path: `${API}/a`, method: 'GET' }).reply(200, { a: 1 }, json);
    pool().intercept({ path: `${API}/b`, method: 'GET' }).reply(200, 'NCTId,Title\nNCT1,x');
    pool().intercept({ path: `${API}/c`, method: 'GET' }).reply(200, '');
    const c = client();
    expect(await c.call({ path: '/a' })).toEqual({ a: 1 });
    expect(await c.call({ path: '/b' })).toBe('NCTId,Title\nNCT1,x');
    expect(await c.call({ path: '/c' })).toBeNull();
  });

  it('caches successful GETs per full URL and not errors', async () => {
    pool().intercept({ path: `${API}/version`, method: 'GET' }).reply(200, { v: 1 }, json); // once only
    pool().intercept({ path: `${API}/studies/NCT00000000`, method: 'GET' }).reply(404, '').times(2);
    const c = client({ cacheTtlMs: 60_000, cacheMaxItems: 10 });
    expect(await c.call({ path: '/version' })).toEqual({ v: 1 });
    expect(await c.call({ path: '/version' })).toEqual({ v: 1 }); // a second request would fail: net connect is off
    await expect(c.call({ path: '/studies/NCT00000000' })).rejects.toMatchObject({ name: 'NotFound' });
    await expect(c.call({ path: '/studies/NCT00000000' })).rejects.toMatchObject({ name: 'NotFound' });
  });

  it('bounds the cache by bytes: a response bigger than the whole cache is not cached', async () => {
    const big = { text: 'x'.repeat(5000) };
    pool().intercept({ path: `${API}/big`, method: 'GET' }).reply(200, big, json).times(2);
    const c = client({ cacheTtlMs: 60_000, cacheMaxItems: 10, cacheMaxBytes: 1024 });
    await c.call({ path: '/big' });
    await c.call({ path: '/big' }); // went upstream again (two interceptors consumed)
    await expect(c.call({ path: '/big' })).rejects.toBeInstanceOf(Error); // third: no interceptor left
  });

  it('shares one request among identical concurrent calls', async () => {
    let n = 0;
    pool().intercept({ path: `${API}/version`, method: 'GET' }).reply(() => { n++; return { statusCode: 200, data: '{"v":1}', responseOptions: json }; }).persist();
    const c = client();
    expect(await Promise.all([c.call({ path: '/version' }), c.call({ path: '/version' }), c.call({ path: '/version' })])).toEqual([{ v: 1 }, { v: 1 }, { v: 1 }]);
    expect(n).toBe(1);
  });
});

describe('HttpClient errors', () => {
  it.for([[404, 'NotFound'], [400, 'BadRequest'], [403, 'HttpError']] as const)('does not retry a %i (%s) and names the upstream reason without the query', async ([status, name]) => {
    let n = 0;
    pool().intercept({ path: p => p.startsWith(`${API}/studies`), method: 'GET' }).reply(() => { n++; return { statusCode: status, data: JSON.stringify({ message: 'bad things' }) }; }).persist();
    const err = await client({ retries: 3 }).call({ path: '/studies', query: { 'query.cond': 'secret-term' } }).catch((e: unknown) => e as HttpError);
    expect(err).toMatchObject({ name, status });
    expect((err as HttpError).message).toContain('bad things');
    expect((err as HttpError).message).not.toContain('secret-term');
    expect(n).toBe(1);
  });

  it('does not retry 408 or 425 (the old client did): they are client-side conditions', async () => {
    for (const status of [408, 425]) {
      let n = 0;
      pool().intercept({ path: `${API}/s${status}`, method: 'GET' }).reply(() => { n++; return { statusCode: status, data: '' }; }).persist();
      await expect(client({ retries: 3 }).call({ path: `/s${status}` })).rejects.toMatchObject({ status });
      expect(n).toBe(1);
    }
  });

  it('retries a 5xx up to `retries` times with backoff, then fails with the status', async () => {
    let n = 0;
    pool().intercept({ path: `${API}/version`, method: 'GET' }).reply(() => { n++; return { statusCode: 503, data: 'down' }; }).persist();
    const t0 = Date.now();
    await expect(client({ retries: 2 }).call({ path: '/version' })).rejects.toMatchObject({ name: 'HttpError', status: 503 });
    expect(n).toBe(3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700); // 250 + 500
  });

  it('recovers when a later attempt succeeds', async () => {
    pool().intercept({ path: `${API}/version`, method: 'GET' }).reply(500, '');
    pool().intercept({ path: `${API}/version`, method: 'GET' }).reply(200, { ok: 1 }, json);
    expect(await client({ retries: 2 }).call({ path: '/version' })).toEqual({ ok: 1 });
  });

  it('turns a transport failure into UpstreamUnavailable (retried), naming the upstream', async () => {
    pool().intercept({ path: `${API}/version`, method: 'GET' }).replyWithError(new Error('ECONNRESET')).times(2);
    const err = await client({ retries: 1 }).call({ path: '/version' }).catch((e: unknown) => e as HttpError);
    expect(err).toMatchObject({ name: 'UpstreamUnavailable', status: 0 });
    expect((err as HttpError).message).toContain('ClinicalTrials.gov');
  });
});

describe('HttpClient 429 and the shared gate', () => {
  const fakeGate = () => {
    const paused: number[] = [];
    return { paused, gate: { acquire: async () => () => {}, pause: (ms: number) => { paused.push(ms); } } };
  };

  it('pauses the gate for Retry-After and retries once after the cooldown', async () => {
    const { gate, paused } = fakeGate();
    pool().intercept({ path: `${API}/version`, method: 'GET' }).reply(429, '', { headers: { 'retry-after': '0.2' } });
    pool().intercept({ path: `${API}/version`, method: 'GET' }).reply(200, { ok: 1 }, json);
    expect(await client({ gate }).call({ path: '/version' })).toEqual({ ok: 1 });
    expect(paused).toEqual([200]);
  });

  it('fails at once with RateLimited when the cooldown is longer than 30 s, still pausing every caller', async () => {
    const { gate, paused } = fakeGate();
    pool().intercept({ path: `${API}/version`, method: 'GET' }).reply(429, '', { headers: { 'retry-after': '120' } });
    await expect(client({ gate }).call({ path: '/version' })).rejects.toMatchObject({ name: 'RateLimited', status: 429 });
    expect(paused).toEqual([120_000]);
  });

  it('retries a 429 only once', async () => {
    let n = 0;
    pool().intercept({ path: `${API}/version`, method: 'GET' }).reply(() => { n++; return { statusCode: 429, data: '', responseOptions: { headers: { 'retry-after': '0' } } }; }).persist();
    await expect(client({ retries: 5 }).call({ path: '/version' })).rejects.toMatchObject({ name: 'RateLimited' });
    expect(n).toBe(2);
  });

  it('a real gate holds one in-flight request at a time and releases the slot for the next', async () => {
    let active = 0, peak = 0;
    pool().intercept({ path: p => p.startsWith(`${API}/studies/`), method: 'GET' }).reply(() => { active++; peak = Math.max(peak, active); active--; return { statusCode: 200, data: '{}', responseOptions: json }; }).persist();
    const gate = new UpstreamGate({ concurrency: 1, ratePerSec: 1000, burst: 1000, maxWaitMs: 5000 });
    const c = client({ gate });
    await Promise.all(Array.from({ length: 6 }, (_, i) => c.call({ path: `/studies/NCT0000000${i}` })));
    expect(peak).toBe(1);
  });

  it('fails a call fast as RateLimited when its wait for a slot would exceed maxWaitMs', async () => {
    const gate = new UpstreamGate({ concurrency: 1, ratePerSec: 1, burst: 1, maxWaitMs: 50 });
    gate.pause(5000);
    await expect(client({ gate }).call({ path: '/version' })).rejects.toMatchObject({ name: 'RateLimited' });
  });

  it('parses Retry-After as seconds or a date, and ignores junk', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter('1.5')).toBe(1500);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('1.2.3')).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThan(8000);
  });
});

describe('HttpClient size cap', () => {
  it('rejects a declared Content-Length over the cap without reading the body', async () => {
    pool().intercept({ path: `${API}/big`, method: 'GET' }).reply(200, 'x'.repeat(2000), { headers: { 'content-length': '2000' } });
    await expect(client({ maxResponseBytes: 1000 }).call({ path: '/big' })).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it('rejects a streamed body that grows past the cap', async () => {
    pool().intercept({ path: `${API}/big`, method: 'GET' }).reply(200, 'x'.repeat(5000));
    await expect(client({ maxResponseBytes: 1000 }).call({ path: '/big' })).rejects.toMatchObject({ name: 'ResponseTooLarge', status: 0 });
  });

  it('bounds gzip expansion: a small compressed bomb fails instead of being inflated', async () => {
    const bomb = gzipSync(Buffer.alloc(50 * 1024 * 1024, 0x20));
    expect(bomb.length).toBeLessThan(100_000);
    pool().intercept({ path: `${API}/bomb`, method: 'GET' }).reply(200, bomb, { headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' } });
    await expect(client({ maxResponseBytes: 1024 * 1024 }).call({ path: '/bomb' })).rejects.toMatchObject({ name: 'ResponseTooLarge' });
  });

  it('decodes a gzip body within the cap', async () => {
    pool().intercept({ path: `${API}/z`, method: 'GET' }).reply(200, gzipSync(JSON.stringify({ z: 1 })), { headers: { 'content-encoding': 'gzip', 'content-type': 'application/json' } });
    expect(await client().call({ path: '/z' })).toEqual({ z: 1 });
  });

  it('is not retried (a retry would only download it again)', async () => {
    let n = 0;
    pool().intercept({ path: `${API}/big`, method: 'GET' }).reply(() => { n++; return { statusCode: 200, data: 'x'.repeat(5000) }; }).persist();
    await expect(client({ maxResponseBytes: 1000, retries: 3 }).call({ path: '/big' })).rejects.toMatchObject({ name: 'ResponseTooLarge' });
    expect(n).toBe(1);
  });
});

describe('HttpClient abort and deadline (real loopback socket)', () => {
  it('aborts a request in flight: AbortError, and the server sees the socket close', async () => {
    const lb = await loopback(() => { /* never answers */ });
    try {
      const c = new HttpClient({ baseUrl: lb.baseUrl, retries: 3, cacheTtlMs: 0 });
      const ctl = new AbortController();
      const pending = c.call({ path: '/version', signal: ctl.signal }).catch((e: unknown) => e as Error);
      await until(() => lb.requests.length === 1);
      ctl.abort();
      expect(await pending).toMatchObject({ name: 'AbortError' });
      await until(() => lb.aborted() === 1);
      expect(lb.requests).toHaveLength(1); // no retry after an abort
    } finally { await lb.close(); }
  });

  it('aborts a wait for a gate slot', async () => {
    const lb = await loopback(() => { /* never answers */ });
    try {
      const gate = new UpstreamGate({ concurrency: 1, ratePerSec: 1000, burst: 1000, maxWaitMs: 10_000 });
      const c = new HttpClient({ baseUrl: lb.baseUrl, retries: 0, cacheTtlMs: 0, gate });
      const first = new AbortController();
      const p1 = c.call({ path: '/a', signal: first.signal }).catch((e: unknown) => e as Error);
      await until(() => lb.requests.length === 1);
      const second = new AbortController();
      const p2 = c.call({ path: '/b', signal: second.signal }).catch((e: unknown) => e as Error);
      await new Promise(r => setTimeout(r, 50));
      second.abort();
      expect(await p2).toMatchObject({ name: 'AbortError' });
      expect(lb.requests).toHaveLength(1); // /b never left the queue
      first.abort();
      expect(await p1).toMatchObject({ name: 'AbortError' });
    } finally { await lb.close(); }
  });

  it('stops a backoff sleep on abort', async () => {
    const lb = await loopback((_req, res) => { res.statusCode = 503; res.end('down'); });
    try {
      const c = new HttpClient({ baseUrl: lb.baseUrl, retries: 5, cacheTtlMs: 0 });
      const ctl = new AbortController();
      const pending = c.call({ path: '/v', signal: ctl.signal }).catch((e: unknown) => e as Error);
      await until(() => lb.requests.length >= 1);
      ctl.abort();
      const t0 = Date.now();
      expect(await pending).toMatchObject({ name: 'AbortError' });
      expect(Date.now() - t0).toBeLessThan(500);
    } finally { await lb.close(); }
  });

  it('an absolute deadline ends a slow-trickling response: UpstreamTimeout', async () => {
    const lb = await loopback((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      const t = setInterval(() => res.write(' '), 30);
      res.on('close', () => clearInterval(t));
    });
    try {
      const err = await new HttpClient({ baseUrl: lb.baseUrl, retries: 0, cacheTtlMs: 0, timeoutMs: 300 }).call({ path: '/v' }).catch((e: unknown) => e as HttpError);
      expect(err).toMatchObject({ name: 'UpstreamTimeout' });
    } finally { await lb.close(); }
  });

  it('keeps a shared request alive while one waiter remains, and kills it when the last one aborts', async () => {
    const lb = await loopback(() => { /* never answers */ });
    try {
      const c = new HttpClient({ baseUrl: lb.baseUrl, retries: 0, cacheTtlMs: 0 });
      const a = new AbortController(), b = new AbortController();
      const pa = c.call({ path: '/same', signal: a.signal }).catch((e: unknown) => e as Error);
      const pb = c.call({ path: '/same', signal: b.signal }).catch((e: unknown) => e as Error);
      await until(() => lb.requests.length === 1);
      a.abort();
      expect(await pa).toMatchObject({ name: 'AbortError' });
      await new Promise(r => setTimeout(r, 100));
      expect(lb.aborted()).toBe(0);
      b.abort();
      expect(await pb).toMatchObject({ name: 'AbortError' });
      await until(() => lb.aborted() === 1);
      expect(lb.requests).toHaveLength(1);
    } finally { await lb.close(); }
  });
});
