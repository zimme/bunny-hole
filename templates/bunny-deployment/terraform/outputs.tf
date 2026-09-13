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

output "deployment_handoff" {
  description = "Secret-free values useful for the next human/agent deployment step."
  value = {
    application_id      = bunnynet_compute_container_app.host.id
    connector_endpoint  = bunnynet_compute_container_app.host.container[0].endpoint[0].id
    connector_hostname  = var.connector_hostname
    connector_pullzone  = bunnynet_pullzone.connector.id
    image_digest        = var.image_digest
    image_tag           = var.image_tag
    management_hostname = var.management_hostname
    public_endpoint     = bunnynet_compute_container_app.host.container[0].endpoint[1].id
    public_pullzone     = bunnynet_pullzone.public.id
    region              = var.region
  }
}
