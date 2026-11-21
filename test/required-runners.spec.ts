import { describe, it, expect } from 'vitest';
import { IsolateRunner } from '../src/sandbox/isolate.js';
import { DenoRunner } from '../src/sandbox/deno.js';

/**
 * Sandbox and database tests skip when their dependency is missing, which is right on a laptop and wrong in CI: a green
 * run must mean they ran. CI sets CTGOV_REQUIRE_RUNNERS=1.
 */
describe.runIf(process.env.CTGOV_REQUIRE_RUNNERS === '1')('required test dependencies (CI)', () => {
  it('TEST_DATABASE_URL is set, so account integration tests run', () => { expect(process.env.TEST_DATABASE_URL).toBeTruthy(); });
  it('isolated-vm is available', async () => { expect(await new IsolateRunner().available()).toBe(true); });
  it('Deno is available', async () => { expect(await new DenoRunner().available()).toBe(true); });
});
