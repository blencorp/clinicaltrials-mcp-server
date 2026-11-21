// Shared helpers for the characterization specs (not a spec itself).
import { MockAgent } from "undici";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildMcpServer } from "../../src/server/mcpServer.js";
import type { CatalogDeps } from "../../src/server/toolCatalog.js";
import type { RequestCtx } from "../../src/tools/execute.js";
import type { SandboxRunner } from "../../src/sandbox/types.js";
import { buildSdk } from "../../src/sdk/bindings.js";
import { dispatch, type RpcResponse } from "../../src/sdk/runtime.js";
import { buildSupervisor, type SupervisorConfig } from "../../src/supervisor/index.js";

export interface UpstreamRequest {
  /** Path plus query string exactly as sent on the wire, without the /api/v2 prefix. */
  path: string;
  headers: Record<string, string>;
}

export interface UpstreamReply {
  status: number;
  /** Strings are sent verbatim (csv, ris, malformed JSON); anything else is JSON-encoded. */
  body?: unknown;
  headers?: Record<string, string>;
}

export type UpstreamHandler = (req: UpstreamRequest, index: number) => UpstreamReply;

export interface FakeUpstream {
  agent: MockAgent;
  /** Every request the fake received, in order. */
  requests: UpstreamRequest[];
  close: () => Promise<void>;
}

/**
 * A fake clinicaltrials.gov/api/v2 built on an undici MockAgent. Net connect is disabled, so a
 * request that escapes the fake fails loudly instead of reaching the real API.
 */
export function fakeUpstream(handler: UpstreamHandler): FakeUpstream {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const requests: UpstreamRequest[] = [];
  const pool = agent.get("https://clinicaltrials.gov");
  pool
    .intercept({ path: (p: string) => p.startsWith("/api/v2"), method: "GET" })
    .reply((opts) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries((opts.headers ?? {}) as Record<string, unknown>)) {
        headers[k.toLowerCase()] = String(v);
      }
      const req: UpstreamRequest = { path: opts.path.replace(/^\/api\/v2/, ""), headers };
      const index = requests.length;
      requests.push(req);
      const r = handler(req, index);
      const data = r.body === undefined ? "" : typeof r.body === "string" ? r.body : JSON.stringify(r.body);
      return { statusCode: r.status, data, responseOptions: { headers: r.headers ?? {} } };
    })
    .persist();
  return { agent, requests, close: () => agent.close() };
}

/** Serves the same JSON 200 (or the given reply) to every request. */
export function constantUpstream(reply: UpstreamReply | unknown): FakeUpstream {
  const r: UpstreamReply =
    typeof reply === "object" && reply !== null && "status" in reply
      ? (reply as UpstreamReply)
      : { status: 200, body: reply };
  return fakeUpstream(() => r);
}

/** Dispatches one SDK method (`studies.search`, `version`, ...) through the real SDK against the fake. */
export async function sdkCall(upstream: FakeUpstream, method: string, args: unknown[] = [], cfg: Partial<Parameters<typeof buildSdk>[0]> = {}): Promise<RpcResponse> {
  const sdk = buildSdk({
    baseUrl: "https://clinicaltrials.gov/api/v2",
    userAgent: "characterization/0",
    timeoutMs: 5000,
    retries: 0,
    cacheTtlMs: 0,
    cacheMaxItems: 0,
    dispatcher: upstream.agent,
    ...cfg,
  });
  return dispatch(sdk, { binding: "ctgov", path: method.split("."), args });
}

export interface ConnectOptions {
  /** `docs-only` serves search_api + describe_schema and never touches a sandbox. */
  tools?: "all" | "docs-only";
  /** The runner `execute` uses (a fake, or a real runner). Default: a runner that reports it is unavailable. */
  sandbox?: SandboxRunner;
  upstream?: FakeUpstream;
  supervisor?: Partial<SupervisorConfig>;
  requestCtx?: RequestCtx;
}

const unavailable: SandboxRunner = {
  kind: "unavailable",
  available: async () => false,
  execute: async () => ({ ok: false, logs: [], error: { name: "SandboxUnavailable", message: "no runner in this test" }, durationMs: 0 }),
};

export interface Connected {
  client: Client;
  deps: CatalogDeps;
  close: () => Promise<void>;
}

/** Connects a real MCP SDK client to buildMcpServer over an in-memory transport. */
export async function connect(opts: ConnectOptions = {}): Promise<Connected> {
  const built = await buildSupervisor({
    userAgent: "characterization/0",
    upstreamTimeoutMs: 5000,
    upstreamRetries: 0,
    cacheTtlMs: 0,
    cacheMaxItems: 0,
    sandbox: "auto",
    upstreamRatePerSec: 100_000,
    ...opts.supervisor,
    // The supervisor never resolves a sandbox here; tests hand in the runner they want.
    tools: "docs-only",
    ...(opts.upstream ? { dispatcher: opts.upstream.agent } : {}),
  });
  const tools = opts.tools ?? "all";
  const deps: CatalogDeps = { ...built, tools, ...(tools === "all" ? { sandbox: opts.sandbox ?? unavailable } : {}) };
  const server = buildMcpServer(deps, opts.requestCtx);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "characterization", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    deps,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

type Content = Array<{ type: string; text?: string }>;

export interface CallOutcome {
  isError: boolean | undefined;
  /** Raw text of every content block. */
  texts: string[];
  /** Keys the result carried besides content/isError (e.g. structuredContent). */
  extraKeys: string[];
  structured: unknown;
}

export async function call(c: Connected, name: string, args: unknown): Promise<CallOutcome> {
  const res = (await c.client.callTool({ name, arguments: args as Record<string, unknown> })) as Record<string, unknown>;
  const content = (res.content ?? []) as Content;
  return {
    isError: res.isError as boolean | undefined,
    texts: content.map((b) => b.text ?? `<${b.type}>`),
    extraKeys: Object.keys(res).filter((k) => k !== "content" && k !== "isError"),
    structured: res.structuredContent,
  };
}

/** What a call rejected with (a JSON-RPC protocol error), failing the test if it resolved. */
export async function protocolError(c: Connected, name: string, args: unknown): Promise<{ code: unknown; message: string }> {
  try {
    await c.client.callTool({ name, arguments: args as Record<string, unknown> });
  } catch (e) {
    const err = e as { code?: unknown; message: string };
    return { code: err.code, message: err.message };
  }
  throw new Error("expected a protocol error");
}

/** Replaces the run-to-run values (durations) of an execute envelope. */
export function normalizeExecute(json: string): unknown {
  const out = JSON.parse(json) as Record<string, unknown>;
  if (typeof out.durationMs === "number") out.durationMs = "<ms>";
  return out;
}
