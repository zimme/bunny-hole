data "bunnynet_compute_container_imageregistry" "ghcr_public" {
  registry = "GitHub"
  # An empty username selects the public ghcr.io connection; no registry credential
  # is stored in Terraform state.
  username = ""
}

resource "bunnynet_compute_container_app" "host" {
  name    = var.application_name
  version = 2

  # This is intentionally a fixed topology. Bunny's autoscaling and dynamic-region
  # features would break the process-local SQLite/FRP session ownership model.
  regions_allowed     = [var.region]
  regions_required    = [var.region]
  regions_max_allowed = 1
  autoscaling_min     = 1
  autoscaling_max     = 1

  container {
    name            = "host"
    image_registry  = data.bunnynet_compute_container_imageregistry.ghcr_public.id
    image_namespace = var.image_namespace
    image_name      = var.image_name
    image_tag       = var.image_tag
    image_digest    = var.image_digest

    # Endpoint blocks must remain sorted by name for provider 0.18.2. The connector
    # endpoint is first; references to endpoint[0]/endpoint[1] rely on this contract.
    endpoint {
      name = "connector"
      type = "CDN"

      cdn {
        origin_ssl = false
      }

      port {
        # CDN endpoints use Bunny's TCP default; provider 0.18.2 rejects an
        # explicit protocols argument for endpoint type CDN.
        container = 7000
      }
    }

    endpoint {
      name = "public"
      type = "CDN"

      cdn {
        origin_ssl = false
      }

      port {
        # CDN endpoints use Bunny's TCP default; provider 0.18.2 rejects an
        # explicit protocols argument for endpoint type CDN.
        container = 8080
      }
    }

    # Environment blocks must remain sorted by name for provider 0.18.2.
    env {
      name  = "BUNNY_HOLE_CONNECTOR_HOST"
      value = var.connector_hostname
    }

    env {
      name  = "BUNNY_HOLE_CONNECTOR_PORT"
      value = "443"
    }

    env {
      name  = "BUNNY_HOLE_CONNECTOR_TRANSPORTS"
      value = "wss"
    }

    env {
      name  = "BUNNY_HOLE_LOG_FORMAT"
      value = "json"
    }

    env {
      name  = "BUNNY_HOLE_OWNER_PUBLIC_KEY"
      value = var.owner_public_key
    }

    env {
      name  = "BUNNY_HOLE_PUBLIC_URL"
      value = "https://${var.management_hostname}"
    }

    env {
      name  = "BUNNY_HOLE_REQUEST_TIMEOUT_MS"
      value = tostring(var.request_timeout_ms)
    }

    liveness_probe {
      type              = "http"
      port              = 8080
      initial_delay     = 10
      period            = 10
      timeout           = 3
      failure_threshold = 3
      success_threshold = 1

      http {
        path            = "/healthz"
        expected_status = 200
      }
    }

    readiness_probe {
      type              = "http"
      port              = 8080
      initial_delay     = 2
      period            = 5
      timeout           = 3
      failure_threshold = 3
      success_threshold = 1

      http {
        path            = "/readyz"
        expected_status = 200
      }
    }

    startup_probe {
      type              = "http"
      port              = 8080
      initial_delay     = 2
      period            = 5
      timeout           = 3
      failure_threshold = 30
      success_threshold = 1

      http {
        path            = "/readyz"
        expected_status = 200
      }
    }

    volumemount {
      name = "state"
      path = "/var/lib/bunny-hole"
    }
  }

  volume {
    name = "state"
    size = var.volume_size_gb
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = length(local.all_hostnames) == length(var.application_hostnames) + 2
      error_message = "management_hostname, connector_hostname, and application_hostnames must all be distinct; host routing is exact."
    }

    precondition {
      condition     = var.public_pullzone_name != var.connector_pullzone_name
      error_message = "public_pullzone_name and connector_pullzone_name must identify different Pull Zones."
    }

    precondition {
      condition = var.dns_zone_domain == null || alltrue([
        for hostname in local.all_hostnames : hostname == var.dns_zone_domain || endswith(hostname, ".${var.dns_zone_domain}")
      ])
      error_message = "When Bunny DNS linking is enabled, every configured hostname must be the existing zone or one of its subdomains."
    }
  }
}

# The Magic Containers application creates these CDN Pull Zones as a side effect of
# the two CDN endpoints above. Keep these declarations for post-bootstrap adoption:
# first target-apply the app, then import each auto-created Pull Zone (see README).
resource "bunnynet_pullzone" "connector" {
  name = var.connector_pullzone_name

  cache_enabled              = false
  cache_errors               = false
  request_coalescing_enabled = false
  safehop_enabled            = false
  safehop_retry_count        = 0
  strip_cookies              = false
  websockets_enabled         = true
  websockets_max_connections = var.connector_websocket_limit

  origin {
    type                  = "ComputeContainer"
    container_app_id      = bunnynet_compute_container_app.host.id
    container_endpoint_id = bunnynet_compute_container_app.host.container[0].endpoint[0].id
    forward_host_header   = true
    follow_redirects      = false
    verify_ssl            = false
  }

  routing {
    tier = "Standard"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "bunnynet_pullzone" "public" {
  name = var.public_pullzone_name

  cache_enabled              = false
  cache_errors               = false
  request_coalescing_enabled = false
  safehop_enabled            = false
  safehop_retry_count        = 0
  strip_cookies              = false
  websockets_enabled         = false

  origin {
    type                  = "ComputeContainer"
    container_app_id      = bunnynet_compute_container_app.host.id
    container_endpoint_id = bunnynet_compute_container_app.host.container[0].endpoint[1].id
    forward_host_header   = true
    follow_redirects      = false
    verify_ssl            = false
  }

  routing {
    tier = "Standard"
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "bunnynet_pullzone_hostname" "public" {
  for_each = local.public_hostnames

  pullzone    = bunnynet_pullzone.public.id
  name        = each.value
  tls_enabled = true
  force_ssl   = true

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.dns_zone_domain == null || each.value == var.dns_zone_domain || endswith(each.value, ".${var.dns_zone_domain}")
      error_message = "Every public hostname must be the existing dns_zone_domain or one of its subdomains when Bunny DNS linking is enabled."
    }
  }
}

resource "bunnynet_pullzone_hostname" "connector" {
  pullzone    = bunnynet_pullzone.connector.id
  name        = var.connector_hostname
  tls_enabled = true
  force_ssl   = true

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = var.dns_zone_domain == null || var.connector_hostname == var.dns_zone_domain || endswith(var.connector_hostname, ".${var.dns_zone_domain}")
      error_message = "connector_hostname must be the existing dns_zone_domain or one of its subdomains when Bunny DNS linking is enabled."
    }
  }
}

data "bunnynet_dns_zone" "existing" {
  count  = var.dns_zone_domain == null ? 0 : 1
  domain = var.dns_zone_domain
}

resource "bunnynet_dns_record" "pullzone" {
  for_each = local.dns_records

  zone = data.bunnynet_dns_zone.existing[0].id
  name = each.value.record_name
  type = "PullZone"
  # Bunny's PullZone DNS record value is the existing Pull Zone name; pullzone_id
  # links it to the adopted resource.
  value       = each.value.pullzone_name
  pullzone_id = each.value.pullzone_id
  ttl         = var.dns_ttl
  enabled     = true
}
