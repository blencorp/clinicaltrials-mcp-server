import { request, type Dispatcher } from 'undici';
import { LRUCache } from 'lru-cache';
import { gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { USER_AGENT } from '../project.js';
import { logger } from './logger.js';
import { abortError, currentSignal, sleep } from './executionContext.js';

const decompressGzip = promisify(gunzip) as (buf: Buffer, opts: { maxOutputLength: number }) => Promise<Buffer>;

/** Upper bound on an upstream's Retry-After when pausing every caller; only guards against absurd values. */
const MAX_GATE_PAUSE_MS = 60 * 60 * 1000;
/** Longest a single call sleeps before its one 429 retry; longer cooldowns fail the call instead. */
const MAX_RETRY_WAIT_MS = 30_000;

/** Largest upstream response body kept in memory (after decompression), by default. */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export const DEFAULT_BASE_URL = 'https://clinicaltrials.gov/api/v2';

export interface HttpClientOptions {
  baseUrl?: string;
  userAgent?: string;
  timeoutMs?: number;
  /** Retries after the first attempt, for network errors and 5xx. */
  retries?: number;
  cacheTtlMs?: number;
  cacheMaxItems?: number;
  /** Upper bound on the summed size of cached response bodies (UTF-16 code units). Default 32 MiB. */
  cacheMaxBytes?: number;
  dispatcher?: Dispatcher;
  /** Retry a 429 once, after the cooldown, when that cooldown is at most 30 s. Default true. */
  retry429?: boolean;
  /** Largest response body accepted; bigger bodies fail with ResponseTooLarge. */
  maxResponseBytes?: number;
  /** Shared process-wide admission control (see UpstreamGate). */
  gate?: UpstreamGateLike;
  /** Human name of the upstream, used in error messages and logs. */
  label?: string;
}

/** What HttpClient needs from an UpstreamGate; injectable for tests. */
export interface UpstreamGateLike { acquire(signal?: AbortSignal): Promise<() => void>; pause(ms: number): void }

export type QueryValue = string | number | boolean | string[] | undefined;

export interface CallOptions {
  path: string;
  query?: Record<string, QueryValue>;
  /** Abort the request (and any wait for a slot). Defaults to the current execution's signal. */
  signal?: AbortSignal;
}

interface InflightEntry { promise: Promise<unknown>; controller: AbortController; waiters: number; forget?: () => void }

interface Cached { status: number; body: unknown; size: number }

export class HttpClient {
  private readonly cache: LRUCache<string, Cached>;
  private readonly cacheEnabled: boolean;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly retry429: boolean;
  private readonly maxResponseBytes: number;
  private readonly dispatcher?: Dispatcher;
  private readonly gate?: UpstreamGateLike;
  private readonly label: string;
  /**
   * Identical requests already on the wire; later callers share the first one's result. The shared
   * request is aborted only when every caller waiting on it has aborted.
   */
  private readonly inflight = new Map<string, InflightEntry>();

  constructor(opts: HttpClientOptions = {}) {
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.userAgent = opts.userAgent ?? USER_AGENT;
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.retries = opts.retries ?? 3;
    this.retry429 = opts.retry429 ?? true;
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    if (opts.dispatcher) this.dispatcher = opts.dispatcher;
    if (opts.gate) this.gate = opts.gate;
    this.label = opts.label ?? 'ClinicalTrials.gov';
    const max = opts.cacheMaxItems ?? 500;
    const ttl = opts.cacheTtlMs ?? 300_000;
    this.cacheEnabled = max > 0 && ttl > 0;
    const maxBytes = Math.max(opts.cacheMaxBytes ?? 32 * 1024 * 1024, 1024);
    this.cache = new LRUCache<string, Cached>({
      max: Math.max(max, 1), ttl: Math.max(ttl, 1),
      // A response bigger than the whole cache is simply not cached.
      maxSize: maxBytes, maxEntrySize: maxBytes, sizeCalculation: v => Math.max(1, v.size),
    });
  }

  async call<T = unknown>(o: CallOptions): Promise<T> {
    const url = this.buildUrl(o.path, o.query);
    const key = `GET ${url}`;
    if (this.cacheEnabled && this.cache.has(key)) {
      logger.debug('http.cache_hit', { url });
      return this.cache.get(key)!.body as T;
    }
    const signal = o.signal ?? currentSignal();
    if (signal?.aborted) throw abortError();
    // Join an identical request already on the wire rather than queueing a second one.
    let entry = this.inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const promise = this.fetchWithRetry<T>(url, key, controller.signal);
      const created: InflightEntry = { promise, controller, waiters: 0 };
      const forget = () => { if (this.inflight.get(key) === created) this.inflight.delete(key); };
      created.forget = forget;
      entry = created;
      promise.then(forget, forget);
      promise.catch(() => { /* each waiter observes the rejection itself */ });
      this.inflight.set(key, created);
    }
    return this.wait<T>(entry, signal);
  }

  /** One caller's view of a shared request: it may abort its own wait without failing others. */
  private wait<T>(entry: InflightEntry, signal?: AbortSignal): Promise<T> {
    entry.waiters++;
    if (!signal) return entry.promise.finally(() => { entry.waiters--; }) as Promise<T>;
    return new Promise<T>((resolve, reject) => {
      let done = false;
      const finish = () => { if (done) return false; done = true; entry.waiters--; signal.removeEventListener('abort', onAbort); return true; };
      const onAbort = () => {
        if (!finish()) return;
        // Once nobody waits, the shared request is dying: later identical calls must start their own.
        if (entry.waiters === 0) { entry.forget?.(); entry.controller.abort(); }
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      entry.promise.then(v => { if (finish()) resolve(v as T); }, e => { if (finish()) reject(e); });
    });
  }

  private async fetchWithRetry<T>(url: string, key: string, signal: AbortSignal): Promise<T> {
    let attempt = 0;
    let retried429 = false;
    for (;;) {
      try {
        return await this.attempt<T>(url, key, signal);
      } catch (err) {
        if (err instanceof GateTimeoutError || err instanceof ResponseTooLargeError || (err as Error)?.name === 'AbortError') throw err;
        const status = err instanceof HttpError ? err.status : 0;
        if (status === 429) {
          // attempt() already paused the gate before releasing its slot.
          const wait = Math.min(MAX_GATE_PAUSE_MS, (err as HttpError).retryAfterMs ?? 1000);
          if (!this.retry429 || retried429 || wait > MAX_RETRY_WAIT_MS) throw err;
          retried429 = true;
          await sleep(wait, signal);
          continue;
        }
        const retryable = status === 0 || status >= 500;
        if (!retryable || attempt === this.retries) throw err;
        await sleep(Math.min(2 ** attempt * 250, 4000), signal);
        attempt++;
      }
    }
  }

  /** One request, holding a gate slot only while it is on the wire. */
  private async attempt<T>(url: string, key: string, signal: AbortSignal): Promise<T> {
    let release: (() => void) | undefined;
    if (this.gate) {
      try {
        release = await this.gate.acquire(signal);
      } catch (err) {
        const e = err as { name?: string; retryAfterMs?: number };
        if (e?.name === 'AbortError') throw abortError();
        if (e?.name === 'Paused') {
          const g = new GateTimeoutError(`${this.label} asked this server to wait ${Math.ceil((e.retryAfterMs ?? 0) / 1000)}s before calling again (rate limit). Retry later.`);
          g.retryAfterMs = e.retryAfterMs;
          throw g;
        }
        throw new GateTimeoutError(`${this.label} is busy: too many requests from this server are waiting. Make fewer calls per execute (page with a larger pageSize and fewer fields) or retry shortly.`);
      }
    }
    // Absolute deadline for this attempt: connecting, headers and the whole body. undici's own
    // header/body timeouts are inactivity timers, which a slowly trickling response never trips.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.timeoutMs);
    const requestSignal = AbortSignal.any([signal, deadline.signal]);
    try {
      const res = await request(url, {
        method: 'GET',
        headers: { accept: 'application/json', 'accept-encoding': 'gzip', 'user-agent': this.userAgent },
        bodyTimeout: this.timeoutMs,
        headersTimeout: this.timeoutMs,
        signal: requestSignal,
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });

      // A 429 pauses every caller now, from status and headers alone, before this slot is released.
      if (res.statusCode === 429) {
        const rawRetryAfter = Array.isArray(res.headers['retry-after']) ? res.headers['retry-after'][0] : res.headers['retry-after'];
        const retryAfterMs = parseRetryAfter(rawRetryAfter);
        this.gate?.pause(Math.min(MAX_GATE_PAUSE_MS, retryAfterMs ?? 1000));
        logger.warn('upstream.rate_limited', { source: this.label, host: new URL(url).host });
        // Drain (bounded) so the connection can be reused.
        try { await readCapped(res.body, res.headers['content-length'], 64 * 1024, url, true); } catch { /* status and headers were enough */ }
        const err = new HttpError(`${this.label} is rate limiting this server: GET ${stripQuery(url)} -> 429 Too Many Requests${retryAfterMs !== undefined ? ` (retry after ${Math.ceil(retryAfterMs / 1000)}s)` : ''}. Slow down and retry later.`, 429, '');
        err.name = 'RateLimited';
        err.retryAfterMs = retryAfterMs;
        throw err;
      }

      // undici.request returns raw bytes: decode before parsing, reporting errors or caching.
      const raw = await readCapped(res.body, res.headers['content-length'], this.maxResponseBytes, `GET ${url}`, res.statusCode >= 400);
      const encoding = res.headers['content-encoding'];
      const limit = res.statusCode >= 400 ? Math.min(this.maxResponseBytes, 64 * 1024) : this.maxResponseBytes;
      let bytes = raw;
      if (typeof encoding === 'string' && encoding.trim().toLowerCase() === 'gzip') {
        // Bound the expansion itself, not just the compressed size.
        try { bytes = await decompressGzip(raw, { maxOutputLength: limit + 1 }); }
        catch (err) {
          if ((err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE') {
            if (res.statusCode < 400) throw new ResponseTooLargeError(`GET ${url}`, this.maxResponseBytes);
            bytes = Buffer.alloc(0);
          } else throw err;
        }
      }
      if (bytes.length > limit) {
        if (res.statusCode < 400) throw new ResponseTooLargeError(`GET ${url}`, this.maxResponseBytes);
        bytes = bytes.subarray(0, limit);
      }
      const text = new TextDecoder().decode(bytes);

      if (res.statusCode >= 400) {
        const err = new HttpError(`${this.label}: GET ${stripQuery(url)} -> ${res.statusCode}${upstreamDetail(text)}`, res.statusCode, text.slice(0, 2000));
        if (res.statusCode === 404) err.name = 'NotFound';
        else if (res.statusCode === 400) err.name = 'BadRequest';
        throw err;
      }

      let body: unknown;
      try { body = text.length ? JSON.parse(text) : null; }
      catch { body = text; } // csv, ris, or a malformed body: the raw text
      if (this.cacheEnabled) this.cache.set(key, { status: res.statusCode, body, size: text.length });
      return body as T;
    } catch (err) {
      if (signal.aborted) throw abortError();
      if (deadline.signal.aborted) {
        const e = new HttpError(`${this.label}: GET ${stripQuery(url)} did not complete within ${this.timeoutMs} ms`, 0, '');
        e.name = 'UpstreamTimeout';
        throw e;
      }
      if (err instanceof HttpError || err instanceof ResponseTooLargeError) throw err;
      // A transport failure (reset, DNS, TLS): name the upstream, keep the cause out of the message.
      const e = new HttpError(`${this.label}: GET ${stripQuery(url)} failed: ${(err as Error)?.message ?? String(err)}`.slice(0, 500), 0, '');
      e.name = 'UpstreamUnavailable';
      throw e;
    } finally {
      clearTimeout(timer);
      release?.();
    }
  }

  /** ClinicalTrials.gov takes arrays comma-joined and booleans spelled true/false. */
  private buildUrl(path: string, query?: CallOptions['query']): string {
    const base = this.baseUrl.replace(/\/$/, '');
    const p = path.startsWith('/') ? path : '/' + path;
    const url = new URL(base + p);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null) continue;
        if (Array.isArray(v)) url.searchParams.set(k, v.map(String).join(','));
        else if (typeof v === 'boolean') url.searchParams.set(k, v ? 'true' : 'false');
        else url.searchParams.set(k, String(v));
      }
    }
    return url.toString();
  }
}

