import { createServer } from 'node:http';
import { Pool } from 'pg';
import type { Dispatcher } from 'undici';
import { buildSupervisor, resolveSupervisorConfig, type SupervisorConfig } from '../supervisor/index.js';
import type { CatalogDeps } from '../server/toolCatalog.js';
import type { HttpHandle } from '../server/http.js';
import type { SandboxKind } from '../sandbox/types.js';
import type { SubjectLimiter } from '../util/quotas.js';
import { logger } from '../util/logger.js';
import { createAccountApp } from './app.js';
import { personalOwner, Store } from './store.js';
import type { AccountConfig } from './config.js';
import { SUBJECT_RATE_PER_HOUR_DEFAULT } from '../supervisor/index.js';

/**
 * The signed-in hourly limit: per account, in PostgreSQL, so it holds across replicas and
 * restarts. It replaces the in-memory per-subject quota; the per-subject execution limiter and
 * the process-wide upstream gate stay as built by buildSupervisor.
 */
export class AccountQuota implements SubjectLimiter {
  constructor(private readonly store: Store, private readonly perHour: number) {}
  consume(subject: string) {
    return this.store.consume(`ctgov:${personalOwner(subject)}`, this.perHour, 3600);
  }
}

/** The signed-in endpoint's catalog: everything, with the account hourly limit in PostgreSQL. */
export function accountDependencies(deps: CatalogDeps, store: Store, perHour = SUBJECT_RATE_PER_HOUR_DEFAULT): CatalogDeps {
  return { ...deps, subjectQuotas: { ctgov: new AccountQuota(store, perHour) } };
}

/**
 * The anonymous endpoint's catalog: documentation tools only. With nothing to identify the
 * caller, running code would spend the shared ClinicalTrials.gov budget for anyone on the
 * internet, so `execute` is not registered: a direct call fails as an unknown tool. Signed-in
 * users get it at ACCOUNT_MCP_PATH.
 */
export function publicDependencies(deps: CatalogDeps): CatalogDeps {
  return { ...deps, tools: 'docs-only' };
}

export interface AccountServerOptions {
  port: number;
  host: string;
  config: AccountConfig;
  /** CLI choice; `isolate` is refused (account mode runs many users' code in one process). */
  sandboxMode?: SandboxKind;
  supervisor?: Partial<SupervisorConfig>;
  dispatcher?: Dispatcher;
}

export async function startAccountHttp(opts: AccountServerOptions): Promise<HttpHandle> {
  const { config } = opts;
  if (opts.sandboxMode === 'isolate') {
    throw new Error('the isolate sandbox (--sandbox isolate / CTGOV_SANDBOX=isolate) is not allowed in account mode; use deno');
  }
  const shutdown = new AbortController();
  const cfg = resolveSupervisorConfig({
    ...opts.supervisor, tools: 'all', processIsolation: true, shutdownSignal: shutdown.signal,
    ...(opts.sandboxMode ? { sandbox: opts.sandboxMode } : {}),
    ...(opts.dispatcher ? { dispatcher: opts.dispatcher } : {}),
  });
  const deps = await buildSupervisor(cfg);
  if (deps.sandbox?.kind !== 'deno') {
    logger.warn('http.deno_missing', { note: 'account mode runs execute only in Deno and Deno is not available: every execute call will fail' });
  }
  const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
  pool.on('error', () => logger.error('account.database_error'));
  const store = new Store(pool);
  let service: Awaited<ReturnType<typeof createAccountApp>> | undefined;
  try {
    await store.initialize();
    service = await createAccountApp(
      config, store, accountDependencies(deps, store, cfg.subjectRatePerHour), publicDependencies(deps),
    );
    const server = createServer(service.app);
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(opts.port, opts.host, resolve); });
    const cleanup = setInterval(() => { void store.cleanup().catch(() => logger.error('account.cleanup_failed')); }, 60_000);
    cleanup.unref();
    const port = (server.address() as { port: number }).port;
    logger.info('server.ready', { transport: 'http', host: opts.host, port, executor: deps.sandbox?.kind ?? 'none', auth: 'accounts', tools: 'all' });
    return {
      port, host: opts.host,
      close: async () => {
        clearInterval(cleanup);
        shutdown.abort();
        await service!.close();
        await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
        await pool.end();
      },
    };
  } catch (error) {
    shutdown.abort();
    await service?.close();
    await pool.end();
    throw error;
  }
}
