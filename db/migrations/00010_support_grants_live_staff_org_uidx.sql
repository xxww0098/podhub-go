-- +goose Up
-- +goose NO TRANSACTION
-- declaration 10 SupportGrantsLiveStaffOrgUidx m20260802_000034_support_grants_live_staff_org_uidx
-- source: migration/src/uniqueness.rs @ a03d735
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "support_grants_live_staff_org_uidx" ON "public"."support_grants" ("staff_user_id", "org_id") WHERE revoked_at IS NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
