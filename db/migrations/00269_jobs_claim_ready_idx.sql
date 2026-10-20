-- +goose Up
-- +goose NO TRANSACTION
-- declaration 269 JobsClaimReady m20261007_000002_jobs_claim_ready_idx
-- source: migration/src/jobs_claim_ready.rs @ a03d735
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "jobs_worker_claim_idx" ON "public"."jobs" ("submitter_user_id", "lane", "created_at", "id", "run_at", "org_id") WHERE state IN ('queued', 'retry_wait') AND cancel_requested_at IS NULL AND executor NOT IN ('browser', 'http') AND attempt < max_attempts;
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX CONCURRENTLY IF EXISTS "public"."jobs_claim_head_idx";
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "jobs_head_oldest_worker_idx" ON "public"."jobs" ("submitter_user_id", "lane", "run_at") WHERE state IN ('queued', 'retry_wait') AND NOT (kind IN ('media.render', 'media.upload') AND executor = 'browser');
-- +goose StatementEnd
-- +goose StatementBegin
DROP INDEX CONCURRENTLY IF EXISTS "public"."jobs_head_oldest_idx";
-- +goose StatementEnd
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.refresh_account_queue_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u bigint:=COALESCE(NEW.submitter_user_id,OLD.submitter_user_id);
 l text:=COALESCE(NEW.lane,OLD.lane); oq bigint:=0; nq bigint:=0; orc bigint:=0; nr bigint:=0;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.submitter_user_id<>OLD.submitter_user_id OR NEW.lane<>OLD.lane) THEN
  RAISE EXCEPTION 'Job execution User and lane are immutable';
 END IF;
 IF TG_OP<>'INSERT' AND NOT (OLD.kind IN ('media.render','media.upload') AND OLD.executor = 'browser') THEN
  IF OLD.state IN ('queued','retry_wait') THEN oq:=OLD.cost_units; END IF;
  IF OLD.state='running' THEN orc:=OLD.cost_units; END IF;
 END IF;
 IF TG_OP<>'DELETE' AND NOT (NEW.kind IN ('media.render','media.upload') AND NEW.executor = 'browser') THEN
  IF NEW.state IN ('queued','retry_wait') THEN nq:=NEW.cost_units; END IF;
  IF NEW.state='running' THEN nr:=NEW.cost_units; END IF;
 END IF;
 IF oq=0 AND nq=0 AND orc=0 AND nr=0 THEN RETURN COALESCE(NEW,OLD); END IF;
 INSERT INTO public.account_queue_head(user_id,lane) VALUES(u,l) ON CONFLICT DO NOTHING;
 UPDATE public.account_queue_head SET queued_cost=queued_cost-oq+nq,running_cost=running_cost-orc+nr
 WHERE user_id=u AND lane=l;
 UPDATE public.account_queue_head SET oldest_job_at=(SELECT min(run_at) FROM public.jobs
  WHERE submitter_user_id=u AND lane=l AND state IN ('queued','retry_wait') AND NOT (kind IN ('media.render','media.upload') AND executor = 'browser')) WHERE user_id=u AND lane=l;
 DELETE FROM public.account_queue_head WHERE user_id=u AND lane=l AND queued_cost=0 AND running_cost=0;
 RETURN COALESCE(NEW,OLD);
END $$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "jobs_terminal_payload_idx" ON "public"."jobs" ("updated_at", "id") WHERE (state IN ('succeeded', 'cancelled') OR (state = 'failed' AND attempt < max_attempts)) AND (octet_length(payload::text) > 512 OR (result_ref IS NOT NULL AND kind NOT IN ('media.render', 'media.upload')));
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE public.jobs SET (
    autovacuum_vacuum_scale_factor = 0.02,
    autovacuum_vacuum_threshold = 1000,
    autovacuum_analyze_scale_factor = 0.02,
    autovacuum_analyze_threshold = 1000
);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
