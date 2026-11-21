// Inclusion and exclusion criteria plus key design facts for one study.
const study = await ctgov.studies.get('NCT04852770', {
  fields: ['NCTId', 'BriefTitle', 'Phase', 'EnrollmentCount', 'PrimaryOutcomeMeasure', 'EligibilityCriteria'],
});
const p = study.protocolSection ?? {};
const criteria = p.eligibilityModule?.eligibilityCriteria ?? '';
const [inclusion = '', exclusion = ''] = criteria.split(/\n\s*Exclusion Criteria:?/i);
const bullets = text => text.split('\n').map(l => l.trim()).filter(l => /^[*-]\s+/.test(l)).map(l => l.replace(/^[*-]\s+/, ''));
return {
  title: p.identificationModule?.briefTitle,
  phases: p.designModule?.phases,
  enrollment: p.designModule?.enrollmentInfo?.count,
  primaryOutcomes: (p.outcomesModule?.primaryOutcomes ?? []).map(o => o.measure),
  inclusion: bullets(inclusion),
  exclusion: bullets(exclusion),
};
