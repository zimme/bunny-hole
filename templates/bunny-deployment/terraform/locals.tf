locals {
  bootstrap_pullzone_sentinels = {
    connector_id   = "REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_ID"
    connector_name = "REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_NAME"
    public_id      = "REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_ID"
    public_name    = "REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_NAME"
  }

  pullzone_adoption_handoff_complete = (
    var.public_pullzone_id != local.bootstrap_pullzone_sentinels.public_id &&
    var.connector_pullzone_id != local.bootstrap_pullzone_sentinels.connector_id &&
    var.public_pullzone_name != local.bootstrap_pullzone_sentinels.public_name &&
    var.connector_pullzone_name != local.bootstrap_pullzone_sentinels.connector_name
  )

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
        pullzone_name = bunnynet_pullzone.public.name
        record_name   = hostname
      }
    },
    {
      "connector/${var.connector_hostname}" = {
        hostname      = var.connector_hostname
        pullzone_id   = bunnynet_pullzone.connector.id
        pullzone_name = bunnynet_pullzone.connector.name
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
