# Example 3 — Eligibility digest for a single study

**Prompt**

> Give me a clean inclusion/exclusion bullet list for NCT04852770 plus key
> design facts (phase, enrollment, primary outcome).

**Expected model flow**

1. `search_api({ query: "eligibility criteria study get nct" })`.
2. `execute`:

```js
const study = await ctgov.studies.get("NCT04852770", {
  fields: [
    "ProtocolSection.IdentificationModule.BriefTitle",
    "ProtocolSection.DesignModule.Phases",
    "ProtocolSection.DesignModule.EnrollmentInfo",
    "ProtocolSection.OutcomesModule.PrimaryOutcomes",
    "ProtocolSection.EligibilityModule",
  ],
});
const elig = study.protocolSection?.eligibilityModule?.eligibilityCriteria || "";
const sections = elig.split(/\n\s*(Inclusion Criteria|Exclusion Criteria)/i);
return {
  title: study.protocolSection?.identificationModule?.briefTitle,
  phases: study.protocolSection?.designModule?.phases,
  enrollment: study.protocolSection?.designModule?.enrollmentInfo?.count,
  primaryOutcomes: study.protocolSection?.outcomesModule?.primaryOutcomes,
  eligibility: sections,
};
```
