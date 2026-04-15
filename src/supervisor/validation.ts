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
