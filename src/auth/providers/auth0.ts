import { ClerkAuthAdapter } from "./clerk.js";

/**
 * Auth0 adapter. `issuer` is the Auth0 tenant URL, e.g.
 * `https://<tenant>.us.auth0.com`. Auth0 JWKS lives at
 * `${issuer}/.well-known/jwks.json` so the defaults in ClerkAuthAdapter
 * apply directly.
 */
export class Auth0AuthAdapter extends ClerkAuthAdapter {}
