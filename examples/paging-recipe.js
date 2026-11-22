// The pageToken loop: read every page of a search with a bounded page count.
// Pass the same parameters on each call plus the previous page's nextPageToken; stop when
// nextPageToken is missing. Every page is one call against the per-execute budget (100), so
// ask for large pages (up to 1000) of few fields instead of many small pages.
const nctIds = [];
let pageToken;
let pages = 0;
for (; pages < 10; pages++) {
  const res = await ctgov.studies.search({
    'query.cond': 'melanoma',
    'filter.overallStatus': ['RECRUITING'],
    fields: ['NCTId'],
    pageSize: 500,
    ...(pageToken ? { pageToken } : {}),
  });
  nctIds.push(...res.studies.map(s => s.protocolSection.identificationModule.nctId));
  pageToken = res.nextPageToken;
  if (!pageToken) break;
}
return { count: nctIds.length, truncated: Boolean(pageToken), first: nctIds.slice(0, 20) };
