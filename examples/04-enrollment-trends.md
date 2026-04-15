# Example 4 — 5-year diabetes trial registration trend

**Prompt**

> Show the count of new interventional diabetes trials registered each year for
> the past 5 years, broken down by overall status.

**Expected model flow**

```js
const buckets = {};
for await (const s of ctgov.studies.searchAll({
  "query.cond": "diabetes",
  "filter.advanced": "AREA[StudyType]INTERVENTIONAL AND AREA[StudyFirstPostDate]RANGE[2020-01-01, MAX]",
  fields: ["NCTId", "OverallStatus", "StudyFirstPostDateStruct"],
  pageSize: 200,
}, { maxPages: 50 })) {
  const date = s.protocolSection?.statusModule?.studyFirstPostDateStruct?.date || "";
  const year = date.slice(0, 4);
  const status = s.protocolSection?.statusModule?.overallStatus || "UNKNOWN";
  if (!buckets[year]) buckets[year] = {};
  buckets[year][status] = (buckets[year][status] || 0) + 1;
}
return buckets;
```
