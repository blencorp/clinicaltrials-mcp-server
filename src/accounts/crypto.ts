import { createHash, randomBytes } from 'node:crypto';

/** One-way SHA-256 hex: OAuth tokens are stored (and looked up) only as digests, and limiter bucket names are hashed. */
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const randomToken = () => randomBytes(32).toString('base64url');
