import { HttpClient } from '../../util/httpClient.js';
import { CtGovClient } from '../ctgov-client.js';
import { loadSourceCorpus } from './corpus-loader.js';
import type { Source, SourceConfig } from './source.js';

export const CTGOV_LABEL = 'ClinicalTrials.gov';

/** The upstream path each method calls, relative to the v2 base (checked against schema/openapi.pinned.json). */
export const METHOD_PATHS = Object.freeze({
  'studies.search': '/studies',
  'studies.get': '/studies/{nctId}',
  'studies.metadata': '/studies/metadata',
  'studies.searchAreas': '/studies/search-areas',
  'studies.enums': '/studies/enums',
  'stats.size': '/stats/size',
  'stats.fieldValues': '/stats/field/values',
  'stats.fieldSizes': '/stats/field/sizes',
  version: '/version',
} as const);

export function createCtGovSource(cfg: SourceConfig): Source {
  const http = new HttpClient({
    baseUrl: cfg.baseUrl, userAgent: cfg.userAgent, timeoutMs: cfg.timeoutMs,
    retries: cfg.retries, cacheTtlMs: cfg.cacheTtlMs, cacheMaxItems: cfg.cacheMaxItems,
    label: CTGOV_LABEL,
    ...(cfg.maxResponseBytes ? { maxResponseBytes: cfg.maxResponseBytes } : {}),
    ...(cfg.cacheMaxBytes ? { cacheMaxBytes: cfg.cacheMaxBytes } : {}),
    ...(cfg.gate ? { gate: cfg.gate } : {}),
    ...(cfg.dispatcher ? { dispatcher: cfg.dispatcher } : {}),
  });
  const client = new CtGovClient(http);
  return {
    name: 'ctgov',
    label: CTGOV_LABEL,
    enabled: true,
    client,
    // The only sandbox-callable surface. Dispatch resolves own data properties of this table.
    methods: Object.freeze({
      'studies.search': client.studiesSearch,
      'studies.get': client.studiesGet,
      'studies.metadata': client.studiesMetadata,
      'studies.searchAreas': client.studiesSearchAreas,
      'studies.enums': client.studiesEnums,
      'stats.size': client.statsSize,
      'stats.fieldValues': client.statsFieldValues,
      'stats.fieldSizes': client.statsFieldSizes,
      version: client.version,
    }),
    corpus: loadSourceCorpus('ctgov'),
  };
}
