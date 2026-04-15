export function requiredResourceScopes(supportedScopes: string[]): string[] {
  const resourceScopes = supportedScopes.filter((scope) => scope.startsWith("ctgov."));
  return resourceScopes.length > 0 ? resourceScopes : supportedScopes;
}

export function hasRequiredResourceScope(
  grantedScopes: string[],
  supportedScopes: string[],
): boolean {
  const requiredScopes = requiredResourceScopes(supportedScopes);
  if (requiredScopes.length === 0) return true;
  if (grantedScopes.includes("*")) return true;
  const granted = new Set(grantedScopes);
  return requiredScopes.some((scope) => granted.has(scope));
}

export function isSessionSubjectAuthorized(
  sessionSubject: string | undefined,
  principalSubject: string | undefined,
): boolean {
  if (sessionSubject === undefined) return true;
  return principalSubject !== undefined && sessionSubject === principalSubject;
}
