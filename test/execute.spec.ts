import { describe, it, expect } from 'vitest';
import { execute, DEFAULT_CALL_BUDGET, ExecuteInput } from '../src/tools/execute.js';
import { SubjectQuota } from '../src/util/quotas.js';
import { ExecutionLimiter } from '../src/util/executionLimiter.js';
import type { SandboxRunner, ExecuteOptions, RpcBridge } from '../src/sandbox/types.js';

// A fake runner that issues `ctgov` dispatches, plus calls to other bindings, returning the results
// separately so tests can assert budget and quota behavior.
function fakeRunner(calls: number, extra: string[] = []): SandboxRunner {
  return {
    kind: 'unavailable',
    available: async () => true,
    async execute(_opts: ExecuteOptions, rpc: RpcBridge) {
      const ctgov: unknown[] = [];
      const other: unknown[] = [];
      for (let i = 0; i < calls; i++) ctgov.push(await rpc.dispatch({ binding: 'ctgov', path: ['studies', 'search'], args: [{}] }));
      for (const b of extra) other.push(await rpc.dispatch({ binding: b, path: ['x'], args: [] }));
      return { ok: true, value: { ctgov, other }, logs: [], durationMs: 0 };
    },
  };
}

const sdk = {
  clients: {} as Record<string, object>,
  methods: { ctgov: { 'studies.search': async () => ({ studies: [] }) } },
  meta: [{ name: 'ctgov', label: 'ClinicalTrials.gov', enabled: true }],
  registeredNames: ['ctgov'],
};

type R = { ok: boolean; error?: { name: string; message?: string } };
type Out = { value: { ctgov: R[]; other: R[] } };
const input = ExecuteInput.parse({ code: 'return 1' });

describe('execute input defaults', () => {
  it('needs only code; timeout 15 s, memory 64 MB, ceiling 60 s', () => {
    expect(input).toMatchObject({ timeoutMs: 15_000, memoryMb: 64 });
    expect(ExecuteInput.safeParse({ code: 'x', timeoutMs: 60_001 }).success).toBe(false);
    expect(ExecuteInput.safeParse({ code: 'x', timeoutMs: 60_000 }).success).toBe(true);
    expect(ExecuteInput.safeParse({ code: '' }).success).toBe(false);
  });
});

describe('per-execute call budgets', () => {
  it('stops a program at the budget, with a CallBudgetExceeded the program can read', async () => {
    const res = await execute(input, { sdk, sandbox: fakeRunner(5), callBudgets: { ctgov: 3 } }) as Out;
    expect(res.value.ctgov.filter(r => r.ok).length).toBe(3);
    expect(res.value.ctgov.filter(r => r.error?.name === 'CallBudgetExceeded').length).toBe(2);
    expect(res.value.ctgov.at(-1)!.error!.message).toContain('(3)');
  });

  it('has a default budget of 100 for a binding without one', async () => {
    expect(DEFAULT_CALL_BUDGET).toBe(100);
    const res = await execute(input, { sdk, sandbox: fakeRunner(0, ['ghost']), callBudgets: {} }) as Out;
    expect(res.value.other[0]).toMatchObject({ ok: false, error: { name: 'TypeError' } }); // unknown binding: dispatched, then refused
  });

  it('a budget is per execution: a second execute starts again', async () => {
    const deps = { sdk, sandbox: fakeRunner(2), callBudgets: { ctgov: 2 } };
    for (let i = 0; i < 2; i++) expect(((await execute(input, deps)) as Out).value.ctgov.every(r => r.ok)).toBe(true);
  });
});

