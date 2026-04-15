import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { CtGovError } from "../supervisor/errors.js";
import { CTGOV_SDK_SHIM } from "../sdk/bindings.js";
import { validateUserCode } from "./policy.js";
import type {
  SandboxExecuteOptions,
  SandboxExecutor,
  SandboxLog,
  SandboxResult,
} from "./types.js";

/**
 * Deno subprocess sandbox. Runs with Deno's default no-permissions sandbox.
 * Communicates with the host via line-delimited JSON on stdin/stdout.
 */
export function isDenoAvailable(): boolean {
  // spawn('deno', ['-V']) synchronously is awkward; we do a best-effort at startup in selector.
  return resolveDenoPath() !== undefined;
}

function denoBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "deno.exe" : "deno";
}

function findOnPath(bin: string): string | undefined {
  const path = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const exeName = process.platform === "win32" && !bin.endsWith(".exe") ? `${bin}.exe` : bin;
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    try {
      const candidate = join(dir, exeName);
      if (existsSync(candidate)) return candidate;
    } catch {
      // ignore broken PATH entries
    }
  }
  return undefined;
}

function bundledTargetKeys(
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): string[] {
  const keys = [`${platform}-${arch}`];
  if (platform === "win32" && arch === "arm64") {
    keys.push("win32-x64");
  }
  return keys;
}

