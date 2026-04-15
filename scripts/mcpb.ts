import { createWriteStream, existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { inflateRawSync } from "node:zlib";
import { buildMcpbManifest, type McpbDenoTarget } from "../src/mcpb/manifest.js";

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

interface DenoTargetDefinition {
  platform: NodeJS.Platform;
  arch: string;
  releaseTuple: string;
  binaryName: string;
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORK_DIR = join(ROOT, ".mcpb");
const STAGE_DIR = join(WORK_DIR, "stage");
const DIST_DIR = join(WORK_DIR, "dist");
const CACHE_DIR = join(WORK_DIR, "cache", "deno");

const DENO_TARGETS: Record<string, DenoTargetDefinition> = {
  "darwin-arm64": {
    platform: "darwin",
    arch: "arm64",
    releaseTuple: "aarch64-apple-darwin",
    binaryName: "deno",
  },
  "darwin-x64": {
    platform: "darwin",
    arch: "x64",
    releaseTuple: "x86_64-apple-darwin",
    binaryName: "deno",
  },
  "win32-x64": {
    platform: "win32",
    arch: "x64",
    releaseTuple: "x86_64-pc-windows-msvc",
    binaryName: "deno.exe",
  },
} as const;

const HOST_TARGET_KEY = `${process.platform}-${process.arch}`;
const DEFAULT_TARGET_KEYS = Object.keys(DENO_TARGETS);
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const ZIP_MAX_EOCD_SEARCH = 65_557;

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
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk) => {
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

function resolveDenoPath(binaryName: string): string | undefined {
  for (const candidate of [process.env.CTGOV_DENO_PATH]) {
    if (!candidate) continue;
    if (existsSync(candidate)) return candidate;
  }

  const path = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  for (const dir of path.split(sep)) {
    if (!dir) continue;
    const candidate = join(dir, binaryName);
    if (existsSync(candidate)) return candidate;
  }

  const installRoot = process.env.DENO_INSTALL_ROOT ?? join(homedir(), ".deno");
  const bundledPath = join(installRoot, "bin", binaryName);
  return existsSync(bundledPath) ? bundledPath : undefined;
}

async function readPackageJson(): Promise<PackageJson> {
  const raw = await readFile(join(ROOT, "package.json"), "utf8");
  return JSON.parse(raw) as PackageJson;
}

async function getLocalDenoVersion(denoPath: string): Promise<string> {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(denoPath, ["--version"], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code !== 0) {
        rejectPromise(new Error(stderr || `Failed to read Deno version from ${denoPath}`));
        return;
      }
      const line = stdout.split(/\r?\n/)[0] ?? "";
      const match = line.match(/^deno\s+([0-9]+\.[0-9]+\.[0-9]+)/);
      if (!match) {
        rejectPromise(new Error(`Unexpected Deno version output: ${line}`));
        return;
      }
      resolvePromise(match[1]);
    });
  });
}

function parseTargetKeys(): string[] {
  const raw = process.env.CTGOV_MCPB_TARGETS;
  const requestedKeys = raw
    ? raw.split(",").map((value) => value.trim()).filter(Boolean)
    : DEFAULT_TARGET_KEYS;

  for (const key of requestedKeys) {
    if (!(key in DENO_TARGETS)) {
      throw new Error(
        `Unsupported CTGOV_MCPB_TARGETS entry: ${key}. Supported values: ${Object.keys(DENO_TARGETS).join(", ")}`,
      );
    }
  }
  return Array.from(new Set(requestedKeys));
}

function relativeDenoPath(target: DenoTargetDefinition): string {
  return ["vendor", "deno", `${target.platform}-${target.arch}`, target.binaryName].join("/");
}

function findEndOfCentralDirectoryOffset(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - ZIP_MAX_EOCD_SEARCH);
  for (let offset = buffer.length - 22; offset >= start; offset--) {
    if (buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return offset;
    }
  }
  throw new Error("ZIP archive is missing the end-of-central-directory record.");
}

