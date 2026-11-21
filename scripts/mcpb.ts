import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { buildMcpbManifest } from "../src/mcpb/manifest.js";

type Command = "prepare" | "validate" | "pack";

interface PackageJson {
  version: string;
  engines?: {
    node?: string;
  };
}

interface StageContext {
  stageDir: string;
  outputPath: string;
}

interface RunCommandOptions {
  quietOnSuccess?: boolean;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORK_DIR = join(ROOT, ".mcpb");
const STAGE_DIR = join(WORK_DIR, "stage");
const DIST_DIR = join(WORK_DIR, "dist");
const BUNDLE_FILE = "clinicaltrials-mcp-server.mcpb";

function runCommand(
  command: string,
  args: string[],
  cwd = ROOT,
  options: RunCommandOptions = {},
): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    const child = spawn(command, args, {
      cwd,
      stdio: options.quietOnSuccess ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: process.platform === "win32",
    });
    if (options.quietOnSuccess) {
      child.stdout!.on("data", (chunk) => {
        output += chunk.toString("utf8");
      });
      child.stderr!.on("data", (chunk) => {
        output += chunk.toString("utf8");
      });
    }
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      const summary = `${command} ${args.join(" ")} exited with code ${code ?? 1}`;
      const details = options.quietOnSuccess ? output.trim() : "";
      rejectPromise(new Error(details ? `${summary}\n\n${details}` : summary));
    });
  });
}

async function readPackageJson(): Promise<PackageJson> {
  const raw = await readFile(join(ROOT, "package.json"), "utf8");
  return JSON.parse(raw) as PackageJson;
}

async function stageBundle(): Promise<StageContext> {
  const packageJson = await readPackageJson();

  await runCommand("pnpm", ["build"]);
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  // Optional dependencies stay: isolated-vm (the stdio sandbox) is one, and it ships prebuilt
  // binaries for Node 24 and 26 on the common platforms, so the bundle needs no install step.
  await runCommand(
    "pnpm",
    ["--filter", ".", "--config.node-linker=hoisted", "deploy", "--legacy", "--prod", STAGE_DIR],
    ROOT,
    { quietOnSuccess: true },
  );

  const manifest = buildMcpbManifest({
    version: packageJson.version,
    nodeVersionRange: packageJson.engines?.node ?? "^24.11.0 || ^26.0.0",
  });
  await writeFile(join(STAGE_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    stageDir: STAGE_DIR,
    // The name the documentation site's Claude Desktop button downloads from the latest release
    // (site/src/lib/install.ts: the repository name), so it carries no version.
    outputPath: join(ROOT, BUNDLE_FILE),
  };
}

async function main(): Promise<void> {
  const command = (process.argv[2] ?? "pack") as Command;
  if (!["prepare", "validate", "pack"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const ctx = await stageBundle();
  if (command === "prepare") {
    process.stdout.write(`${ctx.stageDir}\n`);
    return;
  }

  await runCommand("pnpm", ["exec", "mcpb", "validate", ctx.stageDir]);
  if (command === "validate") {
    return;
  }

  await runCommand("pnpm", ["exec", "mcpb", "pack", ctx.stageDir, ctx.outputPath]);
  process.stdout.write(`${ctx.outputPath}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  });
}
