# SDK reference

Inside `execute`, the global `ctgov` exposes the public ClinicalTrials.gov v2 API (read-only, no API
key). Every method takes and returns plain JSON data; there are no iterators, classes or callbacks.
`search_api` and `describe_schema` serve the same text as this page, so a model rarely needs to read
it. The method section below is generated from `schema/ctgov.json`; the rest is hand-written.

## Search parameters

`ctgov.studies.search(params)` takes **flat dotted string keys**, never nested objects:

```js
await ctgov.studies.search({
  'query.cond': 'lung cancer',                      // right
  'filter.overallStatus': ['RECRUITING'],
  fields: ['NCTId', 'BriefTitle'],
  pageSize: 20,
});
// { query: { cond: 'lung cancer' } }  is rejected with a ValidationError that names the fix
```

Unknown keys are rejected before any request is made.

| Key | Meaning |
|---|---|
| `query.cond`, `query.term`, `query.intr`, `query.locn`, `query.titles`, `query.outc`, `query.spons`, `query.lead`, `query.id`, `query.patient` | Text queries over conditions, free text, interventions, locations, titles, outcomes, sponsors, lead sponsor, ids and patient-friendly text. Essie expressions are allowed. |
| `filter.overallStatus` | Array of status enums: `RECRUITING`, `NOT_YET_RECRUITING`, `ACTIVE_NOT_RECRUITING`, `COMPLETED`, `TERMINATED`, `SUSPENDED`, `WITHDRAWN`, `UNKNOWN`, `ENROLLING_BY_INVITATION`, `NO_LONGER_AVAILABLE`, `APPROVED_FOR_MARKETING`, `AVAILABLE`, `TEMPORARILY_NOT_AVAILABLE`. |
| `filter.geo` | `distance(latitude,longitude,radius)`, for example `distance(42.36,-71.06,50mi)`. |
| `filter.ids` | Array of NCT ids. |
| `filter.advanced` | An Essie expression (below). |
| `postFilter.overallStatus` | Like `filter.overallStatus`, applied after aggregation. |
| `aggFilters`, `geoDecay` | Pass-through strings for the API's aggregation filters and geo decay. |
| `fields` | Array (or comma string) of piece names to return. |
| `sort` | `FieldName:asc` or `:desc`, or `@relevance`; an array or a comma string. |
| `countTotal` | `true` adds `totalCount` to the response. |
| `pageSize` | 0 to 1000 (API default 10). |
| `pageToken` | The previous page's `nextPageToken`. |
| `format`, `markupFormat` | `json` or `csv`; `markdown` or `legacy`. A `csv` result is returned as raw text. |

Arrays are sent comma-joined and booleans as `true` or `false`.

## Essie expressions (`AREA[]`)

`filter.advanced` and the `query.*` keys accept Essie expressions. `AREA[Name]` addresses a search
area or a field; `RANGE[low, high]` takes dates or numbers, with `MIN` and `MAX` as open ends; `AND`,
`OR`, `NOT` and parentheses combine terms.

```text
AREA[Phase]PHASE3
AREA[StartDate]RANGE[2020-01-01, MAX]
AREA[EnrollmentCount]RANGE[100, 500]
AREA[LeadSponsorClass]INDUSTRY AND AREA[StudyType]INTERVENTIONAL
```

`ctgov.studies.searchAreas()` lists the area names; `ctgov.studies.enums()` the enum values.

## `filter.geo`

`filter.geo` keeps studies with at least one site inside the radius (`mi` or `km`). The matching study
still lists **all** its sites, so compute distances to the sites in the sandbox when you need the
nearest one (see `examples/recruiting-near-me.js`).

## Paging: `pageToken` and `countTotal`

A response carries up to `pageSize` studies and, when more remain, `nextPageToken`. Send it back as
`pageToken` with otherwise identical parameters, and stop when it is missing. `countTotal: true` adds
`totalCount` (ask for it on the first page only). There is no `searchAll`: write the loop, with a
page limit, as in `examples/paging-recipe.js`. Every page is one call against the per-execute
budget (100 calls), so prefer pages of a few hundred studies with few fields.

## `fields` and the result budget

A full study record can be hundreds of KiB. An `execute` result over 256 KiB fails with
`ResultTooLarge`, and an upstream response over 8 MiB with `ResponseTooLarge`. Pass `fields` (piece
names such as `NCTId`, `BriefTitle`, `OverallStatus`, `Phase`, `EnrollmentCount`, `LeadSponsorName`,
`Condition`, `InterventionName`, `EligibilityCriteria`, `LocationFacility`, `LocationGeoPoint`;
`ctgov.studies.metadata()` lists them all) and return only the values you need.

## NCT ids

An NCT id is `NCT` followed by eight digits. `studies.get` validates it before any request.

## Errors

