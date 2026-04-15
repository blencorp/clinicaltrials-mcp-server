# Example 1 — Active Phase 3 oncology trials, grouped by lead sponsor

**Prompt**

> List currently recruiting Phase 3 oncology trials with at least 200 listed
> sites, grouped by lead sponsor. Return the top 10 sponsors by trial count,
> with the trial titles for each.

**What the model should do**

1. Call `search_api({ query: "phase 3 oncology recruiting sponsor" })` to pull
   the relevant SDK slice (the `searchStudies` signature and the relevant
   study fields).
2. Call `execute` with:

```js
const sponsors = new Map();
for await (const s of ctgov.studies.searchAll({
  "query.cond": "cancer",
  "filter.overallStatus": ["RECRUITING"],
  "filter.advanced": "AREA[Phase]PHASE3",
  fields: [
    "NCTId",
    "BriefTitle",
    "LeadSponsorName",
    "LocationFacility",
  ],
  pageSize: 200,
}, { maxPages: 25 })) {
  const sites = (s.protocolSection?.contactsLocationsModule?.locations || []).length;
  if (sites < 200) continue;
  const sponsor = s.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name ?? "unknown";
  const entry = sponsors.get(sponsor) || { count: 0, titles: [] };
  entry.count++;
  entry.titles.push(s.protocolSection?.identificationModule?.briefTitle);
  sponsors.set(sponsor, entry);
}
return [...sponsors.entries()]
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, 10)
  .map(([sponsor, v]) => ({ sponsor, count: v.count, titles: v.titles.slice(0, 5) }));
```
