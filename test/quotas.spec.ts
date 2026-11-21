import { describe, it, expect } from 'vitest';
import { SubjectQuota } from '../src/util/quotas.js';
import { ExecutionLimiter } from '../src/util/executionLimiter.js';

describe('SubjectQuota', () => {
  it('allows up to the limit then blocks within the window', () => {
    const q = new SubjectQuota(2, 60_000);
    expect(q.consume('s1').allowed).toBe(true);
    expect(q.consume('s1').allowed).toBe(true);
    expect(q.consume('s1').allowed).toBe(false);
  });
  it('tracks subjects independently', () => {
    const q = new SubjectQuota(1, 60_000);
    expect(q.consume('a').allowed).toBe(true);
    expect(q.consume('b').allowed).toBe(true);
    expect(q.consume('a').allowed).toBe(false);
  });
});

describe('ExecutionLimiter', () => {
  it('caps globally and per subject, and release frees a slot once', () => {
    const l = new ExecutionLimiter(2, 1);
    const a = l.tryAcquire('a');
    expect('release' in a).toBe(true);
    expect(l.tryAcquire('a')).toMatchObject({ error: expect.stringContaining('1 executions') });
    const b = l.tryAcquire('b');
    expect('release' in b).toBe(true);
    expect(l.tryAcquire('c')).toMatchObject({ error: expect.stringContaining('maximum of 2') });
    (a as { release(): void }).release();
    (a as { release(): void }).release(); // idempotent: must not free a second slot
    expect('release' in l.tryAcquire('c')).toBe(true);
    expect(l.tryAcquire('d')).toMatchObject({ error: expect.any(String) });
  });
});
