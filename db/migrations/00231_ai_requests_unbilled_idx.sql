-- +goose Up
-- +goose NO TRANSACTION
-- declaration 231 AiRequestsUnbilledIdx m20260927_000413_ai_requests_unbilled_idx
-- source: migration/src/ai_requests_unbilled_idx.rs @ a03d735
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ai_requests_org_unbilled_idx" ON "public"."ai_requests" ("org_id", "updated_at") WHERE status = 'unbilled_unknown';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
