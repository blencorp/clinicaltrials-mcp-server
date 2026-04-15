import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { HttpClient } from "../supervisor/httpClient.js";
import type { SandboxExecutor } from "../sandbox/types.js";
import {
  runSearchApi,
  SearchApiInput,
} from "../tools/searchApi.js";
import {
  runDescribeSchema,
  DescribeSchemaInput,
} from "../tools/describeSchema.js";
import { runExecute, ExecuteInput } from "../tools/execute.js";
import { logger } from "../util/logger.js";
import { CtGovError } from "../supervisor/errors.js";
import type { SubjectQuota } from "../supervisor/subjectQuota.js";
import { TOOL_CATALOG } from "./toolCatalog.js";

export interface BuildMcpServerOptions {
  executor?: SandboxExecutor;
  resolveExecutor?: () => SandboxExecutor;
  /**
   * Subject identifier (OAuth `sub`) to stamp on audit events. `undefined`
   * for stdio/unauthenticated local use.
   */
  subject?: string;
  /** Per-subject quota enforcer (HTTP transport). */
  quota?: SubjectQuota;
}

const SERVER_INFO = {
  name: "clinicaltrial-mcp-server",
  version: "0.1.0-alpha.0",
} as const;

export function buildMcpServer(opts: BuildMcpServerOptions): Server {
  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {
        listChanged: false,
      },
    },
  });
  const subject = opts.subject;
  const resolveExecutor = (): SandboxExecutor => {
    if (opts.resolveExecutor) return opts.resolveExecutor();
    if (opts.executor) return opts.executor;
    throw new CtGovError("INTERNAL_ERROR", "sandbox executor not configured");
  };

  // Build an HTTP client with subject-aware rate limiting (if quota provided).
  const httpClientOpts: ConstructorParameters<typeof HttpClient>[0] = {};
  if (opts.quota) {
    httpClientOpts.acquireFn = () => opts.quota!.acquireUpstream(subject);
  }
  const http = new HttpClient(httpClientOpts);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_CATALOG,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    try {
      if (name === "search_api") {
        const input = SearchApiInput.parse(args ?? {});
        const out = runSearchApi(input);
        return {
          content: [
            { type: "text", text: out.snippet },
            { type: "text", text: JSON.stringify({ hits: out.hits.length }, null, 2) },
          ],
        };
      }
      if (name === "describe_schema") {
        const input = DescribeSchemaInput.parse(args ?? {});
        const out = runDescribeSchema(input);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      if (name === "execute") {
        const input = ExecuteInput.parse(args ?? {});
        if (opts.quota && subject) opts.quota.tryConsumeExecute(subject);
        const execDeps: Parameters<typeof runExecute>[1] = { executor: resolveExecutor(), http };
        if (subject !== undefined) execDeps.subject = subject;
        const out = await runExecute(input, execDeps);
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
      }
      throw new CtGovError("VALIDATION_ERROR", `Unknown tool: ${name}`);
    } catch (err) {
      const payload =
        err instanceof CtGovError
          ? err.toJSON()
          : { name: (err as Error).name, message: (err as Error).message };
      logger.warn("tool.error", { tool: name, subject, ...payload });
      return {
        isError: true,
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    }
  });

  return server;
}
