import { describe, it, expect } from 'vitest';
import { MockAgent } from 'undici';
import { buildSdk } from '../src/sdk/bindings.js';
import { getSources } from '../src/sdk/sources/index.js';
import { dispatch, type RpcRequest } from '../src/sdk/runtime.js';
import { sourceCfg, CTGOV_ORIGIN, API } from './helpers.js';

const config = { ...sourceCfg(), cacheTtlMs: 60_000, cacheMaxItems: 10 };

// Every SDK method through dispatch (the only way the sandbox reaches the upstream): id, arguments,
// and the exact path and query the upstream must receive.
const reads: Array<[string, unknown[], string]> = [
  ['ctgov.studies.search', [{ 'query.cond': 'flu', pageSize: 5 }], '/studies?query.cond=flu&pageSize=5'],
  ['ctgov.studies.get', ['NCT04852770', { fields: ['NCTId'] }], '/studies/NCT04852770?fields=NCTId'],
  ['ctgov.studies.metadata', [], '/studies/metadata'],
  ['ctgov.studies.searchAreas', [], '/studies/search-areas'],
  ['ctgov.studies.enums', [], '/studies/enums'],
  ['ctgov.stats.size', [], '/stats/size'],
  ['ctgov.stats.fieldValues', [{ fields: ['Phase'] }], '/stats/field/values?fields=Phase'],
  ['ctgov.stats.fieldSizes', [{ fields: ['Condition'] }], '/stats/field/sizes?fields=Condition'],
  ['ctgov.version', [], '/version'],
];

describe('RPC method boundary', () => {
  it('every SDK method reaches its ClinicalTrials.gov endpoint with GET, the right path and query', async () => {
    const failures: string[] = [];
    for (const [id, args, path] of reads) {
      const agent = new MockAgent();
      agent.disableNetConnect();
      try {
        const [binding, ...methodPath] = id.split('.') as [string, ...string[]];
        const value = { endpoint: id };
        agent.get(CTGOV_ORIGIN).intercept({ path: `${API}${path}`, method: 'GET' })
          .reply(200, value, { headers: { 'content-type': 'application/json' } });
        const res = await dispatch(buildSdk({ ...config, dispatcher: agent }), { binding, path: methodPath, args });
        if (JSON.stringify(res) !== JSON.stringify({ ok: true, value })) failures.push(`${id}: ${JSON.stringify(res).slice(0, 200)}`);
      } finally { await agent.close(); }
    }
    expect(failures).toEqual([]);
  });

  it('rejects internal, inherited and removed methods before any upstream access', async () => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    try {
      const sdk = buildSdk({ ...config, dispatcher: agent });
      for (const path of [
        ['http', 'call'], ['client'], ['studiesSearch'], ['studiesGet'], ['statsSize'],
        ['constructor'], ['toString'], ['__proto__', 'toString'],
        ['studies', 'toString'], ['studies', '__proto__', 'toString'], ['studies', 'search', 'call'],
        ['studies.search'], ['studies', 'searchAll'], [], ['missing'],
      ]) {
        const result = await dispatch(sdk, { binding: 'ctgov', path, args: [{}] });
        expect(result.ok, path.join('.')).toBe(false);
        expect(result.error?.name, path.join('.')).toBe('TypeError');
      }
    } finally { await agent.close(); }
  });

  it.each(['__proto__', 'constructor', 'toString', 'odp'])('rejects binding %s', async binding => {
    expect((await dispatch(buildSdk(config), { binding, path: ['toString'], args: [] })).error?.name).toBe('TypeError');
  });

  it('rejects malformed bridge messages without invoking a method', async () => {
    const sdk = buildSdk(config);
    for (const req of [
      null, {}, { binding: null, path: ['version'], args: [] },
      { binding: 'ctgov', path: 'studies.search', args: [] },
      { binding: 'ctgov', path: ['studies', null], args: [] },
      { binding: 'ctgov', path: ['studies', 'search'], args: {} },
    ]) {
      expect(await dispatch(sdk, req as unknown as RpcRequest)).toMatchObject({ ok: false, error: { name: 'TypeError' } });
    }
  });

  it('does not call inherited or accessor entries in method registries', async () => {
    const trap = () => { throw new Error('Registry traversal invoked a getter or inherited method'); };
    const methods = Object.create({ inherited: trap });
    Object.defineProperty(methods, 'accessor', { get: trap });
    const registry = { methods: { test: methods }, meta: [] };
    for (const path of [['inherited'], ['accessor']]) {
      expect(await dispatch(registry, { binding: 'test', path, args: [] })).toMatchObject({ ok: false, error: { name: 'TypeError' } });
    }
  });

  it('keeps the methods table frozen', () => {
    const [source] = getSources(config);
    expect(Object.isFrozen(source!.methods)).toBe(true);
    expect(Object.isFrozen(buildSdk(config).methods)).toBe(true);
  });
});

