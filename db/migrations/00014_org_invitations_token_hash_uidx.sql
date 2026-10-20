-- +goose Up
-- +goose NO TRANSACTION
-- declaration 14 OrgInvitationsTokenHashUidx m20260802_000042_org_invitations_token_hash_uidx
-- source: migration/src/idempotency.rs @ a03d735
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "org_invitations_token_hash_uidx" ON "public"."org_invitations" ("token_hash");
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