describe('per-subject quotas', () => {
  it('blocks a subject past its hourly quota', async () => {
    const deps = { sdk, sandbox: fakeRunner(4), callBudgets: { ctgov: 100 }, subjectQuotas: { ctgov: new SubjectQuota(2, 3_600_000) } };
    const res = await execute(input, deps, { subject: 'tenant-1' }) as Out;
    expect(res.value.ctgov.filter(r => r.ok).length).toBe(2);
    expect(res.value.ctgov.filter(r => r.error?.name === 'SubjectQuotaExceeded').length).toBe(2);
  });

  it('does not consult the per-subject quota when there is no subject (stdio)', async () => {
    const deps = { sdk, sandbox: fakeRunner(4), callBudgets: { ctgov: 100 }, subjectQuotas: { ctgov: new SubjectQuota(1, 3_600_000) } };
    expect(((await execute(input, deps)) as Out).value.ctgov.every(r => r.ok)).toBe(true);
  });

  it('never applies the hourly quota to an anonymous client address (--insecure)', async () => {
    const deps = { sdk, sandbox: fakeRunner(4), callBudgets: { ctgov: 100 }, subjectQuotas: { ctgov: new SubjectQuota(1, 3_600_000) } };
    expect(((await execute(input, deps, { client: 'ip:203.0.113.9' })) as Out).value.ctgov.every(r => r.ok)).toBe(true);
  });

  it('keeps tenants separate', async () => {
    const quota = new SubjectQuota(1, 3_600_000);
    const deps = { sdk, sandbox: fakeRunner(1), callBudgets: { ctgov: 100 }, subjectQuotas: { ctgov: quota } };
    expect(((await execute(input, deps, { subject: 'a' })) as Out).value.ctgov[0]!.ok).toBe(true);
    expect(((await execute(input, deps, { subject: 'b' })) as Out).value.ctgov[0]!.ok).toBe(true);
    expect(((await execute(input, deps, { subject: 'a' })) as Out).value.ctgov[0]!.ok).toBe(false);
  });
});

describe('cancellation before start', () => {
  it('does not start an execution when shutdown or the request is already aborted', async () => {
    let started = false;
    const sandbox = { kind: 'unavailable' as const, available: async () => true, async execute() { started = true; return { ok: true, value: 1, logs: [], durationMs: 0 }; } };
    const shut = new AbortController(); shut.abort();
    expect(await execute(input, { sdk, sandbox, callBudgets: {}, shutdownSignal: shut.signal })).toMatchObject({ ok: false, error: { name: 'AbortError' } });
    const req = new AbortController(); req.abort();
    expect(await execute(input, { sdk, sandbox, callBudgets: {} }, { signal: req.signal })).toMatchObject({ ok: false, error: { name: 'AbortError' } });
    expect(started).toBe(false);
  });
});

describe('sandbox teardown quarantine', () => {
  it('keeps the execution slot until a lingering sandbox process has exited', async () => {
    const { ExecutionLimiter } = await import('../src/util/executionLimiter.js');
    const { TEARDOWN } = await import('../src/sandbox/types.js');
    let exited!: () => void;
    const gone = new Promise<void>(r => { exited = r; });
    const lingering = { kind: 'unavailable' as const, available: async () => true,
      async execute() { return Object.defineProperty({ ok: true, value: 1, logs: [], durationMs: 0 }, TEARDOWN, { value: gone }); } };
    const limiter = new ExecutionLimiter(1, 1);
    expect(await execute(input, { sdk, sandbox: lingering, callBudgets: {}, executionLimiter: limiter })).toMatchObject({ ok: true });
    expect(limiter.tryAcquire()).toMatchObject({ error: expect.any(String) }); // still quarantined
    exited();
    await new Promise(r => setTimeout(r, 0));
    expect('release' in limiter.tryAcquire()).toBe(true);
  });
});

