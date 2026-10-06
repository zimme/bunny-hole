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

variables {
  application_name    = "bunny-hole-candidate"
  region              = "DE"
  management_hostname = "manage.hole.example"
  connector_hostname  = "connect.hole.example"
  image_tag           = "1.0.0-rc.1"
  image_digest        = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  owner_public_key    = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}
run "candidate_requires_consent" {
  command = plan
  plan_options { target = [bunnynet_compute_container_app.host] }
  expect_failures = [var.image_tag]
}

run "candidate_with_consent" {
  command = plan
  plan_options { target = [bunnynet_compute_container_app.host] }
  variables {
    allow_release_candidate = true
  }
}

run "stable_needs_no_consent" {
  command = plan
  plan_options { target = [bunnynet_compute_container_app.host] }
  variables {
    image_tag = "1.0.0"
  }
}

run "candidate_nonzero_patch_rejected" {
  command = plan
  plan_options { target = [bunnynet_compute_container_app.host] }
  variables {
    allow_release_candidate = true
    image_tag               = "1.0.1-rc.1"
  }
  expect_failures = [var.image_tag]
}

run "candidate_leading_zero_rejected" {
  command = plan
  plan_options { target = [bunnynet_compute_container_app.host] }
  variables {
    allow_release_candidate = true
    image_tag               = "1.0.0-rc.01"
  }
  expect_failures = [var.image_tag]
}
