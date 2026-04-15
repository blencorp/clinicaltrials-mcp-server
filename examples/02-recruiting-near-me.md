# Example 2 — Recruiting studies near me, with nearest sites

**Prompt**

> I have early-stage non-small-cell lung cancer. Find recruiting trials within
> 50 miles of ZIP 10001 (40.75 N, -73.99 W). Return the top 10 by last-updated
> date with the nearest site's facility and city.

**Expected model flow**

1. `search_api({ query: "geo distance recruiting lung cancer" })`.
2. `execute`:

```js
const page = await ctgov.studies.search({
  "query.cond": "non-small cell lung cancer",
  "filter.overallStatus": ["RECRUITING"],
  "filter.geo": "distance(40.75,-73.99,50mi)",
  sort: ["LastUpdatePostDate:desc"],
  fields: ["NCTId", "BriefTitle", "OverallStatus", "LastUpdatePostDateStruct", "LocationFacility", "LocationCity", "LocationGeoPoint"],
  pageSize: 10,
  countTotal: true,
});
const origin = { lat: 40.75, lon: -73.99 };
const toRad = d => (d * Math.PI) / 180;
const milesBetween = (a, b) => {
  const R = 3958.8;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * R * Math.asin(Math.sqrt(h));
};

return page.studies.map(s => {
  const nearestSite = (s.protocolSection?.contactsLocationsModule?.locations || [])
    .map(loc => {
      const point = loc.geoPoint;
      const distanceMiles =
        point?.lat != null && point?.lon != null
          ? milesBetween(origin, { lat: point.lat, lon: point.lon })
          : Number.POSITIVE_INFINITY;
      return { loc, distanceMiles };
    })
    .sort((a, b) => a.distanceMiles - b.distanceMiles)[0];

  return {
    nct: s.protocolSection?.identificationModule?.nctId,
    title: s.protocolSection?.identificationModule?.briefTitle,
    nearestSite: nearestSite
      ? {
          facility: nearestSite.loc.facility,
          city: nearestSite.loc.city,
          distanceMiles: Number.isFinite(nearestSite.distanceMiles)
            ? Number(nearestSite.distanceMiles.toFixed(1))
            : null,
        }
      : null,
  };
});
```
