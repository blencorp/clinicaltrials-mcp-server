# Worked examples

Five prompts that exercise the `search_api` → `execute` pattern. Each shows
the prompt, the call sequence the model should take, and the code body you'd
pass to `execute`.

1. [Phase 3 oncology by sponsor](./01-phase3-oncology-by-sponsor.md)
2. [Recruiting trials near me, with nearest sites](./02-recruiting-near-me.md)
3. [Eligibility digest for a single study](./03-eligibility-digest.md)
4. [5-year diabetes trial registration trend](./04-enrollment-trends.md)
5. [Site-contact dossier for a trial](./05-site-contact-dossier.md)

All examples use only `ctgov.studies.*` / `ctgov.stats.*` and plain JS in the
sandbox — no third-party libs, no filesystem, no outbound network.
