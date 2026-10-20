-- +goose Up
-- declaration 217 ClaimExecutorColumn m20260923_100000_claim_executor_column
-- source: migration/src/claim_executor_column.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.jobs
    ADD COLUMN executor text GENERATED ALWAYS AS (COALESCE(payload->>'executor', '')) STORED;

DROP INDEX public.jobs_claim_head_idx;
CREATE INDEX jobs_claim_head_idx
    ON public.jobs (submitter_user_id, lane, created_at, id)
    WHERE state IN ('queued', 'retry_wait')
      AND executor NOT IN ('browser', 'http');

CREATE FUNCTION public.execution_member_active(p_org_id bigint, p_user_id bigint)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.organization_members
         WHERE org_id = p_org_id
           AND user_id = p_user_id
           AND status = 'active'
    )
$$;

GRANT EXECUTE ON FUNCTION public.execution_member_active(bigint, bigint)
    TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
