// Shared helpers for the characterization specs (not a spec itself).
import { MockAgent } from "undici";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { buildMcpServer, type BuildMcpServerOptions } from "../../src/server/mcpServer.js";
import { RateLimiter } from "../../src/supervisor/rateLimiter.js";
import { HttpClient, type HttpClientOptions } from "../../src/supervisor/httpClient.js";

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

/** A rate limiter that never throttles, so paging tests are not paced by the real 10 rps gate. */
export const fastLimiter = (): RateLimiter => new RateLimiter({ ratePerSec: 100_000, burst: 100_000 });

export function newClient(upstream: FakeUpstream, opts: HttpClientOptions = {}): HttpClient {
  return new HttpClient({ dispatcher: upstream.agent, rateLimiter: fastLimiter(), ...opts });
}

export interface Connected {
  client: Client;
  close: () => Promise<void>;
}

/** Connects a real MCP SDK client to buildMcpServer over an in-memory transport. */
export async function connect(opts: BuildMcpServerOptions): Promise<Connected> {
  const server = buildMcpServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "characterization", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
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

/** Replaces the run-to-run values (timestamps, durations, call ids, stacks) of an execute envelope. */
export function normalizeExecute(json: string): unknown {
  const out = JSON.parse(json) as Record<string, unknown>;
  if (typeof out.durationMs === "number") out.durationMs = "<ms>";
  if (Array.isArray(out.logs)) {
    out.logs = (out.logs as Array<Record<string, unknown>>).map((l) => ({ ...l, ts: "<ts>" }));
  }
  if (Array.isArray(out.calls)) {
    out.calls = (out.calls as Array<Record<string, unknown>>).map((c) => ({ ...c, id: "<id>", durationMs: "<ms>" }));
  }
  const err = out.error as Record<string, unknown> | undefined;
  if (err && "stack" in err) err.stack = "<stack>";
  return out;
}
