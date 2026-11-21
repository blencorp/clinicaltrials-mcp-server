import { describe, it, expect } from 'vitest';
import { execute as executeTool, ExecuteInput, type RequestCtx } from '../src/tools/execute.js';
import type { CatalogDeps } from '../src/server/toolCatalog.js';
import { buildSupervisor, type SupervisorConfig } from '../src/supervisor/index.js';
import { IsolateRunner } from '../src/sandbox/isolate.js';
import { DenoRunner } from '../src/sandbox/deno.js';
import type { SandboxKind } from '../src/sandbox/types.js';
import { loopback, until, supervisorCfg } from './helpers.js';

const execute = (i: ReturnType<typeof ExecuteInput.parse>, d: CatalogDeps, c?: RequestCtx) => executeTool(i, { ...d, sandbox: d.sandbox! }, c);

// Cancellation, deadlines, call budgets and admission, through the real supervisor and a real
// runner, against a real loopback server (MockAgent ignores aborts during delays).
type Case = [SandboxKind, IsolateRunner | DenoRunner];
describe.each<Case>([['isolate', new IsolateRunner()], ['deno', new DenoRunner()]])('%s execution control', (kind, runner) => {
  const setup = async (extra: Partial<SupervisorConfig> = {}, handler: Parameters<typeof loopback>[0] = () => {}) => {
    const lb = await loopback(handler);
    const deps = await buildSupervisor(supervisorCfg({ baseUrl: lb.baseUrl, sandbox: kind, ...extra }));
    return { lb, deps };
  };
  const input = (code: string, extra: Record<string, unknown> = {}) => ExecuteInput.parse({ code, ...extra });
  const version = '{"apiVersion":"2.0"}';

  it('a client cancellation ends the run, closes the upstream request and frees the slot', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { lb, deps } = await setup({ maxConcurrentExecutions: 1, maxExecutionsPerSubject: 1 });
    try {
      const ctl = new AbortController();
      const pending = execute(input('return await ctgov.version()', { timeoutMs: 30_000 }), deps, { subject: 'a', signal: ctl.signal });
      await until(() => lb.requests.length === 1);
      ctl.abort();
      const res = await pending;
      expect(res).toMatchObject({ ok: false, error: { name: 'AbortError' } });
      await until(() => lb.aborted() === 1);
      // The slot is free again once the run (and its sandbox process) is gone.
      await until(() => 'release' in (deps.executionLimiter!.tryAcquire('a') as object) && true);
    } finally { await lb.close(); }
  });

  it('the host deadline ends a run waiting on the upstream, and the upstream request is cancelled', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { lb, deps } = await setup();
    try {
      const t0 = Date.now();
      const res = await execute(input('return await ctgov.version()', { timeoutMs: 400 }), deps);
      expect(res).toMatchObject({ ok: false, error: { name: 'TimeoutError' } });
      expect(Date.now() - t0).toBeLessThan(3000);
      await until(() => lb.aborted() === 1);
    } finally { await lb.close(); }
  });

  it('server shutdown aborts a running execution and its upstream request', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const shutdown = new AbortController();
    const { lb, deps } = await setup({ shutdownSignal: shutdown.signal });
    try {
      const pending = execute(input('return await ctgov.version()', { timeoutMs: 30_000 }), deps);
      await until(() => lb.requests.length === 1);
      shutdown.abort();
      expect(await pending).toMatchObject({ ok: false, error: { name: 'AbortError' } });
      await until(() => lb.aborted() === 1);
      // New runs are refused while shutting down.
      expect(await execute(input('return 1'), deps)).toMatchObject({ ok: false, error: { name: 'AbortError', message: expect.stringContaining('shutting down') } });
    } finally { await lb.close(); }
  });

  it('a call budget stops further upstream calls, and the program sees CallBudgetExceeded', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { lb, deps } = await setup({ maxCallsPerExecute: 3 }, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(version); });
    try {
      const res = await execute(input('const out = []; for (let i = 0; i < 5; i++) { try { await ctgov.studies.get("NCT0000000" + i); out.push("ok"); } catch (e) { out.push(e.name); } } return out;'), deps);
      expect(res).toMatchObject({ ok: true, value: ['ok', 'ok', 'ok', 'CallBudgetExceeded', 'CallBudgetExceeded'] });
      expect(lb.requests).toHaveLength(3);
    } finally { await lb.close(); }
  });

  it('Promise.all over a full call budget is allowed (pending-call cap matches the budget)', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { lb, deps } = await setup({ upstreamRatePerSec: 100_000 }, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(version); });
    try {
      const res = await execute(input('const r = await Promise.all(Array.from({ length: 100 }, (_, i) => ctgov.studies.get("NCT" + String(i).padStart(8, "0")))); return r.length;', { timeoutMs: 30_000 }), deps);
      expect(res, JSON.stringify(res)).toMatchObject({ ok: true, value: 100 });
      expect(lb.requests).toHaveLength(100);
    } finally { await lb.close(); }
  });

  it('refuses a second concurrent execution of one caller, and anonymous callers are counted per address', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { lb, deps } = await setup({ maxConcurrentExecutions: 8, maxExecutionsPerSubject: 1 });
    try {
      const slow = () => execute(input('return await ctgov.version()', { timeoutMs: 30_000 }), deps, { client: 'ip:198.51.100.7' });
      const first = slow();
      await until(() => lb.requests.length === 1);
      expect(await slow()).toMatchObject({ ok: false, error: { name: 'Busy' } });
      // A different address is a different caller.
      const other = execute(input('return 1'), deps, { client: 'ip:198.51.100.8' });
      expect(await other).toMatchObject({ ok: true, value: 1 });
      // Finish the first by closing its upstream request.
      await lb.close();
      await first;
    } finally { await lb.close().catch(() => {}); }
  });

  it('hourly quota applies to an authenticated subject only', async ({ skip }) => {
    if (!(await runner.available())) return skip();
    const { lb, deps } = await setup({ subjectRatePerHour: 2 }, (_req, res) => { res.setHeader('content-type', 'application/json'); res.end(version); });
    try {
      const code = 'const out = []; for (let i = 0; i < 4; i++) { try { await ctgov.studies.get("NCT0000000" + i); out.push("ok"); } catch (e) { out.push(e.name); } } return out;';
      expect(await execute(input(code), deps, { subject: 'alice' })).toMatchObject({ value: ['ok', 'ok', 'SubjectQuotaExceeded', 'SubjectQuotaExceeded'] });
      expect(await execute(input(code), deps, { client: 'ip:1.2.3.4' })).toMatchObject({ value: ['ok', 'ok', 'ok', 'ok'] });
    } finally { await lb.close(); }
  });
});

describe('supervisor construction', () => {
  it('docs-only never resolves a sandbox', async () => {
    const deps = await buildSupervisor(supervisorCfg({ tools: 'docs-only', sandbox: 'deno' }));
    expect(deps.sandbox).toBeUndefined();
    expect(deps.tools).toBe('docs-only');
  });

  it('shares one gate between every request: the HTTP client is built once', async () => {
    const lb = await loopback((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{}'); });
    try {
      const deps = await buildSupervisor(supervisorCfg({ baseUrl: lb.baseUrl, tools: 'docs-only', cacheTtlMs: 60_000, cacheMaxItems: 10 }));
      const method = deps.sdk.methods.ctgov!['version']!;
      await method(); await method();
      expect(lb.requests).toHaveLength(1); // the second call was served from the shared cache
    } finally { await lb.close(); }
  });
});
