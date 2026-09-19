output "application_id" {
  description = "Bunny Magic Containers application ID. Safe to share with an operator or deployment agent."
  value       = bunnynet_compute_container_app.host.id
}

output "host_container_id" {
  description = "Bunny host container ID."
  value       = bunnynet_compute_container_app.host.container[0].id
}

output "public_endpoint_id" {
  description = "Bunny 8080 public endpoint ID."
  value       = bunnynet_compute_container_app.host.container[0].endpoint[1].id
}

output "connector_endpoint_id" {
  description = "Bunny 7000 connector endpoint ID."
  value       = bunnynet_compute_container_app.host.container[0].endpoint[0].id
}

output "public_pullzone_id" {
  description = "Adopted Bunny Pull Zone ID for management and exact public application hostnames."
  value       = bunnynet_pullzone.public.id
}

output "connector_pullzone_id" {
  description = "Adopted Bunny Pull Zone ID for the connector WSS hostname."
  value       = bunnynet_pullzone.connector.id
}

output "public_pullzone_name" {
  description = "Actual imported Bunny Pull Zone name for management and exact public application hostnames."
  value       = bunnynet_pullzone.public.name
}

output "connector_pullzone_name" {
  description = "Actual imported Bunny Pull Zone name for the connector WSS hostname."
  value       = bunnynet_pullzone.connector.name
}

output "bootstrap_public_pullzone_id" {
  description = "Auto-generated public Pull Zone ID exposed by the application endpoint; use it for the first import."
  value       = bunnynet_compute_container_app.host.container[0].endpoint[1].cdn[0].pullzone_id
}

output "bootstrap_connector_pullzone_id" {
  description = "Auto-generated connector Pull Zone ID exposed by the application endpoint; use it for the first import."
  value       = bunnynet_compute_container_app.host.container[0].endpoint[0].cdn[0].pullzone_id
}

output "public_cdn_domain" {
  description = "Bunny CDN domain for the adopted public Pull Zone."
  value       = bunnynet_pullzone.public.cdn_domain
}

output "connector_cdn_domain" {
  description = "Bunny CDN domain for the adopted connector Pull Zone."
  value       = bunnynet_pullzone.connector.cdn_domain
}

output "management_url" {
  description = "Configured HTTPS management URL."
  value       = "https://${var.management_hostname}"
}

output "connector_url" {
  description = "Configured WSS connector URL."
  value       = "wss://${var.connector_hostname}"
}

output "public_hostnames" {
  description = "Exact hostnames attached to the 8080 Pull Zone."
  value       = sort(tolist(local.public_hostnames))
}

output "image_reference" {
  description = "Immutable tested image reference."
  value       = "ghcr.io/${var.image_namespace}/${var.image_name}:${var.image_tag}@${var.image_digest}"
}

output "bootstrap_handoff" {
  description = "Secret-free bootstrap record. After both imports, commit its exact Pull Zone IDs and generated names before running a full convergence plan."
  value = {
    schema = "bunny-hole-setup/v1"
    status = "awaiting-edge-or-identity"
    bunny = {
      applicationId = bunnynet_compute_container_app.host.id
      containerName = "host"
      region        = var.region
      endpointIds = {
        management = bunnynet_compute_container_app.host.container[0].endpoint[1].id
        connector  = bunnynet_compute_container_app.host.container[0].endpoint[0].id
      }
      pullZoneIds = {
        management = bunnynet_pullzone.public.id
        connector  = bunnynet_pullzone.connector.id
      }
      pullZoneNames = {
        management = bunnynet_pullzone.public.name
        connector  = bunnynet_pullzone.connector.name
      }
      cdnDomains = {
        management = bunnynet_pullzone.public.cdn_domain
        connector  = bunnynet_pullzone.connector.cdn_domain
      }
    }
    edge = {
      managementHostname = var.management_hostname
      connectorHostname  = var.connector_hostname
      routeHostnames     = sort(tolist(var.application_hostnames))
      dns                = var.dns_zone_domain == null ? "external-not-configured" : "bunny-records-pending"
      tls                = "not-requested"
    }
    pendingManualItems = [
      "Commit the generated Pull Zone IDs and names from this handoff before full convergence.",
      "Publish DNS records and verify propagation before enabling hostname TLS.",
    ]
    nextAction = "Commit the exact imported Pull Zone IDs/names, then review a full policy-and-DNS plan with enable_hostname_tls=false."
  }
}

output "deployment_handoff" {
  description = "Secret-free handoff matching .agents/skills/bunny-hole-setup/references/handoff-schema.md."
  value = {
    schema = "bunny-hole-setup/v1"
    status = var.enable_hostname_tls ? "pending-manual-items" : "awaiting-edge-or-identity"
    release = {
      version            = var.image_tag
      imageDigest        = var.image_digest
      provenanceVerified = false
    }
    bunny = {
      applicationId = bunnynet_compute_container_app.host.id
      containerName = "host"
      region        = var.region
      endpointIds = {
        management = bunnynet_compute_container_app.host.container[0].endpoint[1].id
        connector  = bunnynet_compute_container_app.host.container[0].endpoint[0].id
      }
      pullZoneIds = {
        management = bunnynet_pullzone.public.id
        connector  = bunnynet_pullzone.connector.id
      }
      pullZoneNames = {
        management = bunnynet_pullzone.public.name
        connector  = bunnynet_pullzone.connector.name
      }
      cdnDomains = {
        management = bunnynet_pullzone.public.cdn_domain
        connector  = bunnynet_pullzone.connector.cdn_domain
      }
    }
    edge = {
      managementHostname = var.management_hostname
      connectorHostname  = var.connector_hostname
      routeHostnames     = sort(tolist(var.application_hostnames))
      tls                = var.enable_hostname_tls ? "requested-not-verified" : "not-requested"
      dns                = var.dns_zone_domain == null ? "external-not-verified" : "bunny-records-not-verified"
      websockets         = "configured-not-verified"
      cacheDisabled      = "configured-not-verified"
    }
    pendingManualItems = var.enable_hostname_tls ? [
      "Verify DNS propagation, managed TLS issuance, exact-host routing, caching, and connector WSS externally.",
      ] : [
      "Publish DNS records and verify propagation before enabling hostname TLS in a separately reviewed apply.",
    ]
    nextAction = var.enable_hostname_tls ? "Verify deployed edge behavior before marking the handoff verified." : "After DNS propagation, set enable_hostname_tls=true in a separately reviewed apply."
  }
}
