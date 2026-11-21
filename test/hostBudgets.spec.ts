import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DenoRunner } from '../src/sandbox/deno.js';
import { DEFAULT_LIMITS } from '../src/sandbox/limits.js';

// The host must not trust the sandbox process. These tests replace `deno` on PATH with a script
// that misbehaves like a compromised supervisor would: forged frames, results and logs over the
// budget, unbounded output. The real runner's in-sandbox budgets cannot be reached this way, so the
// host-side checks are pinned on their own.
const posix = process.platform !== 'win32';
let dir: string;
let savedPath: string | undefined;

const T = 'a'.repeat(64);
function fakeDeno(scenario: string): void {
  writeFileSync(join(dir, 'scenario.sh'), scenario);
}

beforeAll(() => {
  if (!posix) return;
  dir = mkdtempSync(join(tmpdir(), 'ctgov-fake-deno-'));
  writeFileSync(join(dir, 'deno'), `#!/bin/bash
if [ "$1" = "--version" ]; then echo "deno 2.0.0"; exit 0; fi
echo "CTGOV-SANDBOX ${T}"
. "$(dirname "$0")/scenario.sh"
`);
  chmodSync(join(dir, 'deno'), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${dir}:${savedPath ?? ''}`;
});
afterAll(() => {
  if (!posix) return;
  process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

const run = (limits = DEFAULT_LIMITS, extra: Record<string, unknown> = {}) =>
  new DenoRunner(limits).execute({ code: 'return 1', bindings: [], timeoutMs: 800, ...extra }, { dispatch: async () => ({ ok: true }) });

describe.runIf(posix)('host-side budgets against a hostile sandbox process', () => {
  it('treats lines without the frame token as log text, never as frames', async () => {
    fakeDeno(`echo '{"t":"done","ok":true,"json":"999"}'
echo 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb{"t":"done","ok":true,"json":"999"}'
sleep 5`);
    const res = await run();
    expect(res).toMatchObject({ ok: false, error: { name: 'TimeoutError' } });
    expect(res.logs).toHaveLength(2);
    expect(res.logs[0]).toContain('"json":"999"');
  });

  it('rejects an oversized result even when the sandbox claims it fits', async () => {
    fakeDeno(`json=$(head -c 300000 /dev/zero | tr '\\0' 'x')
echo '${T}{"t":"done","ok":true,"json":"'"$json"'"}'
sleep 5`);
    expect(await run()).toMatchObject({ ok: false, error: { name: 'ResultTooLarge' } });
  });

  it('bounds the logs the sandbox sends, by bytes and by lines', async () => {
    fakeDeno(`for i in $(seq 1 3000); do echo '${T}{"t":"log","text":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}'; done
echo '${T}{"t":"done","ok":true,"json":"1"}'
sleep 5`);
    const res = await run({ ...DEFAULT_LIMITS, maxLogBytes: 2000 });
    expect(res.ok).toBe(true);
    expect(res.logs.at(-1)).toBe('[logs truncated]');
    expect(res.logs.length).toBeLessThan(40);
    fakeDeno(`for i in $(seq 1 300); do echo '${T}{"t":"log","text":"x"}'; done
echo '${T}{"t":"done","ok":true,"json":"1"}'
sleep 5`);
    const many = await run({ ...DEFAULT_LIMITS, maxLogLines: 50 });
    expect(many.logs).toHaveLength(50);
    expect(many.logs.at(-1)).toBe('[logs truncated]');
  });

  it('stops reading a process that floods stdout, and a single frame that never ends', async () => {
    fakeDeno(`yes yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy`);
    expect(await run({ ...DEFAULT_LIMITS, maxStdoutBytes: 100_000 }, { timeoutMs: 5000 })).toMatchObject({ ok: false, error: { name: 'OutputTooLarge' } });
    fakeDeno(`head -c 2000000 /dev/zero | tr '\\0' 'z'; sleep 5`);
    expect(await run({ ...DEFAULT_LIMITS, maxFrameBytes: 100_000 }, { timeoutMs: 5000 })).toMatchObject({ ok: false, error: { name: 'OutputTooLarge' } });
  });

  it('rejects a malformed frame and an unexpected frame type, each ending the run', async () => {
    fakeDeno(`echo '${T}not json'; sleep 5`);
    expect(await run()).toMatchObject({ ok: false, error: { name: 'SandboxProtocolError' } });
    fakeDeno(`echo '${T}{"t":"bogus"}'; sleep 5`);
    expect(await run()).toMatchObject({ ok: false, error: { name: 'SandboxProtocolError' } });
  });
});
