import { z } from "zod";
import { buildCorpus, type FieldDoc } from "../search/corpus.js";

export const DescribeSchemaInput = z
  .object({
    path: z.string().optional().describe("Exact dotted field path, e.g. 'protocolSection.identificationModule.nctId'"),
    prefix: z.string().optional().describe("Path prefix to enumerate, e.g. 'protocolSection.statusModule'"),
  })
  .refine((v) => Boolean(v.path) !== Boolean(v.prefix), { message: "Provide exactly one of `path` or `prefix`" });

export interface DescribeSchemaResult {
  matches: FieldDoc[];
  total: number;
}

export function runDescribeSchema(
  input: z.infer<typeof DescribeSchemaInput>,
): DescribeSchemaResult {
  const { fields } = buildCorpus();
  let matches = fields;
  if (input.path) {
    matches = matches.filter((f) => f.path === input.path);
  } else if (input.prefix) {
    const pre = input.prefix;
    matches = matches.filter((f) => f.path.startsWith(pre));
  }
  return { matches, total: matches.length };
}
