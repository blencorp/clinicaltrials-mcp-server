locals {
  name = "clinicaltrial-mcp-server"

  common_tags = {
    Project     = "clinicaltrial-mcp-server"
    Component   = "remote-mcp-server"
    ManagedBy   = "terraform"
    Environment = "prod"
    Owner       = "opensource@blencorp.com"
  }
}

data "aws_caller_identity" "current" {}

data "aws_availability_zones" "available" {
  state = "available"
}
