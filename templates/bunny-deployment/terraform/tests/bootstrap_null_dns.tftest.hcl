# These plans use Terraform's mock provider: they never authenticate to Bunny or create
# infrastructure. They exercise the bootstrap target exactly as the protected workflow
# does, including the default null DNS zone and the four Pull Zone sentinels.
mock_provider "bunnynet" {
  mock_data "bunnynet_compute_container_imageregistry" {
    defaults = {
      id = 1
    }
  }

  mock_data "bunnynet_pullzone" {
    defaults = {
      id   = 1
      name = "unused"
    }
  }
}

run "bootstrap_permits_null_dns_zone_and_sentinels" {
  command = plan

  plan_options {
    target = [bunnynet_compute_container_app.host]
  }

  variables {
    application_name    = "bunny-hole-test"
    region              = "DE"
    management_hostname = "manage.hole.example"
    connector_hostname  = "connect.hole.example"
    application_hostnames = [
      "app.hole.example",
    ]
    public_pullzone_id      = "REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_ID"
    public_pullzone_name    = "REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_NAME"
    connector_pullzone_id   = "REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_ID"
    connector_pullzone_name = "REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_NAME"
    image_tag               = "0.1.0"
    image_digest            = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    owner_public_key        = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    dns_zone_domain         = null
  }
}

run "bootstrap_accepts_an_existing_dns_zone_within_scope" {
  command = plan

  plan_options {
    target = [bunnynet_compute_container_app.host]
  }

  variables {
    application_name    = "bunny-hole-test"
    region              = "DE"
    management_hostname = "manage.hole.example"
    connector_hostname  = "connect.hole.example"
    application_hostnames = [
      "app.hole.example",
    ]
    public_pullzone_id      = "REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_ID"
    public_pullzone_name    = "REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_NAME"
    connector_pullzone_id   = "REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_ID"
    connector_pullzone_name = "REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_NAME"
    image_tag               = "0.1.0"
    image_digest            = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    owner_public_key        = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    dns_zone_domain         = "hole.example"
  }
}

# A normal plan must reject sentinels with the adoption precondition, not fail by
# indexing the zero-count adopted-Pull-Zone data sources.
run "full_plan_reports_the_adoption_gate_for_sentinels" {
  command = plan

  expect_failures = [
    terraform_data.pullzone_adoption,
  ]

  variables {
    application_name    = "bunny-hole-test"
    region              = "DE"
    management_hostname = "manage.hole.example"
    connector_hostname  = "connect.hole.example"
    application_hostnames = [
      "app.hole.example",
    ]
    public_pullzone_id      = "REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_ID"
    public_pullzone_name    = "REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_NAME"
    connector_pullzone_id   = "REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_ID"
    connector_pullzone_name = "REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_NAME"
    image_tag               = "0.1.0"
    image_digest            = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    owner_public_key        = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    dns_zone_domain         = null
  }
}

# The hostname resources must be able to plan with external DNS (`null`) once
# the generated Pull Zones have been adopted. The adopted data-source values
# are deterministic; endpoint Pull Zone IDs remain unknown during a plan, as
# they do in the real bootstrap phase. No provider calls occur.
run "adopted_external_dns_can_plan_hostname_tls" {
  command = plan

  override_data {
    target = data.bunnynet_pullzone.public_adopted[0]
    values = {
      id   = 101
      name = "public-generated"
    }
  }

  override_data {
    target = data.bunnynet_pullzone.connector_adopted[0]
    values = {
      id   = 102
      name = "connector-generated"
    }
  }

  variables {
    application_name    = "bunny-hole-test"
    region              = "DE"
    management_hostname = "manage.hole.example"
    connector_hostname  = "connect.hole.example"
    application_hostnames = [
      "app.hole.example",
    ]
    public_pullzone_id      = "101"
    public_pullzone_name    = "public-generated"
    connector_pullzone_id   = "102"
    connector_pullzone_name = "connector-generated"
    image_tag               = "0.1.0"
    image_digest            = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    owner_public_key        = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
    dns_zone_domain         = null
    enable_hostname_tls     = true
  }

  assert {
    condition     = length(bunnynet_pullzone_hostname.public) == 2
    error_message = "external DNS must not prevent the management and application hostname resources from planning."
  }

  assert {
    condition     = length(bunnynet_pullzone_hostname.connector) == 1
    error_message = "external DNS must not prevent the connector hostname resource from planning."
  }
}
