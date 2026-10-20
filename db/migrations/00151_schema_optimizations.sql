-- +goose Up
-- +goose NO TRANSACTION
-- declaration 151 SchemaOptimizations m20260913_000295_schema_optimizations
-- source: migration/src/schema_optimizations.rs @ a03d735
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_media_object_leases_org_hash" ON "public"."media_object_leases" ("org_id", "content_hash");
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_ai_requests_stranded" ON "public"."ai_requests" ("updated_at", "id") WHERE status IN ('held','dispatching');
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_ai_requests_response_body_due" ON "public"."ai_requests" ("id") WHERE response_body IS NOT NULL;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_billing_operations_reap" ON "public"."billing_operations" ("updated_at") WHERE state IN ('reserved','outcome_unknown');
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_jobs_org_updated" ON "public"."jobs" ("org_id", "updated_at", "id");
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_jobs_org_aggregate" ON "public"."jobs" ("org_id", "aggregate_type", "aggregate_id", "kind");
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_submission_intents_org_updated" ON "public"."submission_intents" ("org_id", "updated_at", "id");
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_submission_intents_due" ON "public"."submission_intents" ("reconcile_after", "updated_at", "id") WHERE state IN ('unknown','accepted');
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_payment_orders_org_created" ON "public"."payment_orders" ("org_id", "created_at");
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_listing_rows_sendable" ON "public"."listing_rows" ("org_id", "updated_at") WHERE submission_state IN ('queued','submitting','unknown') OR media_state = 'ready';
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_account_users_email_lower" ON "public"."account_users" (lower(email));
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_org_invitations_org_email_lower" ON "public"."org_invitations" ("org_id", lower(email)) WHERE accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_media_object_leases_lookup" ON "public"."media_object_leases" ("org_id", "media_account_id", md5(object_key));
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_listing_rows_org_updated_id" ON "public"."listing_rows" ("org_id", "updated_at", "id");
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_listing_rows_org_category_updated_id" ON "public"."listing_rows" ("org_id", "category_key", "updated_at", "id");
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_listing_cards_org_updated_id" ON "public"."listing_cards" ("org_id", "updated_at", "id");
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX CONCURRENTLY IF EXISTS "public"."listing_rows_org_card_idx";
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX CONCURRENTLY IF EXISTS "public"."ai_price_schedules_model_effective_idx";
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX CONCURRENTLY IF EXISTS "public"."ix_shipping_preset_versions_preset";
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
