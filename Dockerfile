# syntax=docker/dockerfile:1.7
ARG DENO_VERSION=2.9.5
FROM denoland/deno:${DENO_VERSION}@sha256:b429777c3dcff34a6488f365a1537db1640b2d48379b60f5e6206be034472463 AS frp
ARG TARGETARCH
ARG FRP_VERSION=0.70.1
ARG FRP_SHA_AMD64=333da23d1b9009d7c01638e9ba38cf4600f7d37d393f854e96ee1396adefa9a6
ARG FRP_SHA_ARM64=3990f396a9a490ee7f0e5f355287750ed41520064ed999eab443b5e9a78d773d
USER root
RUN case "${TARGETARCH}" in \
      amd64) FRP_SHA="${FRP_SHA_AMD64}" ;; \
      arm64) FRP_SHA="${FRP_SHA_ARM64}" ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && FRP_ARCH="linux_${TARGETARCH}" \
    && FRP_URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/frp_${FRP_VERSION}_${FRP_ARCH}.tar.gz" \
    && deno eval \
      'const [url,path,want]=Deno.args; const response=await fetch(url); if(!response.ok) throw new Error(`download failed: ${response.status}`); const bytes=new Uint8Array(await response.arrayBuffer()); const got=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(x=>x.toString(16).padStart(2,"0")).join(""); if(got!==want) throw new Error("FRP checksum mismatch"); await Deno.writeFile(path,bytes);' \
      "${FRP_URL}" /tmp/frp.tar.gz "${FRP_SHA}" \
    && mkdir -p /out /tmp/frp \
    && tar -xzf /tmp/frp.tar.gz -C /tmp/frp --strip-components=1 \
    && cp /tmp/frp/frps /out/frps \
    && cp /tmp/frp/frpc /out/frpc \
    && chmod 0755 /out/frps /out/frpc

FROM denoland/deno:${DENO_VERSION}@sha256:b429777c3dcff34a6488f365a1537db1640b2d48379b60f5e6206be034472463 AS builder
WORKDIR /src
COPY deno.runtime.json deno.runtime.lock ./
COPY packages ./packages
COPY apps ./apps
COPY fixtures ./fixtures
RUN deno compile --config deno.runtime.json --frozen \
      --allow-env --allow-net --allow-read --allow-write --allow-run --allow-sys \
      --output /out/bunny-hole-host apps/host/main.ts \
    && deno compile --config deno.runtime.json --frozen \
      --allow-env --allow-net --allow-read --allow-write --allow-run --allow-sys \
      --output /out/bunny-hole apps/connector/main.ts \
    && deno compile --config deno.runtime.json --frozen --allow-env=PORT --allow-net \
      --output /out/origin fixtures/origin/main.ts \
    && mkdir -p /out/state

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:fccdbb0a547c14e23fcf4ce8ad62ca5d43b4faae8d22cd292f490fef9946c96e AS host-runtime
COPY --from=builder --chown=nonroot:nonroot /out/bunny-hole-host /usr/local/bin/bunny-hole-host
COPY --from=frp --chown=nonroot:nonroot /out/frps /usr/local/bin/frps
COPY --from=builder --chown=nonroot:nonroot /out/state /var/lib/bunny-hole
ENV HOST=0.0.0.0 PORT=8080 BUNNY_HOLE_LOG_FORMAT=json \
    BUNNY_HOLE_STATE_PATH=/var/lib/bunny-hole/state.sqlite \
    BUNNY_HOLE_IDENTITY_PATH=/var/lib/bunny-hole/identity.json \
    BUNNY_HOLE_FRPS_PATH=/usr/local/bin/frps
EXPOSE 8080/tcp 7000/tcp
VOLUME ["/var/lib/bunny-hole"]
USER nonroot
ENTRYPOINT ["/usr/local/bin/bunny-hole-host"]

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:fccdbb0a547c14e23fcf4ce8ad62ca5d43b4faae8d22cd292f490fef9946c96e AS connector-runtime
COPY --from=builder --chown=nonroot:nonroot /out/bunny-hole /usr/local/bin/bunny-hole
COPY --from=frp --chown=nonroot:nonroot /out/frpc /usr/local/bin/frpc
ENV BUNNY_HOLE_FRPC_PATH=/usr/local/bin/frpc
USER nonroot
ENTRYPOINT ["/usr/local/bin/bunny-hole"]
CMD ["connect"]

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:fccdbb0a547c14e23fcf4ce8ad62ca5d43b4faae8d22cd292f490fef9946c96e AS fixture-runtime
COPY --from=builder --chown=nonroot:nonroot /out/origin /usr/local/bin/origin
ENV PORT=3000
EXPOSE 3000
USER nonroot
ENTRYPOINT ["/usr/local/bin/origin"]
