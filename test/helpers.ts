import type { Dispatcher } from 'undici';
import type { SourceConfig } from '../src/sdk/sources/source.js';
import type { SupervisorConfig } from '../src/supervisor/index.js';

export const CTGOV_ORIGIN = 'https://clinicaltrials.gov';
export const API = '/api/v2';

/** A SourceConfig with no cache and no retries. */
export function sourceCfg(opts: { dispatcher?: Dispatcher; baseUrl?: string } = {}): SourceConfig {
  return {
    baseUrl: opts.baseUrl ?? `${CTGOV_ORIGIN}${API}`,
    userAgent: 'test/0.0', timeoutMs: 5000, retries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
    ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
  };
}

/** A SupervisorConfig suitable for tests (fast gate, no cache). */
export function supervisorCfg(extra: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return {
    userAgent: 'test/0.0', upstreamTimeoutMs: 5000, upstreamRetries: 0, cacheTtlMs: 0, cacheMaxItems: 0,
    sandbox: 'auto', upstreamRatePerSec: 1000,
    ...extra,
  };
}

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Loopback {
  /** Base URL to give the SDK in place of https://clinicaltrials.gov/api/v2. */
  baseUrl: string;
  /** Requests received (path and query), in order. */
  requests: string[];
  /** Requests whose socket closed before the response finished (the client aborted). */
  aborted: () => number;
  close: () => Promise<void>;
}

/**
 * A real HTTP server on loopback standing in for ClinicalTrials.gov. undici's MockAgent ignores
 * aborts during reply delays, so cancellation and deadline tests need a real socket.
 */
export async function loopback(handler: (req: IncomingMessage, res: ServerResponse, index: number) => void): Promise<Loopback> {
  const requests: string[] = [];
  let aborted = 0;
  const server = createServer((req, res) => {
    const index = requests.length;
    requests.push(req.url ?? '');
    res.on('close', () => { if (!res.writableEnded) aborted++; });
    handler(req, res, index);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/v2`,
    requests,
    aborted: () => aborted,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 10));
  }
}
