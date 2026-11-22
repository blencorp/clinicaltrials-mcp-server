# Examples

Each file here is a program you can paste verbatim into the `execute` tool. They are plain
JavaScript (the sandbox rejects TypeScript type annotations) and use top-level `await` and `return`,
which `execute` allows because it wraps your code in an async function. `ctgov` is a sandbox global,
so the files are not runnable with plain `node`. `test/examples.spec.ts` runs each one in both
sandbox runners against a canned response to keep them pasteable.

| File | Demonstrates |
|------|--------------|
| [`paging-recipe.js`](./paging-recipe.js) | The `pageToken` loop: read all pages of a search with a bounded page count. |
| [`phase3-oncology-by-sponsor.js`](./phase3-oncology-by-sponsor.js) | `filter.advanced` (Essie `AREA[...]`), paging and grouping by lead sponsor. |
| [`recruiting-near-me.js`](./recruiting-near-me.js) | `filter.geo`, sorting, `countTotal` and computing the nearest site in the sandbox. |
| [`eligibility-digest.js`](./eligibility-digest.js) | `studies.get` with `fields`; splitting eligibility criteria into bullets. |
| [`registration-trend.js`](./registration-trend.js) | A date range in `filter.advanced`, paging and counting per year and status. |
| [`site-contact-dossier.js`](./site-contact-dossier.js) | One `studies.get` call, then a markdown report assembled in the sandbox. |

## Tips for sandboxed code

- There is no `searchAll`. Loop on `nextPageToken` with `pageToken`; every page is one call, and one
  `execute()` may make at most 100 `ctgov` calls.
- Always pass `fields`. A full study record can be hundreds of KiB; upstream responses over 8 MiB fail
  with `ResponseTooLarge`, and a value over 256 KiB returned from `execute` fails with `ResultTooLarge`.
  Return only the attributes you need.
- Use flat dotted keys: `'query.cond'`, `'filter.overallStatus'`, never nested objects.
- `countTotal: true` adds `totalCount` to the first page; send it once.
- SDK errors (`ValidationError`, `NotFound`, `RateLimited`, ...) carry `name`, `message` and `status`.
  Uncaught, they end the execution and come back in the result's `error` field.

See [`../docs/sdk-reference.md`](../docs/sdk-reference.md) for the full method list, or call
`search_api({ query: '...' })` / `describe_schema(...)` from the model.
