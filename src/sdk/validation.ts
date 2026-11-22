import { z } from "zod";

const OverallStatus = z.enum([
  "RECRUITING",
  "NOT_YET_RECRUITING",
  "ACTIVE_NOT_RECRUITING",
  "COMPLETED",
  "TERMINATED",
  "SUSPENDED",
  "WITHDRAWN",
  "UNKNOWN",
  "ENROLLING_BY_INVITATION",
  "NO_LONGER_AVAILABLE",
  "APPROVED_FOR_MARKETING",
  "AVAILABLE",
  "TEMPORARILY_NOT_AVAILABLE",
]);

const StringOrArray = z.union([z.string(), z.array(z.string())]);

export const StudiesSearchParams = z
  .object({
    "query.cond": z.string().optional(),
    "query.term": z.string().optional(),
    "query.locn": z.string().optional(),
    "query.titles": z.string().optional(),
    "query.intr": z.string().optional(),
    "query.outc": z.string().optional(),
    "query.spons": z.string().optional(),
    "query.lead": z.string().optional(),
    "query.id": z.string().optional(),
    "query.patient": z.string().optional(),
    "filter.overallStatus": z.array(OverallStatus).optional(),
    "filter.geo": z.string().optional(),
    "filter.ids": z.array(z.string()).optional(),
    "filter.advanced": z.string().optional(),
    "postFilter.overallStatus": z.array(OverallStatus).optional(),
    aggFilters: z.string().optional(),
    geoDecay: z.string().optional(),
    fields: StringOrArray.optional(),
    sort: StringOrArray.optional(),
    countTotal: z.boolean().optional(),
    pageSize: z.number().int().min(0).max(1000).optional(),
    pageToken: z.string().optional(),
    format: z.enum(["json", "csv"]).optional(),
    markupFormat: z.enum(["markdown", "legacy"]).optional(),
  })
  .strict();

export type StudiesSearchParamsT = z.infer<typeof StudiesSearchParams>;

export const StudyGetParams = z
  .object({
    nctId: z.string().regex(/^NCT[0-9]{8}$/, "Invalid NCT ID"),
    fields: StringOrArray.optional(),
    format: z.enum(["json", "csv", "fhir.json", "ris"]).optional(),
    markupFormat: z.enum(["markdown", "legacy"]).optional(),
  })
  .strict();

export type StudyGetParamsT = z.infer<typeof StudyGetParams>;

export const FieldValueStatsParams = z
  .object({
    fields: z.array(z.string()).nonempty(),
    types: z.array(z.string()).optional(),
  })
  .strict();

export type FieldValueStatsParamsT = z.infer<typeof FieldValueStatsParams>;

export const FieldSizeStatsParams = z
  .object({
    fields: z.array(z.string()).nonempty(),
  })
  .strict();

export type FieldSizeStatsParamsT = z.infer<typeof FieldSizeStatsParams>;

/** A caller's mistake in SDK arguments; crosses the sandbox boundary as `ValidationError`. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const MAX_ISSUES = 5;

/** A short, bounded, human-readable rendering of a zod error (never the raw issue JSON). */
export function describeIssues(err: z.ZodError): string {
  const shown = err.issues.slice(0, MAX_ISSUES).map((i) => {
    const where = i.path.length ? i.path.map(String).join('.') : 'arguments';
    if (i.code === 'unrecognized_keys') return `${where}: unknown key(s) ${i.keys.map((k) => `'${k}'`).join(', ')}`;
    return `${where}: ${i.message}`;
  });
  const more = err.issues.length > MAX_ISSUES ? `; and ${err.issues.length - MAX_ISSUES} more` : '';
  return (shown.join('; ') + more).slice(0, 1000);
}

/**
 * The most common LLM-authored mistake is nesting under a `query`, `filter` or `postFilter`
 * object; the API uses flat dotted keys. Name the fix instead of listing zod issues.
 */
function nestedKeyHint(err: z.ZodError, what: string): string | undefined {
  const offenders = err.issues
    .filter((i) => i.code === 'unrecognized_keys' && i.path.length === 0)
    .flatMap((i) => (i.code === 'unrecognized_keys' ? i.keys : []))
    .filter((k) => k === 'query' || k === 'filter' || k === 'postFilter');
  if (offenders.length === 0) return undefined;
  return (
    `${what}() uses flat dotted keys, not nested objects. ` +
    `Replace { ${offenders.map((k) => `${k}: { ... }`).join(', ')} } with string keys like ` +
    `"query.cond", "query.term", "filter.overallStatus", "filter.geo".`
  );
}

/** Parse SDK arguments, turning a zod failure into a bounded ValidationError. */
export function parseParams<S extends z.ZodType>(schema: S, params: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(params);
  if (r.success) return r.data;
  throw new ValidationError(nestedKeyHint(r.error, what) ?? `${what}: invalid arguments: ${describeIssues(r.error)}`);
}
