ARG DENO_VERSION=2.9.3
FROM denoland/deno:${DENO_VERSION}@sha256:6288db6be1c26473bb9d1843f906d9a219c0dda57fd85de4aac90296951cf6ef AS deno

FROM mcr.microsoft.com/devcontainers/base@sha256:1a00517e89d3075f8c9dc8d9911404de0ff8991a4d71c62068573e9b016a89da

ARG TARGETARCH
ARG NODE_VERSION=24.13.1
ARG NPM_VERSION=11.8.0
ARG GH_VERSION=2.96.0
ARG COPILOT_VERSION=1.0.72
ARG DOCKER_CLI_VERSION=5:29.6.2-1~debian.13~trixie
ARG DOCKER_BUILDX_VERSION=0.35.0-1~debian.13~trixie
ARG DOCKER_COMPOSE_VERSION=5.3.1-1~debian.13~trixie

COPY --from=deno /usr/bin/deno /usr/local/bin/deno

ENV DENO_DIR=/deno-dir \
    DENO_NO_PROMPT=1 \
    DENO_NO_UPDATE_CHECK=1 \
    HOME=/home/vscode

RUN set -eux; \
    target_arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "${target_arch}" in \
      amd64) node_arch=x64; gh_arch=amd64 ;; \
      arm64) node_arch=arm64; gh_arch=arm64 ;; \
      *) echo "unsupported development image architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    node_archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl --fail --location --retry 3 --output "/tmp/${node_archive}" \
      "https://nodejs.org/download/release/v${NODE_VERSION}/${node_archive}"; \
    curl --fail --location --retry 3 --output /tmp/node-shasums \
      "https://nodejs.org/download/release/v${NODE_VERSION}/SHASUMS256.txt"; \
    grep " ${node_archive}\$" /tmp/node-shasums | (cd /tmp && sha256sum --check -); \
    tar --extract --xz --file "/tmp/${node_archive}" --directory /usr/local --strip-components=1; \
    test "$(npm --version)" = "${NPM_VERSION}"; \
    gh_archive="gh_${GH_VERSION}_linux_${gh_arch}.tar.gz"; \
    curl --fail --location --retry 3 --output "/tmp/${gh_archive}" \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${gh_archive}"; \
    curl --fail --location --retry 3 --output /tmp/gh-checksums \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_checksums.txt"; \
    grep "  ${gh_archive}\$" /tmp/gh-checksums | (cd /tmp && sha256sum --check -); \
    tar --extract --gzip --file "/tmp/${gh_archive}" --directory /tmp; \
    install -m 0755 "/tmp/gh_${GH_VERSION}_linux_${gh_arch}/bin/gh" /usr/local/bin/gh; \
    npm_config_ignore_scripts=false npm install --global "@github/copilot@${COPILOT_VERSION}"; \
    npm cache clean --force

RUN set -eux; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl --fail --location https://download.docker.com/linux/debian/gpg \
      | gpg --dearmor --output /etc/apt/keyrings/docker.gpg; \
    chmod a+r /etc/apt/keyrings/docker.gpg; \
    . /etc/os-release; \
    printf '%s\n' \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
      > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install --yes --no-install-recommends \
      "docker-buildx-plugin=${DOCKER_BUILDX_VERSION}" \
      "docker-ce-cli=${DOCKER_CLI_VERSION}" \
      "docker-compose-plugin=${DOCKER_COMPOSE_VERSION}" \
      ripgrep shellcheck; \
    rm -rf /var/lib/apt/lists/* /tmp/*; \
    test "$(deno --version | head -n 1)" = "deno 2.9.3 (stable, release, $(uname -m)-unknown-linux-gnu)"; \
    test "$(node --version)" = "v${NODE_VERSION}"; \
    test "$(npm --version)" = "${NPM_VERSION}"; \
    test "$(gh --version | head -n 1)" = "gh version ${GH_VERSION} (2026-07-02)"; \
    test "$(copilot --version | head -n 1)" = "GitHub Copilot CLI ${COPILOT_VERSION}."; \
    docker --version; \
    docker buildx version; \
    docker compose version

COPY .devcontainer/entrypoint.sh /usr/local/bin/bunny-hole-development-entrypoint
RUN chmod 0755 /usr/local/bin/bunny-hole-development-entrypoint

WORKDIR /tmp/bunny-hole
COPY deno.json deno.lock ./
COPY packages/protocol/deno.json packages/protocol/
COPY apps/relay/deno.json apps/relay/
COPY apps/connector/deno.json apps/connector/
COPY fixtures/origin/deno.json fixtures/origin/
RUN deno ci && chown -R vscode:vscode /deno-dir && rm -rf /tmp/bunny-hole

WORKDIR /workspaces/bunny-hole
ENTRYPOINT ["/usr/local/bin/bunny-hole-development-entrypoint"]
CMD ["sleep", "infinity"]
