-- +goose Up
-- +goose NO TRANSACTION
-- declaration 11 AuditLogsSupportGrantListingIdx m20260802_000035_audit_logs_support_grant_listing_idx
-- source: migration/src/uniqueness.rs @ a03d735
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_audit_logs_support_grant_listing" ON "public"."audit_logs" ("support_grant_id", "created_at_ms") WHERE action = 'support_write';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