function resolveBundledDenoPath(
  root: string,
  platform: NodeJS.Platform = process.platform,
  arch = process.arch,
): string | undefined {
  for (const key of bundledTargetKeys(platform, arch)) {
    const candidate = join(root, key, denoBinaryName(platform));
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function resolveDenoPath(explicitPath?: string): string | undefined {
  for (const candidate of [explicitPath, process.env.CTGOV_DENO_PATH]) {
    if (!candidate) continue;
    if (existsSync(candidate)) return candidate;
    const onPath = findOnPath(candidate);
    if (onPath) return onPath;
  }

  for (const root of [process.env.CTGOV_DENO_ROOT]) {
    if (!root) continue;
    const bundledPath = resolveBundledDenoPath(root);
    if (bundledPath) return bundledPath;
  }

  const onPath = findOnPath("deno");
  if (onPath) return onPath;

  const installRoot = process.env.DENO_INSTALL_ROOT ?? join(homedir(), ".deno");
  const denoName = denoBinaryName();
  const bundledPath = join(installRoot, "bin", denoName);
  return existsSync(bundledPath) ? bundledPath : undefined;
}

const RUNNER_SRC = /* js */ `
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function send(msg) {
  Deno.stdout.writeSync(encoder.encode(JSON.stringify(msg) + "\\n"));
}
let rpcSeq = 0;
const pending = new Map();
async function readLoop() {
  const reader = Deno.stdin.readable.getReader();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += decoder.decode(value);
    let idx;
    while ((idx = buf.indexOf("\\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.type === "rpc.result") {
        const p = pending.get(msg.id); pending.delete(msg.id);
        if (!p) continue;
        if (msg.error) p.reject(new Error(msg.error.message || "rpc error"));
        else p.resolve(msg.value);
      } else if (msg.type === "run") {
        run(msg.code).then(
          (r) => send({ type: "done", ok: true, result: r }),
          (e) => send({ type: "done", ok: false, error: { name: e?.name || "Error", message: String(e?.message || e), stack: e?.stack } })
        );
      }
    }
  }
}
const __host = {
  rpc(method, args) {
    const id = ++rpcSeq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ type: "rpc.call", id, method, args: args || {} });
    });
  }
};
globalThis.console = {
  log: (...a) => send({ type: "log", level: "log", args: a }),
  info: (...a) => send({ type: "log", level: "info", args: a }),
  warn: (...a) => send({ type: "log", level: "warn", args: a }),
  error: (...a) => send({ type: "log", level: "error", args: a }),
};
${CTGOV_SDK_SHIM}
async function run(code) {
  const fn = new Function("ctgov", "return (async () => { " + code + " })();");
  return await fn(globalThis.ctgov);
}
readLoop();
`;

export class DenoExecutor implements SandboxExecutor {
  readonly kind = "deno" as const;
  private readonly denoPath: string;

  constructor(denoPath?: string) {
    this.denoPath =
      resolveDenoPath(denoPath) ?? denoPath ?? process.env.CTGOV_DENO_PATH ?? "deno";
  }

  async execute(opts: SandboxExecuteOptions): Promise<SandboxResult> {
    validateUserCode(opts.code);
    const started = Date.now();
    const logs: SandboxLog[] = [];
    const tempDir = await mkdtemp(join(tmpdir(), "ctgov-deno-"));
    const runnerPath = join(tempDir, "runner.js");
    await writeFile(runnerPath, RUNNER_SRC, "utf8");

    const child = spawn(
      this.denoPath,
      [
        "run",
        "--no-prompt",
        "--no-npm",
        "--no-remote",
        "--quiet",
        runnerPath,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    child.stderr.on("data", (chunk: Buffer) => {
      logs.push({
        level: "error",
        args: [`[deno-stderr] ${chunk.toString("utf8")}`],
        ts: Date.now(),
      });
    });
    child.stdin.on("error", () => {
      /* ignore broken pipe / write-after-end during teardown */
    });

    const rl = createInterface({ input: child.stdout });
    const timeoutMs = opts.timeoutMs ?? 15_000;
    let done = false;

    return await new Promise<SandboxResult>((resolve) => {
      const cleanup = async () => {
        rl.close();
        try {
          if (!child.stdin.destroyed && !child.stdin.writableEnded) {
            child.stdin.end();
          }
        } catch {
          /* ignore */
        }
        try {
          await rm(tempDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      };

      const finish = (result: SandboxResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        void cleanup();
        resolve(result);
      };

      const kill = () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      };

      const timer = setTimeout(() => {
        kill();
        finish({
          ok: false,
          error: { name: "SandboxTimeout", message: "Sandbox wall-clock timeout", code: "SANDBOX_TIMEOUT" },
          logs,
          calls: [],
          durationMs: Date.now() - started,
          executor: "deno",
        });
      }, timeoutMs);
      timer.unref?.();

      const send = (msg: unknown) => {
        if (done || child.stdin.destroyed || child.stdin.writableEnded) return;
        try {
          child.stdin.write(JSON.stringify(msg) + "\n");
        } catch {
          /* closed */
        }
      };

      rl.on("line", (line) => {
        if (!line) return;
        let msg: { type: string; [k: string]: unknown };
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === "log") {
          logs.push({
            level: msg.level as SandboxLog["level"],
            args: (msg.args as unknown[]) ?? [],
            ts: Date.now(),
          });
        } else if (msg.type === "rpc.call") {
          const id = msg.id as number;
          opts
            .dispatch(msg.method as string, msg.args)
            .then(
              (value) => send({ type: "rpc.result", id, value }),
              (err: Error) =>
                send({ type: "rpc.result", id, error: { message: err.message } }),
            );
        } else if (msg.type === "done") {
          kill();
          if (msg.ok) {
            finish({
              ok: true,
              result: msg.result ?? null,
              logs,
              calls: [],
              durationMs: Date.now() - started,
              executor: "deno",
            });
          } else {
            const e = msg.error as { name?: string; message?: string; stack?: string };
            finish({
              ok: false,
              error: {
                name: e?.name ?? "Error",
                message: e?.message ?? "Unknown",
                ...(e?.stack !== undefined ? { stack: e.stack } : {}),
                code: "SANDBOX_ERROR",
              },
              logs,
              calls: [],
              durationMs: Date.now() - started,
              executor: "deno",
            });
          }
        }
      });

      child.on("error", (err) => {
        finish({
          ok: false,
          error: { name: "SpawnError", message: err.message, code: "SANDBOX_ERROR" },
          logs,
          calls: [],
          durationMs: Date.now() - started,
          executor: "deno",
        });
      });

      child.on("exit", (code) => {
        if (done) return;
        finish({
          ok: false,
          error: {
            name: "SandboxExit",
            message: `Deno exited with code ${code}`,
            code: "SANDBOX_ERROR",
          },
          logs,
          calls: [],
          durationMs: Date.now() - started,
          executor: "deno",
        });
      });

      // Kick off execution
      send({ type: "run", code: opts.code });

      // Reference opts to satisfy unused param checks
      void opts;
    });

    // Never reached:
    throw new CtGovError("SANDBOX_ERROR", "unreachable");
  }
}
