resource "aws_wafv2_ip_set" "anthropic" {
  count              = var.allow_anthropic_ingress_only ? 1 : 0
  name               = "${local.name}-anthropic"
  description        = "Anthropic-published egress CIDRs allowed to hit the MCP server"
  scope              = "REGIONAL"
  ip_address_version = "IPV4"
  addresses          = var.anthropic_cidrs
}

resource "aws_wafv2_web_acl" "this" {
  name  = local.name
  scope = "REGIONAL"

  default_action {
    dynamic "allow" {
      for_each = var.allow_anthropic_ingress_only ? [] : [1]
      content {}
    }
    dynamic "block" {
      for_each = var.allow_anthropic_ingress_only ? [1] : []
      content {}
    }
  }

  # Always allow the ALB health checks (EC2/ELB internal)
  dynamic "rule" {
    for_each = var.allow_anthropic_ingress_only ? [1] : []
    content {
      name     = "AllowAnthropicIngress"
      priority = 0

      action {
        allow {}
      }

      statement {
        ip_set_reference_statement {
          arn = aws_wafv2_ip_set.anthropic[0].arn
        }
      }

      visibility_config {
        sampled_requests_enabled   = true
        cloudwatch_metrics_enabled = true
        metric_name                = "AllowAnthropicIngress"
      }
    }
  }

  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 10

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "CommonRuleSet"
    }
  }

  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 11

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "KnownBadInputs"
    }
  }

  rule {
    name     = "RateLimitPerIP"
    priority = 20

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = 2000
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "RateLimitPerIP"
    }
  }

  visibility_config {
    sampled_requests_enabled   = true
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
  }
}

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = aws_lb.alb.arn
  web_acl_arn  = aws_wafv2_web_acl.this.arn
}
