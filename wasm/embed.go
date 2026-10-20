// Package wasm embeds the committed production server modules: listing-tags
// and listing-core, both built into dist/server/. The browser builds under
// dist/browser/ are loaded by the web client, and the host probe under
// dist/test/ is a test-only module; neither is embedded here.
// dist/SOURCES.sha256 pins every file in dist; it is checked by
// scripts/check-wasm-dist.sh and by this package's tests.
package wasm

import _ "embed"

//go:embed dist/server/listing-tags.wasm
var ListingTags []byte

//go:embed dist/server/listing-core.wasm
var ListingCore []byte
