// The published CLI, as users run it: `node dist/bin.js` over stdio. Needs `pnpm build` first
// (CI builds before testing); locally the file is skipped when dist/ is absent, in CI it fails.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
const built = existsSync(BIN);
if (!built && process.env.CI) throw new Error("dist/bin.js is missing: run `pnpm build` before `pnpm test` in CI");

interface Run {
  frames: Array<Record<string, any>>;
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Spawns the CLI, writes one JSON-RPC message per entry as soon as the previous reply arrives, then closes stdin. */
function stdioSession(requests: Array<Record<string, unknown>>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, CTGOV_LOG_LEVEL: "warn" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let next = 0;
    const send = () => {
      const msg = requests[next++];
      if (!msg) return void child.stdin.end(); // clean shutdown: stdin closes
      child.stdin.write(`${JSON.stringify(msg)}\n`);
      if (!("id" in msg)) send(); // notifications get no reply
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`CLI did not finish: stdout=${stdout} stderr=${stderr}`));
    }, 15_000);
    child.stdout.on("data", (d: Buffer) => {
      const before = stdout.split("\n").length;
      stdout += d.toString();
      if (stdout.split("\n").length > before) send();
    });
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const frames = stdout.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
      resolve({ frames, stdout, stderr, code, signal });
    });
    send();
  });
}

describe.skipIf(!built)("built CLI over stdio (dist/bin.js)", () => {
  it("initializes, lists tools, calls a tool, speaks only JSON-RPC on stdout and exits 0 when stdin closes", async () => {
    const run = await stdioSession([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cli-test", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "search_api", arguments: { query: "recruiting studies by condition", k: 2 } } },
    ]);
    // stdout carries nothing but JSON-RPC response frames (every line parsed in stdioSession).
    for (const f of run.frames) expect(f.jsonrpc).toBe("2.0");
    expect(run.frames.map((f) => f.id)).toEqual([1, 2, 3]);
    expect(run.frames[0]!.result.serverInfo.name).toBe("clinicaltrials-mcp-server");
    expect(run.frames[1]!.result.tools.map((t: { name: string }) => t.name)).toEqual(["search_api", "describe_schema", "execute"]);
    const call = run.frames[2]!.result;
    expect(call.isError).toBeFalsy();
    expect(JSON.parse(call.content[0].text).hits).toHaveLength(2);
    expect(run.signal).toBeNull();
    expect(run.code).toBe(0);
  });

  it("keeps logs on stderr, never stdout", async () => {
    const run = await stdioSession([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "cli-test", version: "0" } } },
    ]);
    expect(run.stdout).not.toMatch(/"level"/);
  });

  it("--version and --help print to stdout and exit 0", () => {
    for (const flag of ["--version", "--help"]) {
      const r = spawnSync(process.execPath, [BIN, flag], { encoding: "utf8" });
      expect(r.status, flag).toBe(0);
      expect(r.stdout).toContain("clinicaltrial");
    }
  });
});

// Hosting modes exclude each other (BIN is the built CLI). Every refusal happens before anything
// is bound, so none of these needs a database.
describe.skipIf(!built)("hosting-mode precedence with CTGOV_AUTH_PROVIDER=accounts", () => {
  const ACCOUNTS = {
    CTGOV_AUTH_PROVIDER: "accounts", CTGOV_PUBLIC_ORIGIN: "https://ctgov.example.com", BETTER_AUTH_SECRET: "x".repeat(32),
    DATABASE_URL: "postgres://u:p@127.0.0.1:1/none", GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret",
  };
  const run = (args: string[], env: Record<string, string> = ACCOUNTS) =>
    spawnSync(process.execPath, [BIN, ...args], { encoding: "utf8", env: { ...process.env, CTGOV_LOG_LEVEL: "error", ...env }, timeout: 15_000 });

  it.each([["--public-docs"], ["--insecure"]])("%s with accounts is a startup error", (flag) => {
    const r = run(["--http", flag]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`${flag} cannot be combined with CTGOV_AUTH_PROVIDER=accounts`);
  });
  it("accounts without --http is a startup error", () => {
    const r = run([]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("CTGOV_AUTH_PROVIDER=accounts needs --http");
  });
  it("refuses the isolate sandbox and incomplete configuration before binding", () => {
    const isolate = run(["--http", "--sandbox", "isolate", "--port", "0"]);
    expect(isolate.status).toBe(1);
    expect(isolate.stderr).toMatch(/isolate sandbox .* not allowed in account mode/);
    const missing = run(["--http", "--port", "0"], { ...ACCOUNTS, GOOGLE_CLIENT_SECRET: "" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Missing configuration: GOOGLE_CLIENT_SECRET");
  });
  it("--public-docs with another auth provider stays refused", () => {
    const withProvider = run(["--http", "--public-docs"], { CTGOV_AUTH_PROVIDER: "clerk", CTGOV_PUBLIC_ORIGIN: "https://ctgov.example.com" });
    expect(withProvider.status).toBe(1);
    expect(withProvider.stderr).toContain("cannot be combined with CTGOV_AUTH_PROVIDER=clerk");
  });
});
