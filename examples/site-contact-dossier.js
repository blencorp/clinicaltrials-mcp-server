// A markdown dossier for one study: investigators, central contacts, active sites with their
// contacts, and the bounding box of the sites. One upstream call; the rest happens here.
const study = await ctgov.studies.get('NCT04852770', { fields: ['BriefTitle', 'ContactsLocationsModule'] });
const mod = study.protocolSection?.contactsLocationsModule ?? {};
const sites = (mod.locations ?? []).filter(l => (l.status ?? '').toUpperCase() !== 'WITHDRAWN');
const lats = sites.map(l => l.geoPoint?.lat).filter(Number.isFinite);
const lons = sites.map(l => l.geoPoint?.lon).filter(Number.isFinite);
const bbox = lats.length
  ? { minLat: Math.min(...lats), maxLat: Math.max(...lats), minLon: Math.min(...lons), maxLon: Math.max(...lons) }
  : null;
const lines = [
  `# ${study.protocolSection?.identificationModule?.briefTitle ?? ''}`,
  '',
  '## Principal investigators',
  ...(mod.overallOfficials ?? []).map(o => `- ${o.name} - ${o.role} (${o.affiliation ?? 'no affiliation'})`),
  '',
  '## Central contacts',
  ...(mod.centralContacts ?? []).map(c => `- ${c.name ?? '(unnamed)'} - ${c.phone ?? ''} ${c.email ?? ''}`),
  '',
  `## Active sites (${sites.length})`,
  ...sites.map(l => {
    const who = (l.contacts ?? []).map(c => `${c.name ?? '-'} / ${c.role ?? ''} / ${c.phone ?? ''} / ${c.email ?? ''}`).join('; ') || '(no public contact)';
    return `- **${l.facility}** - ${l.city}${l.state ? ', ' + l.state : ''}, ${l.country} - ${who}`;
  }),
  '',
  '## Geo bounding box',
  bbox ? `lat [${bbox.minLat}, ${bbox.maxLat}], lon [${bbox.minLon}, ${bbox.maxLon}]` : 'no active sites with coordinates',
];
return lines.join('\n');
