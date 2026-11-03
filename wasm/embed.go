// Package wasm embeds the committed production server module, listing-core
// in dist/server/. The browser builds under dist/browser/ are loaded by the
// web client and are not embedded here.
// dist/SOURCES.sha256 pins every file in dist; it is checked by
// scripts/check-wasm-dist.sh and by this package's tests.
package wasm

import _ "embed"

//go:embed dist/server/listing-core.wasm
var ListingCore []byte
