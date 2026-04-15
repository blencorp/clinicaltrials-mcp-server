import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DenoExecutor, isDenoAvailable } from "../src/sandbox/deno.js";

const ORIGINAL_ENV = {
  CTGOV_DENO_PATH: process.env.CTGOV_DENO_PATH,
  CTGOV_DENO_ROOT: process.env.CTGOV_DENO_ROOT,
  DENO_INSTALL_ROOT: process.env.DENO_INSTALL_ROOT,
  PATH: process.env.PATH,
};

afterEach(() => {
  process.env.CTGOV_DENO_PATH = ORIGINAL_ENV.CTGOV_DENO_PATH;
  process.env.CTGOV_DENO_ROOT = ORIGINAL_ENV.CTGOV_DENO_ROOT;
  process.env.DENO_INSTALL_ROOT = ORIGINAL_ENV.DENO_INSTALL_ROOT;
  process.env.PATH = ORIGINAL_ENV.PATH;
});

async function writeFakeDeno(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "");
  if (process.platform !== "win32") {
    await chmod(path, 0o755);
  }
}

describe("deno discovery", () => {
  it("finds deno in DENO_INSTALL_ROOT even when PATH does not include it", async () => {
    const installRoot = await mkdtemp(join(tmpdir(), "ctgov-deno-root-"));
    const binDir = join(installRoot, "bin");
    const denoName = process.platform === "win32" ? "deno.exe" : "deno";
    const denoPath = join(binDir, denoName);

    await mkdir(binDir, { recursive: true });
    await writeFakeDeno(denoPath);

    process.env.CTGOV_DENO_PATH = "";
    process.env.CTGOV_DENO_ROOT = "";
    process.env.DENO_INSTALL_ROOT = installRoot;
    process.env.PATH = "";

    try {
      expect(isDenoAvailable()).toBe(true);
      expect(Reflect.get(new DenoExecutor(), "denoPath")).toBe(denoPath);
    } finally {
      await rm(installRoot, { recursive: true, force: true });
    }
  });

  it("finds deno in CTGOV_DENO_ROOT using the current platform layout", async () => {
    const denoRoot = await mkdtemp(join(tmpdir(), "ctgov-deno-bundle-"));
    const denoName = process.platform === "win32" ? "deno.exe" : "deno";
    const denoPath = join(denoRoot, `${process.platform}-${process.arch}`, denoName);

    await writeFakeDeno(denoPath);

    process.env.CTGOV_DENO_PATH = "";
    process.env.CTGOV_DENO_ROOT = denoRoot;
    process.env.DENO_INSTALL_ROOT = join(denoRoot, "missing-install-root");
    process.env.PATH = "";

    try {
      expect(isDenoAvailable()).toBe(true);
      expect(Reflect.get(new DenoExecutor(), "denoPath")).toBe(denoPath);
    } finally {
      await rm(denoRoot, { recursive: true, force: true });
    }
  });
});