/** Error bodies can echo the query string; keep messages to the path. */
function stripQuery(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}

/** A short reason from a ClinicalTrials.gov error body ({ message } or plain text). */
function upstreamDetail(text: string): string {
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const parts = [j.message, j.error, j.detail].filter(v => typeof v === 'string' && v.trim()) as string[];
    const detail = [...new Set(parts)].join(' - ').slice(0, 300);
    return detail ? `: ${detail}` : '';
  } catch {
    const t = text.trim().slice(0, 200);
    return t && !t.startsWith('<') ? `: ${t}` : '';
  }
}

/** Read a response body, failing fast once it exceeds `max` bytes. */
async function readCapped(
  body: AsyncIterable<Uint8Array> & { destroy?: (err?: Error) => void },
  contentLength: string | string[] | undefined,
  max: number,
  what: string,
  isError: boolean,
): Promise<Buffer> {
  // Error bodies are only used for a short message; never buffer a huge one.
  const limit = isError ? Math.min(max, 64 * 1024) : max;
  const declared = Number(Array.isArray(contentLength) ? contentLength[0] : contentLength);
  if (!isError && Number.isFinite(declared) && declared > limit) {
    body.destroy?.();
    throw new ResponseTooLargeError(what, max);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) {
      body.destroy?.();
      if (isError) break;
      throw new ResponseTooLargeError(what, max);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date; undefined if absent or invalid. */
export function parseRetryAfter(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  // Check numerics first: Date.parse('1.5') is a valid date in V8 (2001), not 1.5 seconds.
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000;
  if (/^[\d.]+$/.test(v)) return undefined;
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export class HttpError extends Error {
  retryAfterMs?: number;
  constructor(message: string, public readonly status: number, public readonly bodySnippet: string) {
    super(message);
    this.name = 'HttpError';
  }
}

/** No gate slot freed up within maxWaitMs. Never retried: the queue is already full. */
class GateTimeoutError extends HttpError {
  constructor(message: string) {
    super(message, 429, '');
    this.name = 'RateLimited';
  }
}

/** The upstream body exceeded maxResponseBytes. Never retried. */
export class ResponseTooLargeError extends HttpError {
  constructor(what: string, max: number) {
    super(`${what.split('?')[0]} returned more than ${Math.round(max / 1024 / 1024)} MB. Request fewer results (smaller pageSize, or select fields) and paginate.`, 0, '');
    this.name = 'ResponseTooLarge';
  }
}
