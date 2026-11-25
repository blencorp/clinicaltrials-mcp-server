import { defineRailway, github, project, service } from 'railway/iac';
// This repository manages only its own resources in the environment. Other
// repositories export their own partial name.
// See https://docs.railway.com/infrastructure-as-code#multi-repo-projects
export const partial = 'clinicaltrials-mcp-server';
// The only Railway config for this service: railway.json/railway.toml are no longer read after 2026-12-01.
// Apply changes with `railway config apply`.
export default defineRailway(() => {
  const clinicaltrialMcp = service('clinicaltrial-mcp', {
    // Railway builds and deploys main from GitHub.
    source: github('blencorp/clinicaltrials-mcp-server', { branch: 'main' }),
    // Railway keeps its Railpack default unless the Dockerfile path is set too. No start command:
    // the image's default (`--http --public-docs`, the anonymous docs-only service) applies.
    build: { buildEnvironment: 'V3', builder: 'DOCKERFILE', dockerfilePath: 'deploy/Dockerfile' },
    healthcheck: '/health',
    healthcheckTimeout: 60,
    // Restart on failure (Railway's default type, stored as unset), at most 5 times.
    deploy: { restartPolicyMaxRetries: 5 },
    // One replica: the gate, caches and per-IP limiter are in memory, so a second instance (or an old and a
    // new one serving together during a deploy) would split the process-wide upstream rate.
    replicas: { 'us-east4-eqdc4a': 1 },
    domains: ['clinicaltrials.mcp.blencorp.com'],
  });

  return project('clinicaltrial-mcp-server', {
    // Secrets stay set in Railway. Without this, IaC would manage every service variable.
    // @ts-expect-error -- the railway 3.17.0 types lack project `variables`; the CLI reads it.
    variables: { managed: false },
    resources: [clinicaltrialMcp],
  });
});
