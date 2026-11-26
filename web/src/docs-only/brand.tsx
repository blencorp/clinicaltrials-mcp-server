import type { Brand } from '@/components/kit/brand';
import { brand as accountBrand } from '../brand';

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
  connect: {
    signInStep: (
      <>
        Nothing to authorize: this server needs no key and no sign-in. It offers the documentation tools (
        <code>search_api</code> and <code>describe_schema</code>). To run queries with <code>execute</code>, run the
        server on your own computer; the guides explain how.
      </>
    ),
    guidesHref: accountBrand.connect.guidesHref,
  },
  howItWorks: accountBrand.howItWorks.map((point) =>
    point.title === 'Fair-use limits'
      ? {
          title: 'Open to everyone',
          body: 'No account is needed. This server searches the API reference and reads field definitions; it never calls ClinicalTrials.gov for you, and each address is rate limited.',
        }
      : point,
  ),
};
