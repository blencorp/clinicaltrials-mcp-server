import type { Sdk } from '../sdk/bindings.js';
import type { SandboxRunner } from '../sandbox/types.js';
import type { Corpus } from '../search/corpus.js';
import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { SearchApiInput, searchApi } from '../tools/searchApi.js';
import { DescribeSchemaInput, describeSchema } from '../tools/describeSchema.js';
import { ExecuteInput, execute, type ExecuteDeps, type RequestCtx } from '../tools/execute.js';
import { zodToJsonSchema } from './zodToJsonSchema.js';

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: Record<string, unknown>;
  /** JSON Schema of the structured result (`structuredContent`). */
  outputSchema: Record<string, unknown>;
  /** `signal` aborts when the client cancels the request or disconnects. */
  handler: (args: unknown, ctx?: { signal?: AbortSignal }) => Promise<unknown>;
  /** True when a returned result is a tool execution failure (MCP `isError`). */
  isFailure?: (result: unknown) => boolean;
}

const ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' }, kind: { type: 'string', enum: ['endpoint', 'field'] }, binding: { type: 'string' },
    description: { type: 'string' }, signature: { type: 'string' }, example: { type: 'string' }, score: { type: 'number' },
  },
  required: ['id', 'kind', 'binding', 'description'],
} as const;

export const OUTPUT_SCHEMAS = {
  search_api: {
    type: 'object',
    properties: { hits: { type: 'array', items: ENTRY_SCHEMA }, note: { type: 'string' } },
    required: ['hits', 'note'],
  },
  describe_schema: {
    type: 'object',
    properties: { found: { type: 'boolean' }, entries: { type: 'array', items: ENTRY_SCHEMA }, message: { type: 'string' } },
    required: ['found'],
  },
  execute: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'false when the code threw, timed out, or broke a limit; see error' },
      value: { description: 'The JSON value the code returned' },
      logs: { type: 'array', items: { type: 'string' } },
      error: {
        type: 'object',
        properties: { name: { type: 'string' }, message: { type: 'string' }, status: { type: 'number' } },
        required: ['name', 'message'],
      },
      durationMs: { type: 'number' },
    },
    required: ['ok', 'logs', 'durationMs'],
  },
} as const;

export interface CatalogDeps extends Omit<ExecuteDeps, 'sandbox'> {
  corpus: Corpus;
  /** Absent for docs-only serving, which never resolves a sandbox. */
  sandbox?: SandboxRunner;
  /** `docs-only` offers search_api + describe_schema and nothing else. */
  tools?: 'all' | 'docs-only';
}

export function buildCatalog(deps: CatalogDeps, requestCtx?: RequestCtx): ToolDescriptor[] {
  const all: ToolDescriptor[] = [
    {
      name: 'search_api',
      title: 'Search ClinicalTrials.gov API surface',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'BM25 search over the ClinicalTrials.gov SDK methods (ctgov.studies.*, ctgov.stats.*, ctgov.version) and the curated study-field dictionary. Returns method signatures and runnable JavaScript examples for use in `execute`. Use it before writing code: the SDK takes flat dotted keys ("query.cond", "filter.overallStatus"), not nested objects.',
      inputSchema: zodToJsonSchema(SearchApiInput),
      outputSchema: OUTPUT_SCHEMAS.search_api,
      handler: async (args) => searchApi(SearchApiInput.parse(args), deps.corpus),
    },
    {
      name: 'describe_schema',
      title: 'Describe ClinicalTrials.gov SDK and study fields',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        'Look up an SDK method, query-syntax note or study field by exact dotted id (`path`, e.g. "ctgov.studies.search", "ctgov.syntax.paging", "ctgov.fields.protocolSection.statusModule.overallStatus") or by namespace `prefix` (e.g. "ctgov.studies", "ctgov.fields.protocolSection.designModule"); exactly one of them. Field reference: https://clinicaltrials.gov/data-api/about-api/study-data-structure.',
      inputSchema: zodToJsonSchema(DescribeSchemaInput, {
        // Exactly one of path / prefix (the handler's refine rule, in JSON Schema form).
        oneOf: [{ required: ['path'], not: { required: ['prefix'] } }, { required: ['prefix'], not: { required: ['path'] } }],
      }),
      outputSchema: OUTPUT_SCHEMAS.describe_schema,
      handler: async (args) => describeSchema(DescribeSchemaInput.parse(args), deps.corpus.entries),
    },
    {
      name: 'execute',
      title: 'Execute sandboxed ClinicalTrials.gov query',
      // The sandbox SDK only reads upstream data. Idempotence describes external
      // effects, not identical results; annotations do not enforce permissions.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        'Run JavaScript inside a sandbox (no net, fs, env, or subprocess) against the `ctgov` SDK for the public ClinicalTrials.gov v2 API (https://clinicaltrials.gov/data-api/api). Plain JS only: TypeScript type annotations are rejected. Top-level await is allowed; `return` the value you want as the result (at most 256 KiB, so pass `fields` to studies.search and return only what you need). To read several pages, loop on `nextPageToken` with `pageToken`; there is no searchAll helper. Read-only: GET endpoints only.',
      inputSchema: zodToJsonSchema(ExecuteInput),
      outputSchema: OUTPUT_SCHEMAS.execute,
      handler: async (args, ctx) => {
        if (!deps.sandbox) throw new Error('execute is not available: this server has no sandbox');
        return execute(ExecuteInput.parse(args), { ...deps, sandbox: deps.sandbox }, { ...requestCtx, ...(ctx?.signal ? { signal: ctx.signal } : {}) });
      },
      isFailure: (result) => (result as { ok?: unknown })?.ok === false,
    },
  ];
  return deps.tools === 'docs-only' ? all.filter((t) => t.name !== 'execute') : all;
}

/** The static tool listing (names, descriptions, schemas) for consumers that never call a handler. */
export const TOOL_CATALOG: readonly ToolDescriptor[] = buildCatalog({
  corpus: undefined as unknown as Corpus,
  sdk: undefined as unknown as Sdk,
  callBudgets: {},
  tools: 'all',
});
