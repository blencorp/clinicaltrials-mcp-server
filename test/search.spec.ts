import { describe, it, expect } from 'vitest';
import { Bm25Index, queryTokens, tokenize } from '../src/search/bm25.js';
import { buildCorpus } from '../src/search/corpus.js';
import { getSources } from '../src/sdk/sources/index.js';
import { searchApi } from '../src/tools/searchApi.js';
import { describeSchema } from '../src/tools/describeSchema.js';
import { sourceCfg } from './helpers.js';

const corpus = () => buildCorpus(getSources(sourceCfg()));

describe('bm25', () => {
  it('tokenizes', () => {
    expect(tokenize('Hello, world! THE quick brown fox.')).toEqual(['hello', 'world', 'quick', 'brown', 'fox']);
  });

  it('matches plurals and drops identifiers and question words', () => {
    expect(tokenize('studies trials sponsors class')).toEqual(['study', 'trial', 'sponsor', 'class']);
    expect(queryTokens('what is NCT04852770 eligibility')).toEqual(['eligibility']);
    expect(queryTokens('NCT04852770')).toEqual(['nct04852770']);
    expect(tokenize('shows whats')).toEqual([]);
  });

  it('scores relevant docs higher', () => {
    const idx = new Bm25Index();
    idx.add({ id: 'a', text: 'recruiting studies cancer oncology' });
    idx.add({ id: 'b', text: 'enrollment diabetes' });
    idx.add({ id: 'c', text: 'cancer oncology phase 3 recruiting sponsor' });
    expect(idx.search('phase 3 cancer recruiting', 3)[0]?.id).toBe('c');
    expect(idx.search('')).toEqual([]);
  });
});

describe('corpus', () => {
  it('loads endpoints, syntax notes and the curated study fields', () => {
    const { entries } = corpus();
    expect(entries.has('ctgov.studies.search')).toBe(true);
    expect(entries.has('ctgov.version')).toBe(true);
    expect(entries.has('ctgov.syntax.paging')).toBe(true);
    expect(entries.has('ctgov.fields.protocolSection.statusModule.overallStatus')).toBe(true);
  });
});

describe('search_api tool', () => {
  // Natural-language questions an assistant is likely to ask, and an entry that answers each.
  const cases: Array<[string, string]> = [
    ['search recruiting studies by condition', 'ctgov.studies.search'],
    ['find clinical trials for lung cancer', 'ctgov.studies.search'],
    ['get one study by NCT number', 'ctgov.studies.get'],
    ['what search areas can I use in an essie expression', 'ctgov.studies.searchAreas'],
    ['list of enum values for phase and status', 'ctgov.studies.enums'],
    ['how many studies are in the database', 'ctgov.stats.size'],
    ['distribution of study status values', 'ctgov.stats.fieldValues'],
    ['data version and timestamp', 'ctgov.version'],
    ['trials near me within 50 miles of a location', 'ctgov.syntax.geo'],
    ['how do I read all pages with the next page token', 'ctgov.syntax.paging'],
    ['AREA[] essie range expression for start date', 'ctgov.syntax.essie'],
    ['why does my query say unknown key query', 'ctgov.syntax.search'],
    ['how do I keep the result small with fields', 'ctgov.syntax.fields'],
    ['inclusion and exclusion eligibility criteria text', 'ctgov.fields.protocolSection.eligibilityModule.eligibilityCriteria'],
    ['who is the lead sponsor of the study', 'ctgov.fields.protocolSection.sponsorCollaboratorsModule.leadSponsor.name'],
    ['enrollment count of participants', 'ctgov.fields.protocolSection.designModule.enrollmentInfo.count'],
    ['sites and facilities with geo coordinates', 'ctgov.fields.protocolSection.contactsLocationsModule.locations'],
    // Whole user questions: plurals, question words and identifiers.
    ['Which Phase 3 trials are recruiting for breast cancer?', 'ctgov.studies.search'],
    ["What are the eligibility criteria for NCT04852770?", 'ctgov.fields.protocolSection.eligibilityModule.eligibilityCriteria'],
    ['Is there a searchAll helper to iterate every study?', 'ctgov.syntax.paging'],
  ];

  it('finds the right entry in the top 5 for typical questions', () => {
    const c = corpus();
    const misses = cases.filter(([query, id]) => !searchApi({ query, k: 5 }, c).hits.some(h => h.id === id));
    expect(misses).toEqual([]);
  });

  it('puts the search method first for a plain search question', () => {
    expect(searchApi({ query: 'search studies by condition and status', k: 1 }, corpus()).hits[0]?.id).toBe('ctgov.studies.search');
  });

  it('returns hits with signature and example, and a pointer to the other tools', () => {
    const r = searchApi({ query: 'get one study by NCT id', k: 3 }, corpus());
    expect(r.hits[0]).toMatchObject({ id: 'ctgov.studies.get', kind: 'endpoint', binding: 'ctgov' });
    expect(r.hits[0]!.signature).toContain('ctgov.studies.get(');
    expect(r.hits[0]!.example).toContain('ctgov.studies.get(');
    expect(r.note).toMatch(/describe_schema/);
  });
});

describe('describe_schema tool', () => {
  it('resolves an exact path', () => {
    const r = describeSchema({ path: 'ctgov.studies.search' }, corpus().entries);
    expect(r.found).toBe(true);
    if (r.found) expect(r.entries[0]?.binding).toBe('ctgov');
  });
  it('lists by prefix', () => {
    const r = describeSchema({ prefix: 'ctgov.studies.' }, corpus().entries);
    expect(r.found).toBe(true);
    if (r.found) expect(r.entries.map(e => e.id).sort()).toEqual(['ctgov.studies.enums', 'ctgov.studies.get', 'ctgov.studies.metadata', 'ctgov.studies.search', 'ctgov.studies.searchAreas']);
    const fields = describeSchema({ prefix: 'ctgov.fields.protocolSection.designModule' }, corpus().entries);
    expect(fields.found && fields.entries.length).toBeGreaterThan(2);
  });
  it('returns not-found cleanly', () => {
    expect(describeSchema({ path: 'ctgov.nope' }, corpus().entries).found).toBe(false);
  });
});
