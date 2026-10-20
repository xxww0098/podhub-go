-- +goose Up
-- declaration 110 SubmissionIssues m20260905_000271_submission_issues
-- source: migration/src/submission_issues.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE submission_intents ADD COLUMN submission_issues jsonb NOT NULL DEFAULT '[]'::jsonb
 CHECK (jsonb_typeof(submission_issues) = 'array' AND jsonb_array_length(submission_issues) <= 8);
CREATE INDEX IF NOT EXISTS submission_intents_open_store_issues ON submission_intents(org_id, store_id)
 WHERE submission_issues @> '[{"scope":"store","resolvedAtMs":null}]'::jsonb;
CREATE OR REPLACE FUNCTION resolve_listing_credential_issues() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE submission_intents SET submission_issues = (
   SELECT jsonb_agg(CASE WHEN issue->>'scope' = 'store'
     AND issue->>'resolvedAtMs' IS NULL
     AND issue->>'retryAfterMs' IS NULL
     AND (issue->>'credentialRevision')::bigint <> NEW.credential_revision
   THEN jsonb_set(issue, '{resolvedAtMs}', to_jsonb((extract(epoch from clock_timestamp()) * 1000)::bigint))
   ELSE issue END ORDER BY ord)
   FROM jsonb_array_elements(submission_issues) WITH ORDINALITY e(issue, ord)
 ), updated_at = clock_timestamp()
 WHERE org_id = NEW.org_id AND store_id = NEW.uuid
 AND submission_issues @> '[{"scope":"store","resolvedAtMs":null}]'::jsonb;
 RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS listing_credential_issues_resolved ON organization_stores;
CREATE TRIGGER listing_credential_issues_resolved AFTER UPDATE OF credential_revision ON organization_stores
 FOR EACH ROW WHEN (OLD.credential_revision IS DISTINCT FROM NEW.credential_revision)
 EXECUTE FUNCTION resolve_listing_credential_issues();
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
