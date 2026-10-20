FROM golang:1.27.2-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/api ./cmd/api \
    && CGO_ENABLED=0 go build -trimpath -o /out/worker-listing ./cmd/worker-listing \
    && CGO_ENABLED=0 go build -trimpath -o /out/worker-sync ./cmd/worker-sync \
    && CGO_ENABLED=0 go build -trimpath -o /out/worker-reconcile ./cmd/worker-reconcile \
    && CGO_ENABLED=0 go build -trimpath -o /out/worker-media-gc ./cmd/worker-media-gc \
    && CGO_ENABLED=0 go build -trimpath -o /out/writer-lease ./cmd/writer-lease

FROM debian:bookworm-slim
RUN useradd --system --uid 65532 --create-home podhub
COPY --from=build /out/ /usr/local/bin/
USER podhub
EXPOSE 8080
ENTRYPOINT ["api"]
