/** Shared by regenerate-sdk.ts and verify-pinned-schema.ts: the live API, and what schema/ctgov.json claims about it. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { request } from "undici";
import { METHOD_PATHS } from "../src/sdk/sources/ctgov.js";

export const BASE = process.env.CTGOV_BASE ?? "https://clinicaltrials.gov/api/v2";
/** The published OpenAPI document (YAML), not under the v2 base. */
export const OAS_URL = process.env.CTGOV_OAS_URL ?? `${new URL(BASE).origin}/api/oas/v2`;
export const CORPUS_PATH = resolve("schema", "ctgov.json");
export const OPENAPI_PATH = resolve("schema", "openapi.pinned.json");
const FIELD_PREFIX = "ctgov.fields.";

export interface FieldNode {
  name?: string;
  piece?: string;
  children?: FieldNode[];
}

export async function getJson<T>(path: string): Promise<T> {
  const res = await request(BASE + path, {
    method: "GET",
    headers: { accept: "application/json", "user-agent": "clinicaltrials-mcp-server schema-check/0.1" },
  });
  if (res.statusCode >= 400) throw new Error(`GET ${path} -> ${res.statusCode}`);
  return (await res.body.json()) as T;
}

export interface LiveSpec {
  version: string;
  paths: string[];
}

/**
 * The paths and version of the live OpenAPI document. It is YAML, and only its top-level `paths:`
 * keys and `info.version` matter here, so they are read line by line rather than adding a parser.
 */
export async function liveSpec(): Promise<LiveSpec> {
  const res = await request(OAS_URL, { method: "GET", headers: { "user-agent": "clinicaltrials-mcp-server schema-check/0.1" } });
  if (res.statusCode >= 400) throw new Error(`GET ${OAS_URL} -> ${res.statusCode}`);
  const lines = (await res.body.text()).split("\n");
  const start = lines.findIndex((l) => l.trimEnd() === "paths:");
  if (start < 0) throw new Error(`${OAS_URL} has no top-level paths: key`);
  const paths: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\S/.test(l)) break; // the next top-level key
    const m = /^ {2}(\/\S*):\s*$/.exec(l);
    if (m) paths.push(m[1]!);
  }
  const version = /^ {2}version:\s*"?([^"\s]+)"?/m.exec(lines.join("\n"))?.[1] ?? "unknown";
  return { version, paths };
}

/** Dotted paths of every node in /studies/metadata, by `name` (the form used in study JSON). */
export function metadataPaths(nodes: FieldNode[], prefix = ""): Set<string> {
  const out = new Set<string>();
  for (const n of nodes ?? []) {
    if (!n.name) continue;
    const path = prefix ? `${prefix}.${n.name}` : n.name;
    out.add(path);
    if (n.children?.length) for (const p of metadataPaths(n.children, path)) out.add(p);
  }
  return out;
}

interface Corpus {
  provenance: Record<string, unknown>;
  endpoints: Array<{ id: string }>;
  fields: Array<{ id: string }>;
}

export const readCorpus = (): Corpus => JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as Corpus;

/** The study-field paths the curated ctgov.fields.* entries document. */
export function curatedFieldPaths(corpus: Corpus = readCorpus()): string[] {
  return corpus.fields.filter((f) => f.id.startsWith(FIELD_PREFIX)).map((f) => f.id.slice(FIELD_PREFIX.length));
}

/** Corpus endpoints that do not match the methods table (a drift inside this repository). */
export function endpointMismatches(corpus: Corpus = readCorpus()): string[] {
  const ids = new Set(corpus.endpoints.map((e) => e.id));
  const methods = Object.keys(METHOD_PATHS).map((m) => `ctgov.${m}`);
  return [
    ...methods.filter((m) => !ids.has(m)).map((m) => `method without a corpus endpoint: ${m}`),
    ...[...ids].filter((i) => !methods.includes(i)).map((i) => `corpus endpoint without a method: ${i}`),
  ];
}

/** Curated field paths that the live metadata no longer contains. */
export async function missingFields(): Promise<string[]> {
  const live = metadataPaths(await getJson<FieldNode[]>("/studies/metadata"));
  return curatedFieldPaths().filter((p) => !live.has(p));
}
