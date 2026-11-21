import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MockAgent } from 'undici';
import { preflight } from '../src/sandbox/policy.js';
import { DenoRunner } from '../src/sandbox/deno.js';
import { IsolateRunner } from '../src/sandbox/isolate.js';
import { buildSdk } from '../src/sdk/bindings.js';
import { dispatch } from '../src/sdk/runtime.js';
import { sourceCfg, CTGOV_ORIGIN, API } from './helpers.js';

// examples/ is documented as paste-ready input for `execute`, so it must pass the same preflight
// the tool applies (plain JavaScript, no TypeScript syntax) and run against the real SDK.
const dir = resolve(__dirname, '../examples');
const examples = readdirSync(dir).filter(f => f.endsWith('.js')).map(f => [f, readFileSync(resolve(dir, f), 'utf8')] as const);

// One canned page shaped to satisfy every example's property accesses, through the real SDK
// (validation, serialization, HttpClient) with the network replaced by a MockAgent.
const study = {
  protocolSection: {
    identificationModule: { nctId: 'NCT04852770', briefTitle: 'A study' },
    statusModule: { overallStatus: 'RECRUITING', studyFirstPostDateStruct: { date: '2021-04-21' } },
    sponsorCollaboratorsModule: { leadSponsor: { name: 'Acme Pharma' } },
    designModule: { phases: ['PHASE3'], enrollmentInfo: { count: 300 } },
    outcomesModule: { primaryOutcomes: [{ measure: 'Overall survival' }] },
    eligibilityModule: { eligibilityCriteria: 'Inclusion Criteria:\n\n* Age 18+\n* Confirmed diagnosis\n\nExclusion Criteria:\n\n* Pregnancy' },
    contactsLocationsModule: {
      overallOfficials: [{ name: 'Dr A', role: 'PRINCIPAL_INVESTIGATOR', affiliation: 'Hospital' }],
      centralContacts: [{ name: 'Contact', phone: '555', email: 'a@example.org' }],
      locations: Array.from({ length: 250 }, (_, i) => ({ facility: `Site ${i}`, city: 'New York', state: 'NY', country: 'United States', status: 'RECRUITING', geoPoint: { lat: 40.7 + i / 1000, lon: -74 }, contacts: [{ name: 'C', role: 'CONTACT' }] })),
    },
  },
};
const page = { studies: [study], totalCount: 1 };

function sdkWithCannedUpstream(): { sdk: ReturnType<typeof buildSdk>; agent: MockAgent } {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get(CTGOV_ORIGIN);
  pool.intercept({ path: p => p.startsWith(`${API}/studies/NCT`), method: 'GET' }).reply(200, study, { headers: { 'content-type': 'application/json' } }).persist();
  pool.intercept({ path: p => p.startsWith(`${API}/studies?`), method: 'GET' }).reply(200, page, { headers: { 'content-type': 'application/json' } }).persist();
  return { sdk: buildSdk({ ...sourceCfg({ dispatcher: agent }), cacheTtlMs: 60_000, cacheMaxItems: 50 }), agent };
}

describe('examples/', () => {
  it('contains only paste-ready .js snippets, and the README lists each', () => {
    expect(examples.length).toBeGreaterThan(0);
    expect(readdirSync(dir).filter(f => f.endsWith('.ts') || f.endsWith('.md') && f !== 'README.md')).toEqual([]);
    const readme = readFileSync(resolve(dir, 'README.md'), 'utf8');
    for (const [name] of examples) expect(readme, name).toContain(`(./${name})`);
  });

  it.each(examples)('%s passes execute preflight, and never uses searchAll', (_name, code) => {
    expect(preflight(code)).toMatchObject({ ok: true });
    expect(code).not.toContain('searchAll');
  });

  it('preflight rejects TypeScript type annotations (why the examples are plain JS)', () => {
    expect(preflight('const x: number = 1; return x;').ok).toBe(false);
  });

  describe.each([new IsolateRunner(), new DenoRunner()])('$kind', runner => {
    // `it.for` (not `it.each`) passes the test context, which carries `skip`.
    it.for(examples)('%s runs against the SDK and returns a value', async ([, code], { skip }) => {
      if (!(await runner.available())) return skip();
      const { sdk, agent } = sdkWithCannedUpstream();
      try {
        const res = await runner.execute(
          { code, bindings: sdk.registeredNames, timeoutMs: 10_000 },
          { dispatch: req => dispatch(sdk, req) },
        );
        expect(res.error).toBeUndefined();
        expect(res.ok).toBe(true);
        expect(res.value).toBeDefined();
      } finally { await agent.close(); }
    });
  });
});
