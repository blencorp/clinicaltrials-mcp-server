import { expect, test } from 'vitest';
import { DigestGate } from '../src/accounts/digest-gate.js';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

test('permits are granted at once only while free and nobody is queued', async () => {
  let limit = 2;
  const gate = new DigestGate(() => limit, 10, 100);
  expect(await gate.acquire('k')).toBe('granted');
  expect(await gate.acquire('k')).toBe('granted');
  const third = gate.acquire('k');
  expect(gate.queued).toBe(1);
  // A new arrival never bypasses a non-empty queue, even when a permit is free.
  gate.release('k');
  limit = 3;
  expect(await third).toBe('granted');
  expect(await gate.acquire('k')).toBe('granted');
});

test('simultaneous releases hand permits over in strict arrival order, never over-granting', async () => {
  const gate = new DigestGate(() => 2, 10, 100);
  await gate.acquire('k');
  await gate.acquire('k');
  const order: number[] = [];
  const waiters = [1, 2, 3, 4, 5].map((n) =>
    gate.acquire('k').then((outcome) => {
      order.push(n);
      return outcome;
    }),
  );
  expect(gate.queued).toBe(5);
  // Both holders release in the same turn: exactly two waiters (the oldest) are granted.
  gate.release('k');
  gate.release('k');
  await flush();
  expect(order).toEqual([1, 2]);
  expect(gate.queued).toBe(3);
  // A new arrival queues behind the rest; a release grants the oldest, not the newcomer.
  const late = gate.acquire('k').then(() => order.push(6));
  gate.release('k');
  await flush();
  expect(order).toEqual([1, 2, 3]);
  for (let i = 0; i < 3; i++) {
    gate.release('k');
    await flush();
  }
  expect(order).toEqual([1, 2, 3, 4, 5, 6]);
  expect(await Promise.all(waiters)).toEqual(Array(5).fill('granted'));
  await late;
});

test('the queue is bounded per key and overall, and credits come back', async () => {
  const gate = new DigestGate(() => 1, 2, 3);
  await gate.acquire('a');
  await gate.acquire('b');
  const queued = [gate.acquire('a'), gate.acquire('a'), gate.acquire('b')];
  expect(await gate.acquire('a'), 'per-key cap').toBe('busy');
  expect(await gate.acquire('b'), 'global cap').toBe('busy');
  gate.settle('a');
  expect(await Promise.all(queued.slice(0, 2))).toEqual(['settled', 'settled']);
  expect(gate.queued).toBe(1);
  gate.release('b');
  expect(await queued[2]).toBe('granted');
  gate.release('b');
  gate.release('a');
  expect(gate.queued).toBe(0);
  expect(gate.digests).toBe(0);
});

test('a terminal release settles the whole queue, strands nothing and deletes the entry', async () => {
  const gate = new DigestGate(() => 1, 100, 100);
  await gate.acquire('k');
  const waiting = Array.from({ length: 50 }, () => gate.acquire('k'));
  gate.release('k', true);
  expect([...new Set(await Promise.all(waiting))]).toEqual(['settled']);
  expect(gate.digests).toBe(0);
  expect(gate.queued).toBe(0);
  // The whole capacity is reusable.
  expect(await gate.acquire('k')).toBe('granted');
});

test('settle leaves permits held, so the entry lives until they are released', async () => {
  const gate = new DigestGate(() => 2, 10, 10);
  await gate.acquire('k');
  await gate.acquire('k');
  const waiting = gate.acquire('k');
  gate.settle('k');
  expect(await waiting).toBe('settled');
  expect(gate.digests).toBe(1);
  gate.release('k');
  gate.release('k');
  expect(gate.digests).toBe(0);
});
