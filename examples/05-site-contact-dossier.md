# Example 5 — Site-contact dossier for a single trial

**Prompt**

> For NCT04852770, build a one-page markdown dossier with the principal
> investigator, per-site contacts (name, phone, email, facility), and the
> geo bounding box of all active sites. Exclude sites with status
> "Withdrawn".

**Expected model flow**

1. `search_api({ query: "contacts locations facility officials" })` — pull
   the relevant SDK slice and the `contactsLocationsModule` field doc.
2. `execute`:

```js
const study = await ctgov.studies.get("NCT04852770", {
  fields: [
    "ProtocolSection.IdentificationModule.BriefTitle",
    "ProtocolSection.ContactsLocationsModule",
  ],
});
const mod = study.protocolSection?.contactsLocationsModule;
const locations = (mod?.locations || []).filter(
  (l) => (l.status || "").toUpperCase() !== "WITHDRAWN",
);

const officials = mod?.overallOfficials || [];
const centralContacts = mod?.centralContacts || [];

const lats = locations.map(l => l.geoPoint?.lat).filter(Number.isFinite);
const lons = locations.map(l => l.geoPoint?.lon).filter(Number.isFinite);
const bbox = lats.length
  ? { minLat: Math.min(...lats), maxLat: Math.max(...lats),
      minLon: Math.min(...lons), maxLon: Math.max(...lons) }
  : null;

const lines = [
  `# ${study.protocolSection?.identificationModule?.briefTitle || ""}`,
  ``,
  `## Principal investigators`,
  ...officials.map(o => `- ${o.name} — ${o.role} (${o.affiliation || "—"})`),
  ``,
  `## Central contacts`,
  ...centralContacts.map(c => `- ${c.name || "(unnamed)"} — ${c.phone || ""} ${c.email || ""}`),
  ``,
  `## Active sites (${locations.length})`,
  ...locations.map(l => {
    const who = (l.contacts || []).map(c =>
      `${c.name || "—"} / ${c.role || ""} / ${c.phone || ""} / ${c.email || ""}`
    ).join("; ") || "(no public contact)";
    return `- **${l.facility}** — ${l.city}${l.state ? ", "+l.state : ""}, ${l.country} — ${who}`;
  }),
  ``,
  `## Geo bounding box`,
  bbox ? `lat [${bbox.minLat}, ${bbox.maxLat}], lon [${bbox.minLon}, ${bbox.maxLon}]` : "no active sites with geo",
];
return lines.join("\n");
```

Notice how the model does the filtering, flattening, and markdown assembly
entirely inside the sandbox — only one upstream API call is made, and the
returned value is already formatted for chat display.
