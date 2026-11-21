import type { Brand } from '@/components/kit/brand';

export const brand: Brand = {
  name: 'ClinicalTrials.gov MCP',
  tagline: 'ClinicalTrials.gov studies in your AI assistant',
  summary:
    'Search and analyze clinical studies from the official ClinicalTrials.gov API, in Claude, ChatGPT, Cursor and other MCP clients.',
  repoUrl: 'https://github.com/blencorp/clinicaltrials-mcp-server',
  docsUrl: '/docs/',
  license: 'Apache-2.0',
  disclaimer:
    'Independent open-source project; not affiliated with or endorsed by the NIH, the National Library of Medicine or ClinicalTrials.gov. Not medical advice.',
  accountPurpose: 'run queries from your AI assistant',
  connect: {
    signInStep: (
      <>
        Sign in with Google and approve the connection. No API key is needed: ClinicalTrials.gov is public. Signing in
        enables running queries (<code>execute</code>) under fair-use limits.
      </>
    ),
    publicNote:
      'Browse the API documentation tools without signing in. Running queries needs a sign-in, so use the server URL above for that.',
    guidesHref: '/docs/connect/',
  },
  examples: [
    { title: 'Eligibility digest', prompt: 'Summarize the inclusion and exclusion criteria, phase and enrollment of study NCT04852770.' },
    { title: 'Sponsors by trial count', prompt: 'Which sponsors run the most recruiting Phase 3 cancer trials with at least 200 sites?' },
    { title: 'Trials near me', prompt: 'Find recruiting non-small-cell lung cancer trials within 50 miles of New York City, newest first.' },
    { title: 'Registration trends', prompt: 'How many interventional diabetes studies were registered each year since 2020, by status?' },
    { title: 'Site contacts', prompt: 'Build a contact dossier for study NCT04852770: investigators, central contacts and active sites.' },
    { title: 'Read every page', prompt: 'List the NCT IDs of recruiting melanoma studies across as many pages as needed.' },
  ],
  sources: [
    {
      name: 'ClinicalTrials.gov API v2',
      description: 'Study records, search, field statistics and data version from the U.S. National Library of Medicine.',
      href: '/docs/reference/sdk/',
    },
  ],
  howItWorks: [
    {
      title: 'Three tools',
      body: 'Your assistant searches the API reference, reads field definitions, and writes a short program instead of calling dozens of narrow tools.',
    },
    {
      title: 'A locked-down sandbox',
      body: 'Programs run without network, filesystem or environment access. They can only call the ClinicalTrials.gov read methods this server exposes.',
    },
    {
      title: 'Fair-use limits',
      body: 'Public data needs no key. Requests are paced to a shared upstream rate, and each account has hourly and daily limits.',
    },
  ],
  howItWorksHref: '/docs/how-it-works/',
};
