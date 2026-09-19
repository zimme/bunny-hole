variable "application_name" {
  description = "Bunny Magic Containers application name. Keep it stable after bootstrap."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9][A-Za-z0-9-]{1,61}[A-Za-z0-9]$", var.application_name))
    error_message = "application_name must be 3-63 ASCII letters, digits, or hyphens and may not start or end with a hyphen."
  }
}

variable "region" {
  description = "One Bunny Magic Containers region code, for example DE, NY, or SG."
  type        = string

  validation {
    condition     = can(regex("^[A-Z][A-Z0-9-]{1,15}$", var.region))
    error_message = "region must be an uppercase Bunny region code such as DE or NY. Confirm availability in the Bunny dashboard."
  }
}

variable "management_hostname" {
  description = "Exact lower-case hostname for the Bunny Hole management/public API origin."
  type        = string

  validation {
    condition     = length(var.management_hostname) <= 253 && can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$", var.management_hostname)) && !strcontains(var.management_hostname, "*")
    error_message = "management_hostname must be a lower-case exact DNS name without a scheme, path, wildcard, or trailing dot."
  }
}

variable "application_hostnames" {
  description = "Exact lower-case public route hostnames to attach to the 8080 Pull Zone."
  type        = set(string)
  default     = []

  validation {
    condition = alltrue([
      for hostname in var.application_hostnames :
      length(hostname) <= 253 && can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$", hostname)) && !strcontains(hostname, "*")
    ])
    error_message = "application_hostnames must contain only lower-case exact DNS names without schemes, paths, wildcards, or trailing dots."
  }
}

variable "connector_hostname" {
  description = "Exact lower-case hostname used only for the connector WSS endpoint."
  type        = string

  validation {
    condition     = length(var.connector_hostname) <= 253 && can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$", var.connector_hostname)) && !strcontains(var.connector_hostname, "*")
    error_message = "connector_hostname must be a lower-case exact DNS name without a scheme, path, wildcard, or trailing dot."
  }
}

variable "public_pullzone_name" {
  description = "Actual generated name of the adopted 8080 Pull Zone. Bootstrap starts with its sentinel, then the imported name must be committed before full convergence."
  type        = string
  default     = "REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_NAME"

  validation {
    condition     = length(trimspace(var.public_pullzone_name)) >= 1 && length(var.public_pullzone_name) <= 250
    error_message = "public_pullzone_name must be the non-empty actual Bunny Pull Zone name recorded by bootstrap_handoff."
  }
}

variable "connector_pullzone_name" {
  description = "Actual generated name of the adopted 7000 Pull Zone. Bootstrap starts with its sentinel, then the imported name must be committed before full convergence."
  type        = string
  default     = "REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_NAME"

  validation {
    condition     = length(trimspace(var.connector_pullzone_name)) >= 1 && length(var.connector_pullzone_name) <= 250
    error_message = "connector_pullzone_name must be the non-empty actual Bunny Pull Zone name recorded by bootstrap_handoff."
  }
}

variable "public_pullzone_id" {
  description = "Actual generated ID of the adopted 8080 Pull Zone. Bootstrap starts with its sentinel, then the imported ID must be committed before full convergence."
  type        = string
  default     = "REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_ID"

  validation {
    condition = (
      var.public_pullzone_id == "REPLACE_WITH_BOOTSTRAP_PUBLIC_PULLZONE_ID" ||
      can(regex("^[1-9][0-9]*$", var.public_pullzone_id))
    )
    error_message = "public_pullzone_id must be the bootstrap sentinel or a positive numeric Bunny Pull Zone ID recorded by bootstrap_handoff."
  }
}

variable "connector_pullzone_id" {
  description = "Actual generated ID of the adopted 7000 Pull Zone. Bootstrap starts with its sentinel, then the imported ID must be committed before full convergence."
  type        = string
  default     = "REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_ID"

  validation {
    condition = (
      var.connector_pullzone_id == "REPLACE_WITH_BOOTSTRAP_CONNECTOR_PULLZONE_ID" ||
      can(regex("^[1-9][0-9]*$", var.connector_pullzone_id))
    )
    error_message = "connector_pullzone_id must be the bootstrap sentinel or a positive numeric Bunny Pull Zone ID recorded by bootstrap_handoff."
  }
}

