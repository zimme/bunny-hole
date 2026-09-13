locals {
  public_hostnames = setunion(toset([var.management_hostname]), var.application_hostnames)

  all_hostnames = setunion(
    local.public_hostnames,
    toset([var.connector_hostname]),
  )

  dns_targets = merge(
    {
      for hostname in local.public_hostnames : "public/${hostname}" => {
        hostname      = hostname
        pullzone_id   = bunnynet_pullzone.public.id
        pullzone_name = var.public_pullzone_name
        record_name   = hostname
      }
    },
    {
      "connector/${var.connector_hostname}" = {
        hostname      = var.connector_hostname
        pullzone_id   = bunnynet_pullzone.connector.id
        pullzone_name = var.connector_pullzone_name
        record_name   = var.connector_hostname
      }
    },
  )

  dns_records = var.dns_zone_domain == null ? {} : {
    for key, target in local.dns_targets : key => merge(target, {
      record_name = target.hostname == var.dns_zone_domain ? "" : trimsuffix(target.hostname, ".${var.dns_zone_domain}")
    }) if target.hostname == var.dns_zone_domain || endswith(target.hostname, ".${var.dns_zone_domain}")
  }
}