SDK errors keep `name`, `message` and `status` inside the sandbox and in the `execute` result's
`error`: `ValidationError` (bad arguments, never sent upstream), `BadRequest` (400), `NotFound` (404),
`RateLimited` (429, or this server's request queue is full), `UpstreamTimeout`, `UpstreamUnavailable`,
`HttpError` (other 5xx), `ResponseTooLarge`, `CallBudgetExceeded` and `SubjectQuotaExceeded`.
Validation messages are short and name the offending key.

## Method reference

<!-- BEGIN GENERATED: method reference (scripts/gen-sdk-reference.mjs) -->

_Generated from `schema/ctgov.json`; edit it, then run `node scripts/gen-sdk-reference.mjs`._

### `ctgov.studies`

#### `ctgov.studies.search(params)`

Search studies (GET /studies) by condition, intervention, location, sponsor or free text, with status and geo filters. Parameters are FLAT dotted string keys, never nested objects: 'query.cond', 'query.term', 'query.intr', 'query.locn', 'query.spons', 'filter.overallStatus' (array of status enums), 'filter.geo', 'filter.advanced' (Essie expression); plus fields, sort, countTotal, pageSize (1-1000) and pageToken. See ctgov.syntax.search, ctgov.syntax.essie, ctgov.syntax.geo and ctgov.syntax.paging. Returns { studies: [...], nextPageToken?, totalCount? }. Always pass fields: full study records are large and a result over 256 KiB fails.

```js
const page = await ctgov.studies.search({ 'query.cond': 'lung cancer', 'filter.overallStatus': ['RECRUITING'], fields: ['NCTId', 'BriefTitle', 'Phase'], pageSize: 20, countTotal: true }); return { total: page.totalCount, studies: page.studies.map(s => s.protocolSection.identificationModule) }
```

#### `ctgov.studies.get(nctId, { fields?, format?, markupFormat? })`

One study by NCT ID (GET /studies/{nctId}); nctId must match NCT followed by 8 digits. fields projects the record (piece names or dotted module names). format is 'json' (default, parsed), 'csv', 'fhir.json' or 'ris'; csv and ris come back as raw text. Returns the study object ({ protocolSection, resultsSection?, derivedSection?, hasResults }).

```js
const s = await ctgov.studies.get('NCT04852770', { fields: ['NCTId', 'BriefTitle', 'OverallStatus', 'EligibilityCriteria'] }); return s.protocolSection
```

#### `ctgov.studies.metadata({ includeIndexedOnly?, includeHistoricOnly? })`

The study data model (GET /studies/metadata): a tree of field nodes with name, piece (the name to use in fields), type, sourceType and children. Large; filter it in the sandbox and return only the matching nodes. Use describe_schema for the curated field list first.

```js
const tree = await ctgov.studies.metadata(); return tree.map(n => ({ name: n.name, piece: n.piece, children: (n.children ?? []).length }))
```

#### `ctgov.studies.searchAreas()`

The search areas (GET /studies/search-areas): [{ name: 'Study', areas: [{ name (BasicSearch, ConditionSearch, ...), param (the query.* key it backs), parts: [{ pieces, weight }] }] }]. Useful for choosing the area names in an Essie AREA[...] expression and the query.* key that searches a given field set.

```js
const [study] = await ctgov.studies.searchAreas(); return study.areas.map(a => ({ area: a.name, param: a.param }))
```

#### `ctgov.studies.enums()`

All enumeration types and their values (GET /studies/enums), e.g. Status, Phase, StudyType. Use it to spell filter.overallStatus values and phase names exactly.

```js
const enums = await ctgov.studies.enums(); return enums.find(x => x.type === 'Status')
```

### `ctgov.stats`

#### `ctgov.stats.size()`

Size statistics of the whole database (GET /stats/size): { totalStudies, averageSizeBytes, ranges[] }.

```js
return await ctgov.stats.size()
```

#### `ctgov.stats.fieldValues({ fields: string[], types?: string[] })`

Value distribution of one or more fields across all studies (GET /stats/field/values): for enum fields the count per value (e.g. OverallStatus, Phase), for others missing and distinct counts. fields is required and non-empty; types optionally limits to ENUM, STRING, DATE, INTEGER, NUMBER, BOOLEAN.

```js
const stats = await ctgov.stats.fieldValues({ fields: ['OverallStatus'] }); return stats[0].topValues
```

#### `ctgov.stats.fieldSizes({ fields: string[] })`

Size statistics of array fields across all studies (GET /stats/field/sizes): min, max and a histogram of list lengths, e.g. for Phase, Condition or LocationFacility. fields is required and non-empty.

```js
const sizes = await ctgov.stats.fieldSizes({ fields: ['Condition'] }); return sizes[0]
```

### `ctgov`

#### `ctgov.version()`

API and data timestamp versions (GET /version): { apiVersion, dataTimestamp }. Cheap health check and a way to cite the data snapshot.

```js
return await ctgov.version()
```

<!-- END GENERATED: method reference -->
