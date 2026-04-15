variable "region" {
  description = "AWS region to deploy into."
  type        = string
  default     = "us-east-1"
}

variable "domain" {
  description = "Public hostname of the MCP server (must match ACM cert)."
  type        = string
  default     = "clinicaltrial.mcp.blencorp.com"
}

variable "hosted_zone_name" {
  description = "Route 53 hosted zone that owns `domain`."
  type        = string
  default     = "blencorp.com"
}

variable "image_tag" {
  description = "ECR image tag to deploy."
  type        = string
  default     = "v0.1.0-alpha.0"
}

variable "desired_count" {
  description = "Number of Fargate tasks."
  type        = number
  default     = 2
}

variable "cpu" {
  description = "Task-level vCPU units."
  type        = number
  default     = 512
}

variable "memory" {
  description = "Task-level memory in MiB."
  type        = number
  default     = 1024
}

variable "clerk_issuer" {
  description = "Clerk Frontend API / JWT issuer URL."
  type        = string
}

variable "clerk_jwks_url" {
  description = "Optional override for the JWKS URL."
  type        = string
  default     = ""
}

variable "scopes_supported" {
  description = "Space-separated OAuth scopes advertised by PRM."
  type        = string
  default     = "ctgov.read"
}

variable "allow_anthropic_ingress_only" {
  description = "When true, WAF allows only Anthropic's documented CIDR ranges."
  type        = bool
  default     = true
}

variable "anthropic_cidrs" {
  description = "CIDR ranges allowed when `allow_anthropic_ingress_only` is true. Update when Anthropic publishes new ranges."
  type        = list(string)
  default = [
    # Placeholder — replace with the current Anthropic-published egress ranges
    # before applying in production. See:
    # https://support.claude.com/en/articles/12922490-remote-mcp-server-submission-guide
    "160.79.104.0/23"
  ]
}

variable "github_owner_repo" {
  description = "owner/repo that the deployer OIDC role trusts."
  type        = string
  default     = "blencorp/claude-playground"
}

variable "github_ref" {
  description = "Git ref allowed to assume the deployer role."
  type        = string
  default     = "refs/heads/main"
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the task log group."
  type        = number
  default     = 30
}
