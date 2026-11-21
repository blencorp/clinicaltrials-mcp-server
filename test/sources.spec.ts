import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { getSources, validateSourceNames } from '../src/sdk/sources/index.js';
import { METHOD_PATHS } from '../src/sdk/sources/ctgov.js';
import { sourceCfg } from './helpers.js';

describe('source registry', () => {
  it('builds ctgov with a corpus, enabled and keyless', () => {
    const sources = getSources(sourceCfg());
    expect(sources.map(s => s.name)).toEqual(['ctgov']);
    expect(sources[0]!.enabled).toBe(true);
    expect(sources[0]!.label).toBe('ClinicalTrials.gov');
    expect(sources[0]!.corpus.endpoints.length).toBeGreaterThan(0);
  });

  it('corpus endpoint ids equal the methods table, with signatures that start with the id', () => {
    for (const s of getSources(sourceCfg())) {
      const methods = Object.keys(s.methods).map(m => `${s.name}.${m}`).sort();
      const endpoints = s.corpus.endpoints.map(e => e.id).sort();
      expect(endpoints).toEqual(methods);
      for (const e of s.corpus.endpoints) {
        expect(e.kind).toBe('endpoint');
        expect(e.binding).toBe(s.name);
        expect(e.signature?.startsWith(e.id)).toBe(true);
      }
      for (const f of s.corpus.fields) { expect(f.kind).toBe('field'); expect(f.binding).toBe(s.name); }
    }
  });

  it('every method maps to a path in the pinned OpenAPI document, and every pinned operation to a method', () => {
    const pinned = JSON.parse(readFileSync('schema/openapi.pinned.json', 'utf8')) as { paths: Record<string, Record<string, unknown>> };
    const pinnedGets = Object.entries(pinned.paths).filter(([, ops]) => 'get' in ops).map(([p]) => p.replace('{nctId}', '{nctId}')).sort();
    expect(Object.values(METHOD_PATHS).sort()).toEqual(pinnedGets);
    expect(Object.keys(METHOD_PATHS).sort()).toEqual(Object.keys(getSources(sourceCfg())[0]!.methods).sort());
  });

  it('ships the corpus in the shared format: provenance, endpoints[], fields[]', () => {
    const corpus = JSON.parse(readFileSync('schema/ctgov.json', 'utf8')) as Record<string, unknown>;
    expect(Object.keys(corpus)).toEqual(['provenance', 'endpoints', 'fields']);
    expect(corpus.provenance).toMatchObject({ generatedBy: 'scripts/regenerate-sdk.ts' });
  });

  it('keeps all 31 curated study fields from the field dictionary', () => {
    const fields = getSources(sourceCfg())[0]!.corpus.fields.filter(f => f.id.startsWith('ctgov.fields.'));
    expect(fields).toHaveLength(31);
    expect(fields.map(f => f.id)).toContain('ctgov.fields.protocolSection.eligibilityModule.eligibilityCriteria');
  });
});

describe('validateSourceNames', () => {
  it('throws for an invalid identifier', () => {
    expect(() => validateSourceNames([{ name: 'ctgov.studies' }])).toThrow(/must be a JS identifier/);
    expect(() => validateSourceNames([{ name: '9bad' }])).toThrow(/must be a JS identifier/);
  });

  it('throws for a denylisted name', () => {
    expect(() => validateSourceNames([{ name: 'console' }])).toThrow(/not allowed/);
    expect(() => validateSourceNames([{ name: 'process' }])).toThrow(/not allowed/);
  });

  it('throws for a duplicate name', () => {
    expect(() => validateSourceNames([{ name: 'ctgov' }, { name: 'ctgov' }])).toThrow(/Duplicate/);
  });

  it('does not throw for a valid name', () => {
    expect(() => validateSourceNames([{ name: 'ctgov' }])).not.toThrow();
  });
});
