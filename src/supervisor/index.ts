import type { Dispatcher } from 'undici';
import { USER_AGENT } from '../project.js';
import { sdkFromSources } from '../sdk/bindings.js';
import { getSources } from '../sdk/sources/index.js';
import type { SourceConfig } from '../sdk/sources/source.js';
import { buildCorpus } from '../search/corpus.js';
import { pickSandbox } from '../sandbox/index.js';
import { UpstreamGate } from '../util/upstreamGate.js';
import { SubjectQuota } from '../util/quotas.js';
import { ExecutionLimiter } from '../util/executionLimiter.js';
import { DEFAULT_BASE_URL } from '../util/httpClient.js';
import { DEFAULT_CALL_BUDGET } from '../tools/execute.js';
import type { CatalogDeps } from '../server/toolCatalog.js';
import type { SandboxKind } from '../sandbox/types.js';

export const EXECUTION_DEFAULTS = { maxConcurrent: 8, perSubject: 2 } as const;

/**
 * ClinicalTrials.gov publishes no rate limit. 10 requests per second (with a burst of 10 and 8 in
 * flight) is the long-standing assumption of this server and stays well below what the public API
 * serves; CTGOV_RATE_PER_SEC lowers or raises it. The gate is process-wide: every caller's
 * requests leave from this server's address.
 */
export const UPSTREAM_DEFAULTS = { concurrency: 8, ratePerSec: 10, maxWaitMs: 15_000 } as const;

/** Per-subject hourly ClinicalTrials.gov calls on authenticated HTTP (checked before the cache). */
export const SUBJECT_RATE_PER_HOUR_DEFAULT = 3000;

export interface SupervisorConfig {
  baseUrl?: string;
  userAgent: string;
  upstreamTimeoutMs: number;
  upstreamRetries: number;
  cacheTtlMs: number;
  cacheMaxItems: number;
  maxResponseBytes?: number;
  /** `docs-only` serves search_api and describe_schema; no sandbox is ever resolved. */
  tools?: 'all' | 'docs-only';
  sandbox: SandboxKind;
  /** Prefer a process-isolated sandbox (multi-user HTTP serving: Deno only). */
  processIsolation?: boolean;
  /** Upstream calls one execute may make. */
  maxCallsPerExecute?: number;
  /** Per-subject hourly cap on authenticated HTTP. */
  subjectRatePerHour?: number;
  /** Process-wide upstream admission: requests in flight, started per second, longest queue wait. */
  upstreamConcurrency?: number;
  upstreamRatePerSec?: number;
  upstreamMaxWaitMs?: number;
  /** Simultaneous executions, server-wide and per subject. */
  maxConcurrentExecutions?: number;
  maxExecutionsPerSubject?: number;
  /** Aborts every execution (graceful shutdown). */
  shutdownSignal?: AbortSignal;
  /** undici dispatcher for upstream requests (tests inject a MockAgent). */
  dispatcher?: Dispatcher;
}

export function upstreamGate(cfg: Pick<SupervisorConfig, 'upstreamConcurrency' | 'upstreamRatePerSec' | 'upstreamMaxWaitMs'>): UpstreamGate {
  const ratePerSec = cfg.upstreamRatePerSec ?? UPSTREAM_DEFAULTS.ratePerSec;
  return new UpstreamGate({
    concurrency: cfg.upstreamConcurrency ?? UPSTREAM_DEFAULTS.concurrency,
    ratePerSec, burst: Math.max(1, Math.ceil(ratePerSec)),
    maxWaitMs: cfg.upstreamMaxWaitMs ?? UPSTREAM_DEFAULTS.maxWaitMs,
  });
}

/**
 * Everything one process shares: the HTTP client (cache, gate), the corpus, the sandbox and the
 * limiters. Built once; the HTTP transport builds an MCP server per request on top of it.
 */
export async function buildSupervisor(cfg: SupervisorConfig): Promise<CatalogDeps> {
  const sourceCfg: SourceConfig = {
    baseUrl: cfg.baseUrl ?? DEFAULT_BASE_URL,
    userAgent: cfg.userAgent, timeoutMs: cfg.upstreamTimeoutMs, retries: cfg.upstreamRetries,
    cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
    gate: upstreamGate(cfg),
    ...(cfg.maxResponseBytes ? { maxResponseBytes: cfg.maxResponseBytes } : {}),
    ...(cfg.dispatcher ? { dispatcher: cfg.dispatcher } : {}),
  };
  const sources = getSources(sourceCfg);
  const sdk = sdkFromSources(sources);
  const corpus = buildCorpus(sources);
  const tools = cfg.tools ?? 'all';
  // Docs-only serving never touches a sandbox.
  const sandbox = tools === 'all' ? await pickSandbox(cfg.sandbox, { processIsolation: cfg.processIsolation }) : undefined;
  return {
    sdk, corpus, tools,
    ...(sandbox ? { sandbox } : {}),
    executionLimiter: new ExecutionLimiter(
      cfg.maxConcurrentExecutions ?? EXECUTION_DEFAULTS.maxConcurrent,
      cfg.maxExecutionsPerSubject ?? EXECUTION_DEFAULTS.perSubject,
    ),
    ...(cfg.shutdownSignal ? { shutdownSignal: cfg.shutdownSignal } : {}),
    callBudgets: { ctgov: cfg.maxCallsPerExecute ?? DEFAULT_CALL_BUDGET },
    subjectQuotas: { ctgov: new SubjectQuota(cfg.subjectRatePerHour ?? SUBJECT_RATE_PER_HOUR_DEFAULT, 60 * 60 * 1000) },
  };
}

/** Production defaults for everything the environment does not set (bin.ts maps the environment). */
export const SUPERVISOR_DEFAULTS = {
  userAgent: USER_AGENT,
  upstreamTimeoutMs: 20_000,
  upstreamRetries: 3,
  cacheTtlMs: 300_000,
  cacheMaxItems: 500,
  sandbox: 'auto',
} as const satisfies Partial<SupervisorConfig>;

export function resolveSupervisorConfig(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return { ...SUPERVISOR_DEFAULTS, ...overrides };
}
