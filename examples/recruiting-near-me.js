// Recruiting non-small-cell lung cancer trials within 50 miles of New York City (40.75, -73.99),
// newest update first, each with its nearest site. filter.geo selects the studies; the distance
// to every site is computed here, because a matching study lists all of its sites.
const page = await ctgov.studies.search({
  'query.cond': 'non-small cell lung cancer',
  'filter.overallStatus': ['RECRUITING'],
  'filter.geo': 'distance(40.75,-73.99,50mi)',
  sort: ['LastUpdatePostDate:desc'],
  fields: ['NCTId', 'BriefTitle', 'OverallStatus', 'LastUpdatePostDate', 'LocationFacility', 'LocationCity', 'LocationGeoPoint'],
  pageSize: 10,
  countTotal: true,
});
const origin = { lat: 40.75, lon: -73.99 };
const toRad = d => (d * Math.PI) / 180;
const milesBetween = (a, b) => {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.sqrt(h));
};
const studies = page.studies.map(s => {
  const nearest = (s.protocolSection?.contactsLocationsModule?.locations ?? [])
    .map(loc => ({ loc, miles: loc.geoPoint ? milesBetween(origin, loc.geoPoint) : Infinity }))
    .sort((a, b) => a.miles - b.miles)[0];
  return {
    nctId: s.protocolSection?.identificationModule?.nctId,
    title: s.protocolSection?.identificationModule?.briefTitle,
    nearestSite: nearest && Number.isFinite(nearest.miles)
      ? { facility: nearest.loc.facility, city: nearest.loc.city, miles: Number(nearest.miles.toFixed(1)) }
      : null,
  };
});
return { total: page.totalCount, studies };
