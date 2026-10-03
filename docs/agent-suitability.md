# Agent suitability and alternatives

Reviewed on 2026-10-03 against the repository and the official sources linked below.
This is an architectural and workflow assessment; it is not a certification, live Bunny
acceptance test, or performance comparison. Vendor features can change.

## Recommendation

Bunny Hole is a reasonable choice for repeated, bounded HTTP publication from an
existing environment when an operator wants to run the relay on Bunny. After human
setup, an agent can use ordinary CLI commands without Bunny account credentials or owner
keys. The pinned FRP data plane, exact routing, per-enrollment device keys, loopback
default, cancellation, and explicit grants are useful foundations.

It is currently less convenient for short-lived agent previews than services that
allocate a URL and expire access in one call. If no remote consumer needs to reach the
application, loopback testing is simpler. If the agent already runs in a managed
sandbox, use that platform's preview capability unless there is a specific reason to
route through Bunny.

## Alternatives

| Solution                                                                                        | Best fit                                                       | Relevant tradeoff                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) | Occasional localhost preview without operating a relay         | Temporary URL without an account; optional email authentication is browser-interactive. No SSE, a 200 in-flight request limit, changing hostnames, and no uptime guarantee.                                          |
| [ngrok](https://ngrok.com/use-cases/share-localhost)                                            | Local previews, webhooks, and managed ingress policies         | CLI publication with managed endpoints; Traffic Policy provides viewer authentication and IP restrictions. Account and policy setup replace relay operations.                                                        |
| [Tailscale Serve and Funnel](https://tailscale.com/docs/reference/funnel-vs-sharing)            | Private access within a tailnet, or public sharing with Funnel | Choose private sharing for restricted audiences. Funnel publishes to the internet; tailnet access policies do not turn Funnel into private access.                                                                   |
| [E2B](https://docs.e2b.dev/network/public-url)                                                  | An agent environment already running in an E2B sandbox         | SDK port URLs avoid another connector. Configure [restricted public access](https://docs.e2b.dev/network/restrict-public-access) deliberately. Moving an existing local environment into E2B is a separate decision. |
| [Daytona](https://www.daytona.io/docs/en/preview-and-authentication/)                           | SDK-controlled sandbox previews with delegated access          | Private preview tokens and signed URLs with configurable expiry and revocation are built in. A signed URL is a bearer credential and needs careful handling.                                                         |
| [Vercel Sandbox](https://vercel.com/docs/sandbox)                                               | Agent code execution with hosted isolation and live previews   | SDK/CLI orchestration includes isolated compute; this changes where the environment runs rather than just exposing a local port.                                                                                     |
| [FRP directly](https://gofrp.org/en/docs/)                                                      | Operators comfortable managing both ends of a tunnel           | Reuses the same mature transport but leaves enrollment, grants, exact ingress policy, and operational integration to the operator.                                                                                   |

The sandbox products are agent-oriented execution platforms. Bunny Hole supplies
connectivity; it does not replace their code isolation, filesystem controls, or sandbox
lifecycle. Adding an MCP wrapper would make another invocation interface, without
solving preview expiry, viewer authorization, or concurrent ownership.

## Is configuration excessive?

There are several configuration surfaces, but they serve different trust boundaries:

- The host's environment, durable identity, and SQLite state belong to the relay owner.
- Terraform inputs and protected workflows belong to infrastructure provisioning.
- One protected connector file holds device credentials and named host selection.
- Owner grant files define what an enrollment may publish.
- Routes select exact hostnames and fixed origins.
- Compose labels and Kubernetes objects are optional adapters for route management.

Do not combine owner and connector credentials to save files. Do not give a runtime
agent the deployment template or Bunny account key. Most host variables already have
defaults; the basic agent path needs only a protected config path, host alias, granted
public hostname, and local port. Documentation should present that path first and keep
advanced controllers optional.

The real usability problem is the number of lifecycle steps: create route, record its
ID, start connector, verify origin and public readiness, stop connector, delete route,
and verify cleanup. There is no one-command preview, route expiry, or automatic public
hostname allocation. Suffix grants alone cannot allocate a working CDN hostname.

## Findings by perspective

### Security and agent authority

Connector identity and exact-host grants limit publication authority. They do not
restrict public viewers. Anyone who reaches a configured route can send requests to the
application unless it authenticates them. This is unsuitable for an unauthenticated
agent shell, development administration endpoint, or sensitive data preview.

Different tasks sharing one enrollment are not independent: a newer FRP login replaces
the previous connector, and each connector receives all that enrollment's routes.
Independent tasks need separate credentials and hostnames. An agent-controlled process
that can use a connector credential can exercise its entire grant, even if it never
prints the key. A skill or instruction file is not an OS security boundary; keep
untrusted code isolated and grant minimal publication authority.

The transport uses TLS terminated at Bunny and is observable by the relay operator. It
is not end-to-end confidential from those operators. Keep the account key out of the
host and agent; it belongs only in the human-controlled provisioning boundary.

### Temporary access and correctness

Admission-token expiry limits when an FRP session can start. It does not terminate
publication at that timestamp. Routes remain durable after process exit. Cleanup can
fail when an agent crashes or loses network access, and a replacement connector can
publish a retained route again. A host-enforced lease is the appropriate design for a
strict preview deadline.

`check` authenticates the control plane; it cannot prove the origin, FRP data plane,
DNS, TLS, CDN policy, or viewer authorization. This review makes its scope explicit and
includes admitted routes in the secret-free result. Public application verification
remains separate.

### Web development compatibility

Public WebSockets are absent, so common development hot reload and WebSocket APIs are
not fully supported. HTTP previews, webhooks, binary data, and streaming work within
existing limits. SSE is subject to the whole-response timeout, so it is not an unlimited
long-lived event channel. A one-instance relay also introduces an availability and
maintenance boundary. Do not market this as a generic environment-sharing replacement
without those qualifications.

### Privacy and compliance

The repository does not demonstrate a compliance certification or a completed
organization-specific assessment. One relay region does not establish that CDN traffic,
logs, backups, or subprocessors stay in that region. Review the actual data flow,
application data, viewer cookies/IP addresses, retention, deletion, backups, operational
access, incident response, and contracts for the intended deployment. Prefer synthetic
data for previews.

Bunny publishes [GDPR and DPA information](https://bunny.net/gdpr/) and a
[subprocessor list](https://bunny.net/gdpr/sub-processors/). An operator must assess
their own obligations and configuration; vendor statements alone do not establish
compliance for an exposed application. The bounded SQLite audit trail and secret-free
logs are useful controls, but deployment-specific log retention, export, access, and
recovery still need an operator procedure.

### Accessibility

The passkey pages use native buttons, which support ordinary keyboard operation. This
review adds page language, keyboard access to long grant details, loading/ready
progress, JavaScript guidance, and live status announcements. These changes address
concrete markup gaps against
[W3C status-message guidance](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html).
They do not establish WCAG conformance. Screen-reader, keyboard, zoom, small-screen,
passkey-platform, cancellation, and recovery testing remain necessary. Raw grant JSON is
accurate but harder for nontechnical owners to review than a labeled grant summary.

### Operations, supply chain, and cost

Pinned tools/dependencies/actions, frozen installation, checksum-verified FRP,
production image integration, and protected manual deployments reduce avoidable drift.
The copyable Terraform template and multiple staged DNS/TLS operations add maintenance
work, but reflect provider/resource lifecycle and credential boundaries. Avoid routing
routine agent tasks through infrastructure provisioning.

Self-hosting has continuing compute, storage, CDN, certificate/DNS, upgrades, recovery,
and abuse-response costs even when a preview is idle. Compare measured traffic and
current vendor pricing before assuming Bunny is cheaper. No capacity or price benchmark
was performed in this review.

## Prioritized improvements

1. **Preview lifecycle:** one CLI entrypoint that creates a scoped route, supervises the
   connector, emits secret-free structured lifecycle events, and cleans up its own
   route. Pair it with a persisted, host-enforced lease that blocks new requests and
   sessions after expiry, bounds existing requests, and survives host/agent restarts.
   Keep persistent routes compatible. Test expiry, cancellation, crash, reconnect,
   replacement, clock behavior, route conflict, and failed cleanup.
2. **Viewer protection:** define how browser users and automated test clients
   authenticate. Do not reuse connector/owner tokens as viewer credentials or log bearer
   share links. Keep application `Authorization` semantics intact; choose and test an
   explicit separate access boundary before implementation.
3. **Concurrent ownership and readiness:** provide a non-secret task handoff containing
   hostname, route ID, enrollment ID, config path reference, deadline, and cleanup
   state. Add scoped readiness/status events and distinguish control authentication from
   actual publication. A concurrency design must preserve one connector per enrollment.
4. **Human approval usability:** replace raw JSON with labeled enrollment, verification
   phrase, exact hosts, private-network consent, protocols, and route limits, preserving
   the signed grant. Test keyboard and assistive technology with real passkey devices.
5. **Bounded product scope:** promote CLI HTTP previews as the simple path. Keep
   Compose, Kubernetes, and Terraform as separate optional workflows. Add public
   WebSockets only with an explicit tested protocol/security design if hot reload is a
   product priority.

The preview and viewer-access changes introduce new public behavior and trust
boundaries. They need a focused design and behavior tests rather than a convenience
wrapper that appears to guarantee temporary or private access without enforcing it.
