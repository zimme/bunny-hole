# Configuration

## Relay

Relay configuration is environment-only and validated before listening.

| Variable                       | Required | Default   | Meaning                         |
| ------------------------------ | -------- | --------- | ------------------------------- |
| `BUNNY_HOLE_TUNNELS`           | yes      | —         | JSON array of tunnel records    |
| `HOST`                         | no       | `0.0.0.0` | listen address                  |
| `PORT`                         | no       | `8080`    | listen port                     |
| `BUNNY_HOLE_LOG_FORMAT`        | no       | `json`    | `json` or `pretty`              |
| `BUNNY_HOLE_LOCAL_DEVELOPMENT` | no       | `false`   | permits direct non-TLS upgrades |

A record has `id`, a 32-byte-or-longer base64url `secret`, and one or more exact
`hostnames`. IDs and hostnames must be unique. Startup diagnostics redact secrets.

## Connector

Flags override environment, which overrides a JSON `--config` file except the secret: it
is intentionally not accepted as a flag. On Unix, config files must be mode `0600` or
stricter.

| Flag / environment                                             | Required | Default                 |
| -------------------------------------------------------------- | -------- | ----------------------- |
| `--relay` / `BUNNY_HOLE_RELAY_URL`                             | yes      | —                       |
| `--tunnel` / `BUNNY_HOLE_TUNNEL_ID`                            | yes      | —                       |
| config / `BUNNY_HOLE_TUNNEL_SECRET`                            | yes      | —                       |
| `--origin` / `BUNNY_HOLE_ORIGIN`                               | no       | `http://127.0.0.1:3000` |
| `--allow-private-network` / `BUNNY_HOLE_ALLOW_PRIVATE_NETWORK` | no       | false                   |
| `--local-development` / `BUNNY_HOLE_LOCAL_DEVELOPMENT`         | no       | false                   |
| `--log-format` / `BUNNY_HOLE_LOG_FORMAT`                       | no       | json                    |

Production relay URLs must use WSS. Non-loopback origins require the explicit
private-network opt-in. Origin URLs cannot contain credentials, paths, query strings, or
fragments.

Exit code `64` means CLI usage error; `78` means invalid configuration/startup.
Transient connection errors reconnect indefinitely with exponential backoff, bounded
jitter, and a 30-second maximum delay.
