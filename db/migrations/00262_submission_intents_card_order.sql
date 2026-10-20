-- +goose Up
-- +goose NO TRANSACTION
-- declaration 262 SubmissionIntentsCardOrder m20261004_000445_submission_intents_card_order
-- source: migration/src/submission_intents_card_order.rs @ a03d735
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "submission_intents_org_card_created_idx" ON "public"."submission_intents" ("org_id", "card_id", "created_at", "id") WHERE card_id IS NOT NULL;
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX CONCURRENTLY IF EXISTS "public"."submission_intents_org_card_idx";
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
