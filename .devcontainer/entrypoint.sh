#!/usr/bin/env bash
set -euo pipefail

install -d -o vscode -g vscode /deno-dir /home/vscode/.cache
chown -R vscode:vscode /deno-dir /home/vscode/.cache

# Keep the checkout itself host-owned. Only ignored build/test output needs to be
# writable by the fixed UID shared with the rootless Docker sidecar.
install -d -m 0777 /workspaces/bunny-hole/coverage /workspaces/bunny-hole/dist
install -d -m 1777 /workspaces/bunny-hole/.tmp
chmod 0777 /workspaces/bunny-hole/coverage /workspaces/bunny-hole/dist
chmod 1777 /workspaces/bunny-hole/.tmp

exec setpriv --reuid=vscode --regid=vscode --init-groups "$@"
