import type { Dispatcher } from 'undici';
import type { CorpusEntry } from '../../search/corpus.js';
import type { UpstreamGateLike } from '../../util/httpClient.js';

export interface SourceMeta {
  name: string;          // sandbox global + RPC binding id
  label: string;         // human label
  enabled: boolean;
  disabledReason?: string;
}

export interface Source extends SourceMeta {
  client: object;        // host-side client, never traversed by sandbox RPC
  methods: RpcMethods;   // explicit public dotted paths, relative to the binding
  corpus: { endpoints: CorpusEntry[]; fields: CorpusEntry[] };
}

// Each registered function retains its concrete argument contract at registration.
// Runtime arguments cross the sandbox bridge as data, never as host references.
// Methods of every signature live in one table and are called with arguments the sandbox sent,
// validated by each method itself, so the table is deliberately untyped at this boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RpcMethods = Readonly<Record<string, (...args: any[]) => unknown>>;

export interface SourceConfig {
  baseUrl: string;
  userAgent: string;
  timeoutMs: number;
  retries: number;
  cacheTtlMs: number;
  cacheMaxItems: number;
  /** Summed size bound for the response cache. */
  cacheMaxBytes?: number;
  maxResponseBytes?: number;
  /** Process-wide admission control; built once in buildSupervisor. */
  gate?: UpstreamGateLike;
  dispatcher?: Dispatcher;
}

/** Names of the registered sources, i.e. the sandbox globals. */
export const SOURCE_NAMES = ['ctgov'] as const;
export type SourceName = typeof SOURCE_NAMES[number];
