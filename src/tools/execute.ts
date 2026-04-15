import { z } from "zod";
import { newAuditContext } from "../supervisor/audit.js";
import type { HttpClient } from "../supervisor/httpClient.js";
import { buildRpcDispatch, CtGovRuntime } from "../sdk/runtime.js";
import type { SandboxExecutor, SandboxResult } from "../sandbox/types.js";

export const ExecuteInput = z.object({
  code: z.string().min(1, "code is required"),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  memoryMb: z.number().int().min(16).max(256).optional(),
});

export interface ExecuteDeps {
  executor: SandboxExecutor;
  http: HttpClient;
  /** Optional subject (OAuth `sub`) to stamp on audit events. */
  subject?: string;
}

export async function runExecute(
  input: z.infer<typeof ExecuteInput>,
  deps: ExecuteDeps,
): Promise<SandboxResult> {
  const audit = newAuditContext(deps.subject);
  const runtime = new CtGovRuntime({ http: deps.http, audit });
  const dispatch = buildRpcDispatch(runtime);

  const options = {
    code: input.code,
    dispatch,
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.memoryMb !== undefined ? { memoryMb: input.memoryMb } : {}),
  };
  const result = await deps.executor.execute(options);

  // Attach audit trace to the sandbox result
  return { ...result, calls: audit.calls };
}
