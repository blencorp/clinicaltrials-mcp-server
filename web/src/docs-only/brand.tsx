import type { Brand } from '@/components/kit/brand';
import { base, site } from '../../../site/product.mjs';
import { brand as accountBrand } from '../brand';

// The documentation site's address, from the one place it is written. The npm package does not ship
// the built site (only the Docker image does), so a self-hosted docs-only server may have no /docs of
// its own; the pages link to the hosted copy, which is also correct on the hosted server itself.
const docs = (path = '') => `${site}${base}/${path}`;

/**
 * The portal as `--public-docs` serves it (build mode `docs-only`, web/vite.config.ts aliases
 * `@/brand` to this file): the same product, but no accounts. BLEN's hosted service runs this
 * mode, so these pages must not offer a sign-in or link to /sign-in or /account. The kit's
 * `accounts: false` already removes the header link and the landing button; what is left to say
 * differently is the connect step and the limits.
 */
export const brand: Brand = {
  ...accountBrand,
  accounts: false,
  accountPurpose: 'run queries from your AI assistant',
  docsUrl: docs(),
  connect: {
    signInStep: (
      <>
        Nothing to authorize: this server needs no key and no sign-in. It offers the documentation tools (
        <code>search_api</code> and <code>describe_schema</code>). To run queries with <code>execute</code>, run the
        server on your own computer; the guides explain how.
      </>
    ),
    guidesHref: docs('connect/'),
  },
  howItWorksHref: docs('how-it-works/'),
  sources: accountBrand.sources.map((source) => ({ ...source, href: docs('reference/sdk/') })),
  howItWorks: accountBrand.howItWorks.map((point) =>
    point.title === 'Fair-use limits'
      ? {
          title: 'Open to everyone',
          body: 'No account is needed. This server searches the API reference and reads field definitions; it never calls ClinicalTrials.gov for you, and each address is rate limited.',
        }
      : point,
  ),
};
