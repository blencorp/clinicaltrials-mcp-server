# AWS deployment — `clinicaltrial.mcp.blencorp.com`

Terraform module that stands up the hosted remote MCP server on:

- **Amazon ECS on Fargate** — long-lived HTTP/SSE workload, platform version `LATEST` (1.4.0+).
- **Application Load Balancer** — HTTPS listener on 443 with ACM cert (DNS‑validated in Route 53).
- **AWS Certificate Manager** — public cert for `clinicaltrial.mcp.blencorp.com`.
- **Amazon Route 53** — `A`/`AAAA` alias records on the zone for `blencorp.com`.
- **AWS Secrets Manager** — holds Clerk signing metadata injected into the task as env.
- **Amazon CloudWatch Logs** — structured JSON logs at `/ecs/clinicaltrial-mcp-server` (30‑day retention).
- **AWS WAFv2** — web ACL with `AWSManagedRulesCommonRuleSet` +
  `AWSManagedRulesKnownBadInputsRuleSet` + per-IP rate limit rule, attached to the ALB.

The container image is built from `deploy/Dockerfile` and pushed to an ECR
repo that this module creates.

## Prerequisites

1. AWS account with a hosted zone for `blencorp.com` in Route 53.
2. A Clerk application configured with:
   - Frontend API / JWT issuer URL (e.g. `https://clerk.blencorp.com`).
   - DCR (Dynamic Client Registration) enabled for MCP clients.
   - The audience/resource set to `https://clinicaltrial.mcp.blencorp.com/mcp` (RFC 8707).
3. Terraform ≥ 1.7, AWS provider ≥ 5.70, AWS CLI v2 authenticated.
4. Docker + BuildKit for the image build.

## Variables

| Variable | Default | Notes |
|---|---|---|
| `region` | `us-east-1` | Any region that supports Fargate 1.4. |
| `domain` | `clinicaltrial.mcp.blencorp.com` | FQDN the cert + DNS record use. |
| `hosted_zone_name` | `blencorp.com` | Route 53 zone that owns `domain`. |
| `image_tag` | `v0.1.0-alpha.0` | Image tag in ECR. |
| `desired_count` | `2` | ECS service task count. |
| `cpu` | `512` | Task-level vCPU (Fargate units). |
| `memory` | `1024` | Task-level memory (MiB). |
| `clerk_issuer` | — | e.g. `https://clerk.blencorp.com`. |
| `clerk_jwks_url` | — | Optional override. Default `${issuer}/.well-known/jwks.json`. |
| `scopes_supported` | `ctgov.read` | Space-separated. |
| `allow_anthropic_ingress_only` | `true` | When true, WAF allows only Anthropic IP ranges (plus health checks). |

## Deploy

```bash
# One-time
cd deploy/aws
terraform init
terraform plan -out=plan.out
terraform apply plan.out

# Build + push image
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ECR_REPO="$(terraform output -raw ecr_repository_url)"
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.us-east-1.amazonaws.com"
docker buildx build --platform linux/amd64 \
  -t "$ECR_REPO:v0.1.0-alpha.0" \
  -f deploy/Dockerfile . --push

# Roll the service to the new image
aws ecs update-service \
  --cluster clinicaltrial-mcp-server \
  --service clinicaltrial-mcp-server \
  --force-new-deployment
```

## GitHub Actions OIDC

The module provisions an IAM role (`clinicaltrial-mcp-server-deployer`) that trusts
`token.actions.githubusercontent.com` for `repo:blencorp/claude-playground:ref:refs/heads/main`.
Use it in a workflow:

```yaml
permissions:
  id-token: write
  contents: read
steps:
  - uses: aws-actions/configure-aws-credentials@v4
    with:
      role-to-assume: arn:aws:iam::<ACCOUNT_ID>:role/clinicaltrial-mcp-server-deployer
      aws-region: us-east-1
  - run: make deploy
```

## Cost expectations

Idle cost ≈ $35–45/mo (1× ALB, 2× 0.5‑vCPU / 1 GB Fargate tasks, ACM, Route 53,
CloudWatch, WAF). Scales with request volume.
