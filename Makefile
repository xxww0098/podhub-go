.PHONY: test build fmt vet tidy generate codegen-tools codegen-versions ci wasm wasm-check

GOBIN := $(shell go env GOPATH)/bin
export PATH := $(GOBIN):$(PATH)

SQLC_VERSION := v1.31.1
OAPI_CODEGEN_VERSION := v2.8.0
CODEGEN_BIN ?= $(GOBIN)

test:
	go test ./...

build: wasm-check
	go build -o bin/api ./cmd/api
	go build -o bin/migrate ./cmd/migrate
	go build -o bin/lease-keeper ./cmd/lease-keeper
	go build -o bin/worker-listing ./cmd/worker-listing
	go build -o bin/worker-sync ./cmd/worker-sync
	go build -o bin/worker-reconcile ./cmd/worker-reconcile
	go build -o bin/worker-media-gc ./cmd/worker-media-gc
	go build -o bin/writer-lease ./cmd/writer-lease
	go build -o bin/admin-init ./cmd/admin-init

fmt:
	gofmt -w .

vet:
	go vet ./...

tidy:
	go mod tidy

# Only the 7 kept api/codegen/*.yaml configs generate output (agent, catalog,
# health, identity, listing, listing-rules, media); the other domains write
# their http packages by hand (decisions.md D24). Each config writes its own
# output file, so the order does not matter.
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

# Go/Web checks consume committed WASM; scheduler tests use the pinned Rust toolchain.
ci:
	cd rust && cargo test --locked -p listing-core -p listing-core-wasm -p render -p psdx -p render-wasm
	test -z "$$(gofmt -l .)"
	$(MAKE) vet
	go test ./tests/archtest
	bash scripts/test-wasm-dist.sh
	scripts/check-wasm-dist.sh
	go test -timeout 25m ./...
	$(MAKE) generate
	git diff --exit-code

# Rebuild every server and browser artifact locally from rust/, then refresh
# the manifest. This is the only target that compiles WASM. Use
# `scripts/build-wasm.sh core|render` for a partial rebuild, then
# `scripts/check-wasm-dist.sh --update`.
wasm:
	scripts/build-wasm.sh all
	scripts/check-wasm-dist.sh --update

wasm-check:
	scripts/check-wasm-dist.sh
