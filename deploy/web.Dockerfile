FROM oven/bun:1 AS build
WORKDIR /src
COPY VERSION CHANGELOG.md ./
COPY web/package.json web/bun.lock ./web/
RUN cd web && bun install --frozen-lockfile
COPY web ./web
COPY rust ./rust
COPY wasm ./wasm
COPY scripts ./scripts
RUN cd web && bun run build

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/web/dist /srv/podhub/web
EXPOSE 80 443
