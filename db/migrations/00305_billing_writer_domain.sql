-- +goose Up
-- declaration 305 BillingWriterDomain
-- Post-Rust append. Does not edit 00001-00293. Adds the billing write-lease
-- domain so chat hold and settle can call writer.Assert on their own row.
-- +goose StatementBegin
ALTER TABLE public.writer_leases DROP CONSTRAINT writer_leases_domain_known;
ALTER TABLE public.writer_leases ADD CONSTRAINT writer_leases_domain_known CHECK (
    domain IN (
        'auth',
        'entitlement',
        'catalog',
        'recipe',
        'telemetry',
        'admin',
        'release',
        'billing'
    )
);
-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback. This append follows that shape.
SELECT 1;
