# syntax=docker/dockerfile:1.7
ARG DENO_VERSION=2.9.5
FROM denoland/deno:${DENO_VERSION}@sha256:b429777c3dcff34a6488f365a1537db1640b2d48379b60f5e6206be034472463 AS frp
ARG TARGETARCH
ARG FRP_VERSION=0.70.1
ARG FRP_SHA_AMD64=333da23d1b9009d7c01638e9ba38cf4600f7d37d393f854e96ee1396adefa9a6
ARG FRP_SHA_ARM64=3990f396a9a490ee7f0e5f355287750ed41520064ed999eab443b5e9a78d773d
USER root
# Deno 2.9 `eval` has implicit permissions; the downloaded bytes are checksum-pinned.
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

FROM denoland/deno:${DENO_VERSION}@sha256:b429777c3dcff34a6488f365a1537db1640b2d48379b60f5e6206be034472463 AS trust
ARG CA_BUNDLE_SHA256=f66dff1bdf8f96060b8177976f8b7d9254bc89bc4db933d769f7384d28480bc9
ARG CA_BUNDLE_LICENSE_SHA256=fab3dd6bdab226f1c08630b1dd917e11fcb4ec5e1e020e2c16f83a0a13863e85
USER root
# curl.se publishes this Mozilla CA extract and its digest. Keep the source bytes and
# MPL-2.0 license independently pinned so FRP receives identical trust roots in OCI
# and native connector distributions.
RUN mkdir -p /out \
    && deno eval \
      'const [url,path,want]=Deno.args; const response=await fetch(url); if(!response.ok) throw new Error(`download failed: ${response.status}`); const bytes=new Uint8Array(await response.arrayBuffer()); const got=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(x=>x.toString(16).padStart(2,"0")).join(""); if(got!==want) throw new Error("pinned download checksum mismatch"); await Deno.writeFile(path,bytes);' \
      https://curl.se/ca/cacert-2026-08-13.pem /out/ca-certificates.crt "${CA_BUNDLE_SHA256}" \
    && deno eval \
      'const [url,path,want]=Deno.args; const response=await fetch(url); if(!response.ok) throw new Error(`download failed: ${response.status}`); const bytes=new Uint8Array(await response.arrayBuffer()); const got=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(x=>x.toString(16).padStart(2,"0")).join(""); if(got!==want) throw new Error("pinned download checksum mismatch"); await Deno.writeFile(path,bytes);' \
      https://www.mozilla.org/media/MPL/2.0/index.815ca599c9df.txt /out/MOZILLA-CA-LICENSE.txt "${CA_BUNDLE_LICENSE_SHA256}"

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
    && deno compile --config deno.runtime.json --frozen \
      --allow-env=BUNNY_HOLE_TLS_CERT_PATH,BUNNY_HOLE_TLS_KEY_PATH,PORT \
      --allow-net --allow-read \
      --output /out/tls-gateway fixtures/tls_gateway/main.ts \
    && mkdir -p /out/state

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS host-runtime
COPY --from=builder --chown=nonroot:nonroot /out/bunny-hole-host /usr/local/bin/bunny-hole-host
COPY --from=frp --chown=nonroot:nonroot /out/frps /usr/local/bin/frps
COPY --chown=nonroot:nonroot third_party/frp.LICENSE /usr/share/licenses/frp/LICENSE
COPY --from=builder --chown=nonroot:nonroot /out/state /var/lib/bunny-hole
ENV HOST=0.0.0.0 PORT=8080 BUNNY_HOLE_LOG_FORMAT=json \
    BUNNY_HOLE_STATE_PATH=/var/lib/bunny-hole/state.sqlite \
    BUNNY_HOLE_IDENTITY_PATH=/var/lib/bunny-hole/identity.json \
    BUNNY_HOLE_FRPS_PATH=/usr/local/bin/frps
EXPOSE 8080/tcp 7000/tcp
VOLUME ["/var/lib/bunny-hole"]
USER nonroot
ENTRYPOINT ["/usr/local/bin/bunny-hole-host"]

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS connector-runtime
COPY --from=builder --chown=nonroot:nonroot /out/bunny-hole /usr/local/bin/bunny-hole
COPY --from=frp --chown=nonroot:nonroot /out/frpc /usr/local/bin/frpc
COPY --from=trust --chown=nonroot:nonroot /out/ca-certificates.crt /usr/local/bin/ca-certificates.crt
COPY --from=trust --chown=nonroot:nonroot /out/MOZILLA-CA-LICENSE.txt /usr/share/licenses/mozilla-ca/MPL-2.0.txt
COPY --chown=nonroot:nonroot third_party/frp.LICENSE /usr/share/licenses/frp/LICENSE
ENV BUNNY_HOLE_FRPC_PATH=/usr/local/bin/frpc \
    BUNNY_HOLE_TRUSTED_CA_FILE=/usr/local/bin/ca-certificates.crt
ENV HOME=/tmp
WORKDIR /tmp
USER nonroot
ENTRYPOINT ["/usr/local/bin/bunny-hole"]
CMD ["connect"]

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS fixture-runtime
COPY --from=builder --chown=nonroot:nonroot /out/origin /usr/local/bin/origin
ENV PORT=3000
EXPOSE 3000
USER nonroot
ENTRYPOINT ["/usr/local/bin/origin"]

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f AS tls-gateway-runtime
COPY --from=builder --chown=nonroot:nonroot /out/tls-gateway /usr/local/bin/tls-gateway
ENV PORT=7443 \
    BUNNY_HOLE_TLS_CERT_PATH=/tls/tls.crt \
    BUNNY_HOLE_TLS_KEY_PATH=/tls/tls.key
EXPOSE 7443/tcp
USER nonroot
ENTRYPOINT ["/usr/local/bin/tls-gateway"]
