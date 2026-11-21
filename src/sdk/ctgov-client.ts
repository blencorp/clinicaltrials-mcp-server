import type { HttpClient } from '../util/httpClient.js';
import {
  StudiesSearchParams, StudyGetParams, FieldValueStatsParams, FieldSizeStatsParams,
  ValidationError, parseParams,
} from './validation.js';

/** Plain-data views of what the SDK returns (the sandbox sees JSON, never these classes). */
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

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * ClinicalTrials.gov v2 (public, keyless). Every method is an arrow property so it can sit in the
 * source's frozen methods table; arguments arrive from the sandbox as data and are validated here.
 */
export class CtGovClient {
  constructor(private readonly http: HttpClient) {}

  /** Search studies. Flat dotted keys ("query.cond", "filter.overallStatus"), not nested objects. */
  studiesSearch = (params: unknown = {}) => {
    const parsed = parseParams(StudiesSearchParams, params, 'studies.search');
    return this.http.call<StudiesPage>({ path: '/studies', query: parsed as unknown as Record<string, never> });
  };

  /** One study by NCT ID, optionally projected with `fields`. */
  studiesGet = (nctId: unknown, opts?: unknown) => {
    if (opts !== undefined && !isPlainObject(opts)) throw new ValidationError('studies.get: options must be an object');
    const { nctId: id, ...query } = parseParams(StudyGetParams, { ...(opts ?? {}), nctId }, 'studies.get');
    return this.http.call<Study>({ path: `/studies/${encodeURIComponent(id)}`, query: query as Record<string, never> });
  };

  studiesMetadata = (opts?: unknown) => {
    if (opts !== undefined && !isPlainObject(opts)) throw new ValidationError('studies.metadata: options must be an object');
    return this.http.call({ path: '/studies/metadata', ...(opts ? { query: opts as Record<string, never> } : {}) });
  };

  studiesSearchAreas = () => this.http.call({ path: '/studies/search-areas' });
  studiesEnums = () => this.http.call({ path: '/studies/enums' });
  statsSize = () => this.http.call({ path: '/stats/size' });

  statsFieldValues = (params: unknown) => {
    const parsed = parseParams(FieldValueStatsParams, params, 'stats.fieldValues');
    return this.http.call({ path: '/stats/field/values', query: parsed as unknown as Record<string, never> });
  };

  statsFieldSizes = (params: unknown) => {
    const parsed = parseParams(FieldSizeStatsParams, params, 'stats.fieldSizes');
    return this.http.call({ path: '/stats/field/sizes', query: parsed as unknown as Record<string, never> });
  };

  version = () => this.http.call({ path: '/version' });
}
