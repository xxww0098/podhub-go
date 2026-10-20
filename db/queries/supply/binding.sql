-- name: GetListingBinding :one
SELECT platform_sku_id, spec_version, design_revision
FROM sc_listing_bindings
WHERE org_id = sqlc.arg(org_id) AND listing_row_id = sqlc.arg(listing_row_id)::uuid;