variable "image_namespace" {
  description = "Public GHCR owner/namespace."
  type        = string
  default     = "zimme"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9-]{0,38}$", var.image_namespace))
    error_message = "image_namespace must be a lower-case GHCR owner name."
  }
}

variable "image_name" {
  description = "Public GHCR host image name."
  type        = string
  default     = "bunny-hole-host"

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9._-]{0,127}$", var.image_name))
    error_message = "image_name must be a lower-case OCI image name."
  }
}

variable "image_tag" {
  description = "Immutable ComVer host release tag (MAJOR.MINOR.0)."
  type        = string

  validation {
    condition     = can(regex("^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.0$", var.image_tag))
    error_message = "image_tag must be a released Compatible Version in MAJOR.MINOR.0 form; mutable tags such as latest are forbidden."
  }
}

variable "image_digest" {
  description = "sha256 digest for the already-tested host image, including the sha256: prefix."
  type        = string

  validation {
    condition     = can(regex("^sha256:[0-9a-f]{64}$", var.image_digest))
    error_message = "image_digest must be a lower-case immutable sha256 digest."
  }
}

variable "owner_public_key" {
  description = "Bunny Hole owner Ed25519 public key printed by the private owner-generation command. This is public configuration, never the private key."
  type        = string

  validation {
    # Terraform has no binary string type, and base64decode interprets bytes as
    # UTF-8. A canonical, unpadded base64url encoding of exactly 32 bytes is
    # therefore checked structurally: 43 characters, with the final sextet's
    # unused two bits set to zero (the 16 canonical base64url symbols).
    condition     = can(regex("^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$", var.owner_public_key))
    error_message = "owner_public_key must be a canonical unpadded base64url Ed25519 public key (exactly 43 characters encoding 32 bytes), not a private key or JSON credential file."
  }
}

variable "volume_size_gb" {
  description = "Encrypted Bunny persistent-volume size in GB."
  type        = number
  default     = 2

  validation {
    condition     = var.volume_size_gb >= 1 && var.volume_size_gb <= 100 && floor(var.volume_size_gb) == var.volume_size_gb
    error_message = "volume_size_gb must be a whole number from 1 through 100."
  }
}

variable "request_timeout_ms" {
  description = "Bunny Hole public HTTP timeout in milliseconds."
  type        = number
  default     = 30000

  validation {
    condition     = var.request_timeout_ms >= 1000 && var.request_timeout_ms <= 120000 && floor(var.request_timeout_ms) == var.request_timeout_ms
    error_message = "request_timeout_ms must be a whole number between 1000 and 120000."
  }
}

variable "connector_websocket_limit" {
  description = "Maximum simultaneous connector WebSockets accepted by the connector Pull Zone; Bunny requires increments of 100."
  type        = number
  default     = 500

  validation {
    condition     = var.connector_websocket_limit >= 100 && var.connector_websocket_limit <= 10000 && var.connector_websocket_limit % 100 == 0
    error_message = "connector_websocket_limit must be from 100 through 10000 in increments of 100."
  }
}

variable "dns_zone_domain" {
  description = "Optional existing Bunny DNS zone domain. Terraform never creates this zone or changes its nameservers."
  type        = string
  default     = null
  nullable    = true

  validation {
    # `||` is not a null-value guard in Terraform: both operands can be
    # evaluated while validating an expression. The conditional expression keeps
    # the optional null value from reaching string-only functions.
    condition = var.dns_zone_domain == null ? true : (
      length(var.dns_zone_domain) <= 253 &&
      can(regex("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$", var.dns_zone_domain)) &&
      !strcontains(var.dns_zone_domain, "*")
    )
    error_message = "dns_zone_domain must be null or a lower-case existing DNS zone name without a wildcard or trailing dot."
  }
}

variable "dns_ttl" {
  description = "TTL for optional Bunny DNS PullZone records."
  type        = number
  default     = 300

  validation {
    condition     = var.dns_ttl >= 60 && var.dns_ttl <= 86400 && floor(var.dns_ttl) == var.dns_ttl
    error_message = "dns_ttl must be a whole number between 60 and 86400 seconds."
  }
}

variable "enable_hostname_tls" {
  description = "Creates custom-hostname resources with Bunny-managed TLS and forced HTTPS only after DNS is published and propagation is reviewed."
  type        = bool
  default     = false
}
