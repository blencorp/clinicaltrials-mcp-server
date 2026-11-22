// New interventional diabetes studies registered since 2020, counted per year and status.
// Only three fields per study are requested, so 200-study pages stay small.
const buckets = {};
let pageToken;
for (let page = 0; page < 50; page++) {
  const res = await ctgov.studies.search({
    'query.cond': 'diabetes',
    'filter.advanced': 'AREA[StudyType]INTERVENTIONAL AND AREA[StudyFirstPostDate]RANGE[2020-01-01, MAX]',
    fields: ['NCTId', 'OverallStatus', 'StudyFirstPostDate'],
    pageSize: 200,
    ...(pageToken ? { pageToken } : {}),
  });
  for (const s of res.studies) {
    const year = (s.protocolSection?.statusModule?.studyFirstPostDateStruct?.date ?? '').slice(0, 4);
    const status = s.protocolSection?.statusModule?.overallStatus ?? 'UNKNOWN';
    buckets[year] ??= {};
    buckets[year][status] = (buckets[year][status] ?? 0) + 1;
  }
  pageToken = res.nextPageToken;
  if (!pageToken) break;
}
return buckets;
