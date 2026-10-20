// Package rules serves the operator-maintained banned-tag table.
//
// Rust's global table is public.banned_tags. Super admins edit it through
// /api/admin/banned-tags; each write is audited. MountBannedWrites is that
// API. Sessions stay in identity. There is no unauthenticated write.
//
// LoadEnabledBannedTags is the uncached read for GET /api/listing/rules.
// The sqlc call stays in internal/platform. A committed row is visible to the
// next request. Rust keeps a one-second
// process cache (src/platform/banned_tags/store.rs) and drops it on a local
// write; other processes can be up to a second behind. This read is never
// later than that cache, and it can be earlier.
//
// GET /api/me/catalog/banned-tags uses EnabledBannedTags in banned.go, which
// keeps that one-second cache. GET /api/admin/banned-tags lists every row
// and does not use the cache. Writes, audit rows, and LISTEN are not here.
//
// The table has no org_id and the copied migration does not enable RLS.
// LoadEnabledBannedTags does not call tenant.EnterApp and does not filter
// by org. Matching itself is listing-core, not this package.
package rules