export function extractZipEntryBuffer(buffer: Buffer, entryName: string): Buffer {
  const eocdOffset = findEndOfCentralDirectoryOffset(buffer);
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  for (let index = 0; index < entryCount; index++) {
    if (buffer.readUInt32LE(centralDirectoryOffset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error("ZIP archive has an invalid central directory entry.");
    }

    const compressionMethod = buffer.readUInt16LE(centralDirectoryOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralDirectoryOffset + 20);
    const fileNameLength = buffer.readUInt16LE(centralDirectoryOffset + 28);
    const extraLength = buffer.readUInt16LE(centralDirectoryOffset + 30);
    const commentLength = buffer.readUInt16LE(centralDirectoryOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(centralDirectoryOffset + 42);
    const fileName = buffer
      .subarray(centralDirectoryOffset + 46, centralDirectoryOffset + 46 + fileNameLength)
      .toString("utf8");

    if (fileName === entryName) {
      if (buffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
        throw new Error(`ZIP archive entry ${entryName} has an invalid local file header.`);
      }

      const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
      const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
      const compressedData = buffer.subarray(dataOffset, dataOffset + compressedSize);

      if (compressionMethod === 0) {
        return Buffer.from(compressedData);
      }
      if (compressionMethod === 8) {
        return inflateRawSync(compressedData);
      }
      throw new Error(
        `ZIP archive entry ${entryName} uses unsupported compression method ${compressionMethod}.`,
      );
    }

    centralDirectoryOffset += 46 + fileNameLength + extraLength + commentLength;
  }

  throw new Error(`Archive does not contain ${entryName}`);
}

async function extractZipEntryToFile(
  zipPath: string,
  entryName: string,
  destination: string,
): Promise<void> {
  const zipBuffer = await readFile(zipPath);
  const entryBuffer = extractZipEntryBuffer(zipBuffer, entryName);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, entryBuffer);
}

async function downloadFile(url: string, destination: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }
  await mkdir(dirname(destination), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
}

async function ensureDownloadedTargetBinary(
  target: DenoTargetDefinition,
  version: string,
  destination: string,
): Promise<void> {
  if (existsSync(destination)) return;

  const zipPath = join(CACHE_DIR, version, `${target.releaseTuple}.zip`);
  if (!existsSync(zipPath)) {
    const releaseUrl = `https://dl.deno.land/release/v${version}/deno-${target.releaseTuple}.zip`;
    await downloadFile(releaseUrl, zipPath);
  }

  await extractZipEntryToFile(zipPath, target.binaryName, destination);
  if (target.platform !== "win32") {
    await chmod(destination, 0o755);
  }
}

async function bundleDenoTargets(version: string): Promise<McpbDenoTarget[]> {
  const targetKeys = parseTargetKeys();
  const hostTarget = DENO_TARGETS[HOST_TARGET_KEY];
  if (!hostTarget) {
    throw new Error(
      `No Deno target mapping for current platform ${HOST_TARGET_KEY}. Supported build hosts: ${Object.keys(DENO_TARGETS).join(", ")}`,
    );
  }

  const hostDenoPath = resolveDenoPath(hostTarget.binaryName);
  if (!hostDenoPath) {
    throw new Error(
      "Generating an MCPB requires a local Deno binary so the packaged extension can run `execute`. Install Deno or set CTGOV_DENO_PATH before running this command.",
    );
  }

  const bundledTargets: McpbDenoTarget[] = [];
  for (const key of targetKeys) {
    const target = DENO_TARGETS[key];
    const destination = join(STAGE_DIR, relativeDenoPath(target));
    if (key === HOST_TARGET_KEY) {
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(hostDenoPath, destination);
      if (target.platform !== "win32") {
        await chmod(destination, 0o755);
      }
    } else {
      await ensureDownloadedTargetBinary(target, version, destination);
    }

    bundledTargets.push({
      platform: target.platform,
      arch: target.arch,
      binaryRelativePath: relativeDenoPath(target),
    });
  }

  return bundledTargets;
}

function outputFileName(version: string, targetCount: number): string {
  if (targetCount === 1) {
    return `clinicaltrial-mcp-server-${version}-${process.platform}-${process.arch}.mcpb`;
  }
  return `clinicaltrial-mcp-server-${version}.mcpb`;
}

async function stageBundle(): Promise<StageContext> {
  const packageJson = await readPackageJson();
  const hostTarget = DENO_TARGETS[HOST_TARGET_KEY];
  if (!hostTarget) {
    throw new Error(
      `No Deno target mapping for current platform ${HOST_TARGET_KEY}. Supported build hosts: ${Object.keys(DENO_TARGETS).join(", ")}`,
    );
  }

  const hostDenoPath = resolveDenoPath(hostTarget.binaryName);
  if (!hostDenoPath) {
    throw new Error(
      "Generating an MCPB requires a local Deno binary so the packaged extension can run `execute`. Install Deno or set CTGOV_DENO_PATH before running this command.",
    );
  }

  const denoVersion = await getLocalDenoVersion(hostDenoPath);

  await runCommand("pnpm", ["build"]);
  await rm(WORK_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  await runCommand(
    "pnpm",
    [
      "--filter",
      ".",
      "--config.node-linker=hoisted",
      "deploy",
      "--legacy",
      "--prod",
      "--no-optional",
      STAGE_DIR,
    ],
    ROOT,
    { quietOnSuccess: true },
  );

  const denoTargets = await bundleDenoTargets(denoVersion);
  const manifest = buildMcpbManifest({
    version: packageJson.version,
    nodeVersionRange: packageJson.engines?.node ?? ">=20.10.0",
    denoTargets,
  });
  await writeFile(join(STAGE_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    stageDir: STAGE_DIR,
    outputPath: join(DIST_DIR, outputFileName(packageJson.version, denoTargets.length)),
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
