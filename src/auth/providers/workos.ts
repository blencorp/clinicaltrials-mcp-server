import { ClerkAuthAdapter } from "./clerk.js";

/**
 * WorkOS AuthKit — OIDC + RFC 7591 DCR, purpose-built for MCP.
 * `issuer` is the AuthKit domain, e.g. "https://api.workos.com/user_management/<client_id>"
 * or a custom domain.
 */
export class WorkOsAuthAdapter extends ClerkAuthAdapter {}
