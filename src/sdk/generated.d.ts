/**
 * Auto-generated from schema/openapi.pinned.json.
 * Run `pnpm regen:sdk` to refresh from the live ClinicalTrials.gov spec.
 */

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

export type OverallStatus =
  | "RECRUITING"
  | "NOT_YET_RECRUITING"
  | "ACTIVE_NOT_RECRUITING"
  | "COMPLETED"
  | "TERMINATED"
  | "SUSPENDED"
  | "WITHDRAWN"
  | "UNKNOWN"
  | "ENROLLING_BY_INVITATION"
  | "NO_LONGER_AVAILABLE"
  | "APPROVED_FOR_MARKETING"
  | "AVAILABLE"
  | "TEMPORARILY_NOT_AVAILABLE";

export interface StudiesSearchParams {
  /** Conditions or diseases, e.g. `lung cancer`. */
  "query.cond"?: string;
  /** Free-text term across all fields. */
  "query.term"?: string;
  /** City, state, or country. */
  "query.locn"?: string;
  /** Title search. */
  "query.titles"?: string;
  /** Interventions / treatments. */
  "query.intr"?: string;
  /** Outcome measures. */
  "query.outc"?: string;
  /** Sponsor / collaborator. */
  "query.spons"?: string;
  /** Lead sponsor only. */
  "query.lead"?: string;
  /** NCT or secondary IDs. */
  "query.id"?: string;
  /** Patient-area composite search. */
  "query.patient"?: string;
  "filter.overallStatus"?: OverallStatus[];
  /** `distance(lat,lon,dist)` — e.g. `distance(40.75,-73.98,50mi)`. */
  "filter.geo"?: string;
  /** Restrict to NCT IDs. */
  "filter.ids"?: string[];
  /** Essie expression over any field. */
  "filter.advanced"?: string;
  "postFilter.overallStatus"?: OverallStatus[];
  aggFilters?: string;
  geoDecay?: string;
  /** Field projection (dotted paths). */
  fields?: string[] | string;
  /** Sort keys, e.g. `LastUpdatePostDate:desc`. */
  sort?: string[] | string;
  countTotal?: boolean;
  /** Default 10, max 1000. */
  pageSize?: number;
  /** Opaque token from a previous page. */
  pageToken?: string;
  format?: "json" | "csv";
  markupFormat?: "markdown" | "legacy";
}

export interface StudyGetParams {
  fields?: string[] | string;
  format?: "json" | "csv" | "fhir.json" | "ris";
  markupFormat?: "markdown" | "legacy";
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
  /** Max pages to iterate (default 10, hard cap 100). */
  maxPages?: number;
  /** Page size (default 100). */
  pageSize?: number;
}

/** The binding available to code passed to `execute`. */
export interface CtGov {
  studies: {
    /** Search studies with Essie queries and filters. */
    search(params: StudiesSearchParams): Promise<StudiesPage>;
    /** Iterate all matching studies across pages. */
    searchAll(params: StudiesSearchParams, opts?: SearchAllOptions): AsyncIterable<Study>;
    /** Fetch a single study by NCT ID. */
    get(nctId: string, params?: StudyGetParams): Promise<Study>;
    /** Field-level metadata for every data point in the schema. */
    metadata(params?: {
      includeIndexedOnly?: boolean;
      includeHistoricOnly?: boolean;
    }): Promise<FieldNode[]>;
    /** List all named search areas and the fields they cover. */
    searchAreas(): Promise<SearchArea[]>;
    /** Enum definitions used across study fields. */
    enums(): Promise<EnumDef[]>;
  };
  stats: {
    /** Byte-size histogram of every study JSON doc. */
    size(): Promise<unknown>;
    /** Top value counts for given fields. */
    fieldValues(params: { fields: string[]; types?: string[] }): Promise<unknown>;
    /** List-size histograms for given list-valued fields. */
    fieldSizes(params: { fields: string[] }): Promise<unknown>;
  };
  /** Current API / data versions. */
  version(): Promise<unknown>;
}
