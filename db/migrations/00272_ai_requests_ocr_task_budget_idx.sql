-- +goose Up
-- +goose NO TRANSACTION
-- declaration 272 AiRequestsOcrTaskBudgetIdx m20261012_000052_ai_requests_ocr_task_budget_idx
-- source: migration/src/ai_requests_ocr_task_budget_idx.rs @ a03d735
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ai_requests_org_ocr_canonical_idx" ON "public"."ai_requests" ("org_id", (ocr_prompt ->> 'canonicalHash')) WHERE operation = 'ocr' AND job_id IS NULL AND (ocr_prompt ->> 'canonicalHash') IS NOT NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
