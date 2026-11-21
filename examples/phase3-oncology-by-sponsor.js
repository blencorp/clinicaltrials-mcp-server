// Recruiting Phase 3 cancer trials with at least 200 listed sites, grouped by lead sponsor.
// Pages with pageToken; each page is one call against the per-execute budget.
const sponsors = new Map();
let pageToken;
for (let page = 0; page < 25; page++) {
  const res = await ctgov.studies.search({
    'query.cond': 'cancer',
    'filter.overallStatus': ['RECRUITING'],
    'filter.advanced': 'AREA[Phase]PHASE3',
    fields: ['NCTId', 'BriefTitle', 'LeadSponsorName', 'LocationFacility'],
    pageSize: 200,
    ...(pageToken ? { pageToken } : {}),
  });
  for (const s of res.studies) {
    const sites = (s.protocolSection?.contactsLocationsModule?.locations ?? []).length;
    if (sites < 200) continue;
    const sponsor = s.protocolSection?.sponsorCollaboratorsModule?.leadSponsor?.name ?? 'unknown';
    const entry = sponsors.get(sponsor) ?? { count: 0, titles: [] };
    entry.count++;
    entry.titles.push(s.protocolSection?.identificationModule?.briefTitle);
    sponsors.set(sponsor, entry);
  }
  pageToken = res.nextPageToken;
  if (!pageToken) break;
}
return [...sponsors.entries()]
  .sort((a, b) => b[1].count - a[1].count)
  .slice(0, 10)
  .map(([sponsor, v]) => ({ sponsor, count: v.count, titles: v.titles.slice(0, 5) }));
