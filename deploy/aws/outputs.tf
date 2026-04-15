output "ecr_repository_url" {
  description = "ECR repository URL to push images to."
  value       = aws_ecr_repository.app.repository_url
}

output "alb_dns_name" {
  description = "Public DNS name of the ALB (not used directly — DNS aliased by Route 53)."
  value       = aws_lb.alb.dns_name
}

output "service_url" {
  description = "Public HTTPS URL of the MCP server."
  value       = "https://${var.domain}/mcp"
}

output "prm_url" {
  description = "RFC 9728 Protected Resource Metadata URL."
  value       = "https://${var.domain}/.well-known/oauth-protected-resource"
}

output "deployer_role_arn" {
  description = "IAM role ARN for GitHub Actions OIDC deploys."
  value       = aws_iam_role.deployer.arn
}

output "log_group" {
  description = "CloudWatch log group for the service."
  value       = aws_cloudwatch_log_group.app.name
}

output "secrets_manager_arn" {
  description = "Secrets Manager secret ARN (populated on demand for future upstream creds)."
  value       = aws_secretsmanager_secret.app.arn
}
