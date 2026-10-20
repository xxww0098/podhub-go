-- sqlc schema only. Runtime objects come from goose migrations.
CREATE TABLE sc_listing_bindings (
    org_id bigint NOT NULL,
    listing_row_id uuid NOT NULL,
    platform_sku_id text NOT NULL,
    spec_version bigint NOT NULL,
    design_revision bigint NOT NULL,
    PRIMARY KEY (org_id, listing_row_id)
);
