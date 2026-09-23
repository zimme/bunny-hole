# Sanitized handoff schema

Use this record to resume work without transferring credentials. It is a communication
contract, not Terraform state and not deployment authorization. Values must be public or
intentionally non-sensitive operational facts.

```json
{
  "schema": "bunny-hole-setup/v1",
  "status": "pending-manual-items",
  "release": {
    "version": "1.4.0",
    "imageDigest": "sha256:<immutable-tested-digest>",
    "provenanceVerified": true
  },
  "bunny": {
    "applicationId": "public-id",
    "containerName": "host",
    "region": "public-region",
    "endpointIds": { "management": "public-id", "connector": "public-id" },
    "pullZoneIds": { "management": "public-id", "connector": "public-id" },
    "pullZoneNames": {
      "management": "generated-public-pull-zone-name",
      "connector": "generated-connector-pull-zone-name"
    },
    "cdnDomains": {
      "management": "public.b-cdn.net",
      "connector": "connector.b-cdn.net"
    }
  },
  "edge": {
    "managementHostname": "manage.example",
    "connectorHostname": "connect.example",
    "routeHostnames": ["service.example"],
    "tls": "not-requested",
    "dns": "external-not-verified"
  },
  "pendingManualItems": [
    "publish DNS and verify propagation before enabling hostname TLS"
  ],
  "nextAction": "review the separate TLS-stage plan"
}
```

Allowed values are resource IDs, generated Pull Zone names, public CDN domains, public
hostnames, public keys, immutable image digests, version, region, route IDs,
verification phrases, booleans describing verified settings, health timestamps, and a
redacted target summary. Use `null` or omit an unknown value. Retain generated Pull Zone
IDs and names from bootstrap so the full plan can prove it is adopting, not replacing,
those zones.

Reject a handoff containing an API key, backend credential, registry credential, owner
or device private key, passkey response or credential ID, connector config, Kubernetes
Secret/token, cookie, session token, raw Terraform state, plan file, or secret-bearing
log. A handoff never grants approval to apply, import, destroy, approve, or revoke.

Valid statuses are `scaffolded`, `awaiting-resource-authorization`,
`awaiting-edge-or-identity`, `pending-manual-items`, `verified`, and `blocked`.