describe('execution admission', () => {
  const hanging = (): SandboxRunner => ({ kind: 'unavailable', available: async () => true, execute: () => new Promise(() => {}) });
  const finishing = (): SandboxRunner => ({ kind: 'unavailable', available: async () => true, execute: async () => ({ ok: true, value: 1, logs: [], durationMs: 0 }) });

  it('answers Busy past the per-subject cap and releases the slot when a run ends', async () => {
    const limiter = new ExecutionLimiter(8, 1);
    void execute(input, { sdk, sandbox: hanging(), callBudgets: {}, executionLimiter: limiter }, { subject: 'a' });
    await new Promise(r => setTimeout(r, 0));
    expect(await execute(input, { sdk, sandbox: finishing(), callBudgets: {}, executionLimiter: limiter }, { subject: 'a' })).toMatchObject({ ok: false, error: { name: 'Busy' } });
    expect(await execute(input, { sdk, sandbox: finishing(), callBudgets: {}, executionLimiter: limiter }, { subject: 'b' })).toMatchObject({ ok: true });
    expect(await execute(input, { sdk, sandbox: finishing(), callBudgets: {}, executionLimiter: limiter }, { subject: 'b' })).toMatchObject({ ok: true });
  });

  it('counts anonymous callers per client address, and refuses past the global cap', async () => {
    const limiter = new ExecutionLimiter(3, 1);
    for (const client of ['ip:1.1.1.1', 'ip:2.2.2.2']) void execute(input, { sdk, sandbox: hanging(), callBudgets: {}, executionLimiter: limiter }, { client });
    await new Promise(r => setTimeout(r, 0));
    const run = (client: string) => execute(input, { sdk, sandbox: finishing(), callBudgets: {}, executionLimiter: limiter }, { client });
    expect(await run('ip:1.1.1.1')).toMatchObject({ ok: false, error: { name: 'Busy' } });
    expect(await run('ip:3.3.3.3')).toMatchObject({ ok: true });
    void execute(input, { sdk, sandbox: hanging(), callBudgets: {}, executionLimiter: limiter }, { client: 'ip:3.3.3.3' });
    await new Promise(r => setTimeout(r, 0));
    expect(await run('ip:4.4.4.4')).toMatchObject({ ok: false, error: { name: 'Busy', message: expect.stringContaining('maximum of 3') } });
  });
});

describe('an asynchronous per-subject limiter (account mode counts in PostgreSQL)', () => {
  const ctx = { subject: 'alice' };
  it('refuses calls with a fixed error when the limiter cannot answer, never letting them through', async () => {
    const broken = { consume: async () => { throw new Error('connection refused to db.internal:5432'); } };
    const res = await execute(input, { sdk, sandbox: fakeRunner(1), callBudgets: {}, subjectQuotas: { ctgov: broken } }, ctx) as Out & { value: { ctgov: (R & { error: { message: string } })[] } };
    expect(res.value.ctgov[0]).toMatchObject({ ok: false, error: { name: 'QuotaUnavailable' } });
    expect(JSON.stringify(res)).not.toContain('db.internal');
  });
  it('applies the verdict: allowed through, refused with the reset time', async () => {
    let n = 0;
    const limiter = { consume: async () => ({ allowed: ++n <= 1, resetAt: Date.UTC(2030, 0, 1) }) };
    const res = await execute(input, { sdk, sandbox: fakeRunner(2), callBudgets: {}, subjectQuotas: { ctgov: limiter } }, ctx) as Out;
    expect(res.value.ctgov.map(r => r.ok)).toEqual([true, false]);
    expect(res.value.ctgov[1]).toMatchObject({ error: { name: 'SubjectQuotaExceeded', message: expect.stringContaining('2030-01-01') } });
  });
  it('still enforces the call budget on parallel calls while the limiter awaits', async () => {
    const slow = { consume: async () => { await new Promise(r => setTimeout(r, 20)); return { allowed: true, resetAt: 0 }; } };
    const parallel: SandboxRunner = {
      kind: 'unavailable', available: async () => true,
      async execute(_o: ExecuteOptions, rpc: RpcBridge) {
        const all = await Promise.all(Array.from({ length: 6 }, () => rpc.dispatch({ binding: 'ctgov', path: ['studies', 'search'], args: [{}] })));
        return { ok: true, value: all, logs: [], durationMs: 0 };
      },
    };
    const res = await execute(input, { sdk, sandbox: parallel, callBudgets: { ctgov: 3 }, subjectQuotas: { ctgov: slow } }, ctx) as { value: R[] };
    expect(res.value.filter(r => r.ok)).toHaveLength(3);
    expect(res.value.filter(r => r.error?.name === 'CallBudgetExceeded')).toHaveLength(3);
  });
});
