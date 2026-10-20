.PHONY: test build fmt vet tidy generate codegen-tools codegen-versions ci listing-wasm wasm web-wasm wasm-check

GOBIN := $(shell go env GOPATH)/bin
export PATH := $(GOBIN):$(PATH)

SQLC_VERSION := v1.31.1
OAPI_CODEGEN_VERSION := v2.8.0
CODEGEN_BIN ?= $(GOBIN)

test:
	go test ./...

build: wasm-check
	go build -o bin/api ./cmd/api
	go build -o bin/worker-listing ./cmd/worker-listing
	go build -o bin/worker-sync ./cmd/worker-sync
	go build -o bin/worker-reconcile ./cmd/worker-reconcile
	go build -o bin/worker-media-gc ./cmd/worker-media-gc
	go build -o bin/writer-lease ./cmd/writer-lease

fmt:
	gofmt -w .

vet:
	go vet ./...

tidy:
	go mod tidy

# Every api/codegen/*.yaml is generated; a new domain only adds a file there.
# Each config writes its own output file, so the order does not matter.
# CI sets CODEGEN_BIN to its cached directory. A binary that is missing or
# reports another version is reinstalled.
generate: codegen-tools
	$(CODEGEN_BIN)/sqlc generate
	for cfg in api/codegen/*.yaml; do \
		$(CODEGEN_BIN)/oapi-codegen -config $$cfg api/openapi.yaml || exit 1; \
	done

codegen-tools:
	@mkdir -p $(CODEGEN_BIN)
	@$(CODEGEN_BIN)/sqlc version 2>/dev/null | grep -qx '$(SQLC_VERSION)' || \
		GOBIN=$(CODEGEN_BIN) go install github.com/sqlc-dev/sqlc/cmd/sqlc@$(SQLC_VERSION)
	@$(CODEGEN_BIN)/oapi-codegen -version 2>/dev/null | grep -qx '$(OAPI_CODEGEN_VERSION)' || \
		GOBIN=$(CODEGEN_BIN) go install github.com/oapi-codegen/oapi-codegen/v2/cmd/oapi-codegen@$(OAPI_CODEGEN_VERSION)

# CI reads the generator versions from here for its cache key.
codegen-versions:
	@echo SQLC_VERSION=$(SQLC_VERSION)
	@echo OAPI_CODEGEN_VERSION=$(OAPI_CODEGEN_VERSION)

# CI consumes committed WASM and never installs a Rust toolchain.
ci:
	test -z "$$(gofmt -l .)"
	$(MAKE) vet
	go test ./tests/archtest
	bash scripts/test-wasm-dist.sh
	scripts/check-wasm-dist.sh
	LISTING_TAGS_WASM=wasm/dist/server/listing-tags.wasm \
	WASM_HOST_PROBE=wasm/dist/test/host-probe.wasm \
	LISTING_CORE_WASM=wasm/dist/server/listing-core.wasm \
	LISTING_STATE_WASM=wasm/dist/browser/listing-state.wasm \
	go test -timeout 25m ./...
	$(MAKE) generate
	git diff --exit-code

# Partial local builds do not refresh the shared source manifest.
listing-wasm:
	scripts/build-wasm.sh tags --copy

# Rebuild every server and browser artifact locally from rust/, then refresh
# the manifest. This is the only target that compiles Rust.
wasm:
	scripts/build-wasm.sh all --copy
	$(MAKE) web-wasm
	scripts/check-wasm-dist.sh --update

# Browser render WASM, JS glue, declarations and worker snippets are committed
# together. The browser listing module comes from scripts/build-wasm.sh, which
# builds it from the same sources as the server module.
web-wasm:
	bash web/scripts/build-render.sh

wasm-check:
	scripts/check-wasm-dist.sh
