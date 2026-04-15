import type { HttpClient } from "../supervisor/httpClient.js";
import type { AuditContext } from "../supervisor/audit.js";
import {
  StudiesSearchParams,
  StudyGetParams,
  FieldValueStatsParams,
  FieldSizeStatsParams,
  type StudiesSearchParamsT,
  type StudyGetParamsT,
  type FieldValueStatsParamsT,
  type FieldSizeStatsParamsT,
} from "../supervisor/validation.js";
import { CtGovError } from "../supervisor/errors.js";

export interface Study {
  protocolSection?: Record<string, unknown>;
  derivedSection?: Record<string, unknown>;
  resultsSection?: Record<string, unknown>;
  annotationSection?: Record<string, unknown>;
  documentSection?: Record<string, unknown>;
  hasResults?: boolean;
}

export interface StudiesPage {
  studies: Study[];
  nextPageToken?: string;
  totalCount?: number;
}

export interface FieldNode {
  name: string;
  piece?: string;
  type?: string;
  rules?: string;
  description?: string;
  children?: FieldNode[];
}

export interface SearchArea {
  name: string;
  parts: Array<{ name: string; weight?: number; fields: string[] }>;
}

export interface EnumDef {
  type: string;
  pieces: string[];
  values: Array<{ value: string; legacyValue?: string }>;
}

export interface SearchAllOptions {
  /** Maximum number of pages to iterate. Default 10, hard cap 100. */
  maxPages?: number;
  /** Page size. Default 100. */
  pageSize?: number;
}

export interface CtGovRuntimeOptions {
  http: HttpClient;
  audit: AuditContext;
}

/**
 * The `ctgov` binding exposed inside the sandbox.
 * Every method proxies through the supervisor's HttpClient (rate-limited,
 * cached, validated).
 */
export class CtGovRuntime {
  private readonly http: HttpClient;
  private readonly audit: AuditContext;

  constructor(opts: CtGovRuntimeOptions) {
    this.http = opts.http;
    this.audit = opts.audit;
  }

  get studies(): {
    search: (p: StudiesSearchParamsT) => Promise<StudiesPage>;
    searchAll: (p: StudiesSearchParamsT, o?: SearchAllOptions) => AsyncIterable<Study>;
    get: (nctId: string, p?: Omit<StudyGetParamsT, "nctId">) => Promise<Study>;
    metadata: (p?: {
      includeIndexedOnly?: boolean;
      includeHistoricOnly?: boolean;
    }) => Promise<FieldNode[]>;
    searchAreas: () => Promise<SearchArea[]>;
    enums: () => Promise<EnumDef[]>;
  } {
    const self = this;
    return {
      async search(params): Promise<StudiesPage> {
        const parsed = StudiesSearchParams.parse(params);
        return self.http.get<StudiesPage>({
          path: "/studies",
          query: parsed as Record<string, unknown>,
          audit: self.audit,
        });
      },
      searchAll(params, opts): AsyncIterable<Study> {
        const maxPages = Math.min(opts?.maxPages ?? 10, 100);
        const pageSize = opts?.pageSize ?? 100;
        return (async function* gen() {
          let pageToken: string | undefined;
          for (let i = 0; i < maxPages; i++) {
            const query: StudiesSearchParamsT = {
              ...params,
              pageSize,
              ...(pageToken !== undefined ? { pageToken } : {}),
            };
            const page = await self.http.get<StudiesPage>({
              path: "/studies",
              query: query as Record<string, unknown>,
              audit: self.audit,
            });
            for (const s of page.studies ?? []) yield s;
            if (!page.nextPageToken) return;
            pageToken = page.nextPageToken;
          }
        })();
      },
      async get(nctId, rest): Promise<Study> {
        const parsed = StudyGetParams.parse({ nctId, ...(rest ?? {}) });
        const { nctId: id, ...query } = parsed;
        return self.http.get<Study>({
          path: `/studies/${encodeURIComponent(id)}`,
          query,
          audit: self.audit,
        });
      },
      async metadata(p): Promise<FieldNode[]> {
        return self.http.get<FieldNode[]>({
          path: "/studies/metadata",
          ...(p ? { query: p as Record<string, unknown> } : {}),
          audit: self.audit,
        });
      },
      async searchAreas(): Promise<SearchArea[]> {
        return self.http.get<SearchArea[]>({ path: "/studies/search-areas", audit: self.audit });
      },
      async enums(): Promise<EnumDef[]> {
        return self.http.get<EnumDef[]>({ path: "/studies/enums", audit: self.audit });
      },
    };
  }

  get stats(): {
    size: () => Promise<unknown>;
    fieldValues: (p: FieldValueStatsParamsT) => Promise<unknown>;
    fieldSizes: (p: FieldSizeStatsParamsT) => Promise<unknown>;
  } {
    const self = this;
    return {
      async size() {
        return self.http.get<unknown>({ path: "/stats/size", audit: self.audit });
      },
      async fieldValues(params) {
        const parsed = FieldValueStatsParams.parse(params);
        return self.http.get<unknown>({
          path: "/stats/field/values",
          query: parsed as Record<string, unknown>,
          audit: self.audit,
        });
      },
      async fieldSizes(params) {
        const parsed = FieldSizeStatsParams.parse(params);
        return self.http.get<unknown>({
          path: "/stats/field/sizes",
          query: parsed as Record<string, unknown>,
          audit: self.audit,
        });
      },
    };
  }

  async version(): Promise<unknown> {
    return this.http.get<unknown>({ path: "/version", audit: this.audit });
  }
}

/**
 * Build the low-level RPC surface: a stable set of `method(args)` pairs that
 * the sandbox calls via `__host.rpc(method, args)`. Keeping it flat simplifies
 * the host↔sandbox bridge and the AST allow-list.
 */
export function buildRpcDispatch(runtime: CtGovRuntime): RpcDispatch {
  return async (method, args) => {
    switch (method) {
      case "studies.search":
        return runtime.studies.search(args as StudiesSearchParamsT);
      case "studies.get": {
        const a = args as { nctId: string } & Omit<StudyGetParamsT, "nctId">;
        const { nctId, ...rest } = a;
        return runtime.studies.get(nctId, rest);
      }
      case "studies.metadata":
        return runtime.studies.metadata(args as {});
      case "studies.searchAreas":
        return runtime.studies.searchAreas();
      case "studies.enums":
        return runtime.studies.enums();
      case "stats.size":
        return runtime.stats.size();
      case "stats.fieldValues":
        return runtime.stats.fieldValues(args as FieldValueStatsParamsT);
      case "stats.fieldSizes":
        return runtime.stats.fieldSizes(args as FieldSizeStatsParamsT);
      case "version":
        return runtime.version();
      default:
        throw new CtGovError("POLICY_VIOLATION", `Unknown SDK method: ${method}`);
    }
  };
}

export type RpcDispatch = (method: string, args: unknown) => Promise<unknown>;
