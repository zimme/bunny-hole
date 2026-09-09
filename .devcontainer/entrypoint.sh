#!/usr/bin/env bash
set -euo pipefail

install -d -o vscode -g vscode /deno-dir /home/vscode/.cache
chown -R vscode:vscode /deno-dir /home/vscode/.cache

if [[ -S /var/run/docker-host.sock ]]; then
  rm -f /var/run/docker.sock
  socat \
    UNIX-LISTEN:/var/run/docker.sock,fork,user=vscode,group=vscode,mode=0600 \
    UNIX-CONNECT:/var/run/docker-host.sock &
  for _ in {1..50}; do
    [[ -S /var/run/docker.sock ]] && break
    sleep 0.02
  done
  [[ -S /var/run/docker.sock ]] || {
    echo "Docker socket proxy did not start" >&2
    exit 1
  }
  for _ in {1..50}; do
    if setpriv --reuid=vscode --regid=vscode --init-groups \
      docker info >/dev/null 2>&1; then
      break
    fi
    sleep 0.1
  done
  setpriv --reuid=vscode --regid=vscode --init-groups \
    docker info >/dev/null
fi

exec setpriv --reuid=vscode --regid=vscode --init-groups "$@"