describe('dispatch error results keep name, message and status', () => {
  it.for([['undefined', undefined], ['null', null], ['a string', 'plain text']] as const)('turns a method that rejects with %s into an error result', async ([, reason]) => {
    const registry = { methods: { ctgov: { 'a.b': () => Promise.reject(reason) } }, meta: [] };
    expect(await dispatch(registry, { binding: 'ctgov', path: ['a', 'b'], args: [] })).toMatchObject({ ok: false, error: { name: 'Error' } });
  });

  it('names validation errors, with a bounded message and no status', async () => {
    const sdk = buildSdk(config);
    const bad = await dispatch(sdk, { binding: 'ctgov', path: ['studies', 'get'], args: ['nct1'] });
    expect(bad).toMatchObject({ ok: false, error: { name: 'ValidationError' } });
    expect(bad.error?.message).toContain('nctId');
    expect(bad.error?.message.length).toBeLessThan(300);
    expect(bad.error?.message).not.toContain('"origin"'); // not zod's raw issue JSON
    expect(bad.error?.status).toBeUndefined();
    const many = await dispatch(sdk, { binding: 'ctgov', path: ['studies', 'search'], args: [Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`bogus${i}`, 1]))] });
    expect(many.error?.name).toBe('ValidationError');
    expect(many.error!.message.length).toBeLessThan(1100);
  });

  it('keeps the nested-key hint and renders it correctly', async () => {
    const res = await dispatch(buildSdk(config), { binding: 'ctgov', path: ['studies', 'search'], args: [{ query: { cond: 'x' }, filter: { geo: 'y' } }] });
    expect(res.error).toMatchObject({
      name: 'ValidationError',
      message: 'studies.search() uses flat dotted keys, not nested objects. Replace { query: { ... }, filter: { ... } } with string keys like '
        + '"query.cond", "query.term", "filter.overallStatus", "filter.geo".',
    });
  });

  it.for([
    [404, 'NotFound'], [400, 'BadRequest'], [500, 'HttpError'],
  ] as const)('maps an upstream %i to %s with the status', async ([status, name]) => {
    const agent = new MockAgent();
    agent.disableNetConnect();
    agent.get(CTGOV_ORIGIN).intercept({ path: `${API}/studies/NCT00000000`, method: 'GET' }).reply(status, { message: 'upstream says no' }).persist();
    try {
      const res = await dispatch(buildSdk({ ...config, dispatcher: agent }), { binding: 'ctgov', path: ['studies', 'get'], args: ['NCT00000000'] });
      expect(res).toMatchObject({ ok: false, error: { name, status } });
      expect(res.error?.message).toContain('upstream says no');
      expect(res.error?.message).not.toContain('?'); // no query string echoed
    } finally { await agent.close(); }
  });
});

describe('method registry and dispatch table stay in sync', () => {
  it('dispatch test table covers every registered method', () => {
    const registered = getSources(config).flatMap(s => Object.keys(s.methods).map(m => `${s.name}.${m}`)).sort();
    expect(reads.map(([id]) => id).sort()).toEqual(registered);
  });
});
