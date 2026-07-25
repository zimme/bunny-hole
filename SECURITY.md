# Security policy

## Supported versions

Until 1.0, only the latest commit on `main` receives security fixes. After tagged
releases begin, the latest minor release will be supported.

## Report a vulnerability

Use GitHub's private vulnerability reporting for `zimme/bunny-hole`. If that feature is
unavailable, contact the repository owner through the private contact method on their
GitHub profile. Do not open a public issue, include live secrets, probe infrastructure
you do not own, or retain other people's traffic.

Include affected revision, impact, reproduction using synthetic data, and a suggested
mitigation. You should receive an acknowledgement within seven days. Coordinated
disclosure timing will reflect severity and fix availability. A security fix that breaks
compatibility requires a ComVer major release.

Read the full [threat model](docs/threat-model.md). Bunny Hole does not provide viewer
authentication; origin applications remain responsible for authorization.
