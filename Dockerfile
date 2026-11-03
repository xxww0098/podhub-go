FROM golang:1.27.2-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/api ./cmd/api \
    && CGO_ENABLED=0 go build -trimpath -o /out/migrate ./cmd/migrate \
    && CGO_ENABLED=0 go build -trimpath -o /out/lease-keeper ./cmd/lease-keeper \
    && CGO_ENABLED=0 go build -trimpath -o /out/worker-listing ./cmd/worker-listing \
    && CGO_ENABLED=0 go build -trimpath -o /out/worker-sync ./cmd/worker-sync \
    && CGO_ENABLED=0 go build -trimpath -o /out/worker-reconcile ./cmd/worker-reconcile \
    && CGO_ENABLED=0 go build -trimpath -o /out/worker-media-gc ./cmd/worker-media-gc \
    && CGO_ENABLED=0 go build -trimpath -o /out/writer-lease ./cmd/writer-lease \
    && CGO_ENABLED=0 go build -trimpath -o /out/admin-init ./cmd/admin-init

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 65532 --create-home podhub
COPY --from=build /out/ /usr/local/bin/
ENV CLOUD_BIND=0.0.0.0:8080
USER podhub
EXPOSE 8080
# The image ships every command; only the api service declares a healthcheck
# in compose.yaml, because worker and one-shot images have no HTTP endpoint.
ENTRYPOINT ["api"]
