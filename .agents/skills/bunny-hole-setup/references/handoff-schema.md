# Sanitized handoff schema

Use this small record to resume work without transferring credentials. It is a
communication contract, not Terraform state and not a deployment authorization. Values
must be public or intentionally non-sensitive operational facts.

```json
{
  "schema": "bunny-hole-setup/v1",
  "status": "pending-manual-items",
  "repository": "owner/repository",
  "release": {
    "version": "1.4.0",
    "imageDigest": "sha256:<immutable-tested-digest>",
    "provenanceVerified": true
  },
  "bunny": {
    "applicationId": "public-id",
    "containerName": "bunny-hole-host",
    "region": "public-region",
    "endpointIds": {
      "management": "public-id",
      "connector": "public-id"
    },
    "pullZoneIds": {
      "management": "public-id",
      "connector": "public-id"
    },
    "healthyAt": "2026-09-12T12:00:00Z"
  },
  "edge": {
    "managementHostname": "manage.example",
    "connectorHostname": "connect.example",
    "routeHostnames": ["service.example"],
    "tls": "verified",
    "dns": "verified",
    "websockets": "verified",
    "cacheDisabled": "verified"
  },
  "enrollment": {
    "id": "public-enrollment-id",
    "verificationPhrase": "public phrase",
    "grantSummary": "exact service.example, http/https, max 1 route",
    "session": "connected"
  },
  "routes": [
    {
      "id": "public-route-id",
      "hostname": "service.example",
      "protocol": "http",
      "targetSummary": "loopback target configured privately"
    }
  ],
  "pendingManualItems": [
    "none"
  ],
  "nextAction": "verify external exact-host request"
}
```

## Allowed and forbidden fields

Allowed values are resource IDs, names, public hostnames, public keys, immutable image
digests, version, region, route IDs, verification phrases, booleans describing verified
settings, health timestamps, and a redacted target summary. Use `null` or omit a value
that is unknown.

Reject a handoff containing any API key, backend credential, registry credential, owner
private key, device private key, passkey response or credential ID, connector config,
Kubernetes Secret or token, cookie, session token, raw `tfstate`, plan file, log with
secret-bearing values, or private origin credentials. Also reject a handoff that asks
the agent to apply, destroy, approve, or revoke without a new explicit user approval.

Valid statuses are:

- `scaffolded`: offline checks passed; no live mutation performed;
- `awaiting-resource-authorization`: paused before private Bunny/backend work;
- `awaiting-edge-or-identity`: paused before DNS/TLS/registry/passkey/enrollment work;
- `pending-manual-items`: infrastructure may exist, but documented settings remain;
- `verified`: all requested checks passed and no manual item remains; or
- `blocked`: an external prerequisite or provider limitation prevents safe progress.
