# Container config is rendered from Terraform, but a Secrets Manager entry is
# created so runtime rotation (e.g., rotating Clerk keys, future upstream auth
# tokens) doesn't require a Terraform apply.

resource "aws_secretsmanager_secret" "app" {
  name        = "${local.name}/runtime"
  description = "Runtime secrets for ${local.name} (Clerk and future upstream auth)"
}

resource "aws_secretsmanager_secret_version" "app" {
  secret_id = aws_secretsmanager_secret.app.id
  secret_string = jsonencode({
    # Currently all auth config is public and rendered as env vars, but any
    # future secret (e.g., an outgoing API key) should be added here and
    # referenced via `secrets` in the task definition.
    CTGOV_RUNTIME_NOTE = "Populate with outgoing-API credentials as needed."
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
