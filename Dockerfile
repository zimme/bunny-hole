# syntax=docker/dockerfile:1.7
ARG DENO_VERSION=2.9.3
FROM denoland/deno:${DENO_VERSION}@sha256:6288db6be1c26473bb9d1843f906d9a219c0dda57fd85de4aac90296951cf6ef AS builder
WORKDIR /src
COPY deno.json deno.lock ./
COPY packages ./packages
COPY apps ./apps
COPY fixtures ./fixtures
RUN deno compile --frozen --allow-env=HOST,PORT,BUNNY_HOLE_LOCAL_DEVELOPMENT,BUNNY_HOLE_LOG_FORMAT,BUNNY_HOLE_TUNNELS --allow-net --output /out/relay apps/relay/main.ts \
    && deno compile --frozen --allow-env=BUNNY_HOLE_LOCAL_DEVELOPMENT,BUNNY_HOLE_ALLOW_PRIVATE_NETWORK,BUNNY_HOLE_RELAY_URL,BUNNY_HOLE_TUNNEL_ID,BUNNY_HOLE_TUNNEL_SECRET,BUNNY_HOLE_ORIGIN,BUNNY_HOLE_LOG_FORMAT --allow-net --allow-read --output /out/connector apps/connector/main.ts \
    && deno compile --frozen --allow-env=PORT --allow-net --output /out/origin fixtures/origin/main.ts

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:fccdbb0a547c14e23fcf4ce8ad62ca5d43b4faae8d22cd292f490fef9946c96e AS relay-runtime
COPY --from=builder --chown=nonroot:nonroot /out/relay /usr/local/bin/relay
ENV HOST=0.0.0.0 PORT=8080 BUNNY_HOLE_LOG_FORMAT=json
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/relay"]

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:fccdbb0a547c14e23fcf4ce8ad62ca5d43b4faae8d22cd292f490fef9946c96e AS connector-runtime
COPY --from=builder --chown=nonroot:nonroot /out/connector /usr/local/bin/bunny-hole
USER nonroot
ENTRYPOINT ["/usr/local/bin/bunny-hole"]
CMD ["connect"]

FROM gcr.io/distroless/cc-debian12:nonroot@sha256:fccdbb0a547c14e23fcf4ce8ad62ca5d43b4faae8d22cd292f490fef9946c96e AS fixture-runtime
COPY --from=builder --chown=nonroot:nonroot /out/origin /usr/local/bin/origin
ENV PORT=3000
EXPOSE 3000
USER nonroot
ENTRYPOINT ["/usr/local/bin/origin"]
