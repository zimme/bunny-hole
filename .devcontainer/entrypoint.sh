#!/usr/bin/env bash
set -euo pipefail

install -d -o vscode -g vscode /deno-dir /home/vscode/.cache
chown -R vscode:vscode /deno-dir /home/vscode/.cache

exec setpriv --reuid=vscode --regid=vscode --init-groups "$@"
