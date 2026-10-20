-- +goose Up
-- declaration 85 TenantQueueHead m20260827_000244_tenant_queue_head
-- source: migration/src/tenant_queue_head.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.tenant_queue_head (
    org_id              bigint NOT NULL REFERENCES public.organizations(id),
    lane                text NOT NULL,
    oldest_job_at       timestamptz,
    queued_cost         bigint NOT NULL DEFAULT 0,
    running_cost        bigint NOT NULL DEFAULT 0,
    virtual_finish_at   double precision NOT NULL DEFAULT 0,
    PRIMARY KEY (org_id, lane),
    CONSTRAINT tenant_queue_head_costs_nonneg CHECK (queued_cost >= 0 AND running_cost >= 0)
);

DROP INDEX IF EXISTS public.tenant_queue_head_claim_idx;
CREATE INDEX tenant_queue_head_claim_idx
    ON public.tenant_queue_head (lane, virtual_finish_at, oldest_job_at)
    WHERE queued_cost > 0;

-- Plan weight for virtual-finish advance. Paid plans move their virtual
-- clock more slowly per unit of cost, so they are picked more often; the
-- floor of 1 means no plan ever gets *no* credit, and the aging term in the
-- claim query (not here) bounds how long any head can wait.
CREATE OR REPLACE FUNCTION public.queue_plan_weight(org bigint)
RETURNS float8 LANGUAGE sql STABLE AS $$
    SELECT CASE COALESCE((SELECT o.plan FROM public.organizations o WHERE o.id = org), 'free')
        WHEN 'free'  THEN 1.0
        WHEN 'lite'  THEN 2.0
        WHEN 'pro'   THEN 4.0
        WHEN 'max'   THEN 8.0
        WHEN 'ultra' THEN 16.0
        ELSE 1.0
    END;
$$;

-- Per-row incremental maintenance of the (org, lane) head. Every delta is an
-- arithmetic expression on the *current* head row, so concurrent transitions
-- for the same head add up exactly once each (no lost updates).
CREATE OR REPLACE FUNCTION public.refresh_tenant_queue_head()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    h_org  bigint := COALESCE(NEW.org_id, OLD.org_id);
    h_lane text   := COALESCE(NEW.lane, OLD.lane);
    old_queued  bigint := 0;
    new_queued  bigint := 0;
    old_running bigint := 0;
    new_running bigint := 0;
BEGIN
    IF TG_OP <> 'INSERT' AND OLD.state IN ('queued', 'retry_wait') THEN
        old_queued := OLD.cost_units;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.state IN ('queued', 'retry_wait') THEN
        new_queued := NEW.cost_units;
    END IF;
    IF TG_OP <> 'INSERT' AND OLD.state = 'running' THEN
        old_running := OLD.cost_units;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.state = 'running' THEN
        new_running := NEW.cost_units;
    END IF;

    INSERT INTO public.tenant_queue_head (org_id, lane, oldest_job_at, queued_cost, running_cost, virtual_finish_at)
    VALUES (h_org, h_lane, NULL, 0, 0, 0)
    ON CONFLICT (org_id, lane) DO NOTHING;

    UPDATE public.tenant_queue_head
       SET queued_cost = GREATEST(0, queued_cost - old_queued + new_queued),
           running_cost = GREATEST(0, running_cost - old_running + new_running),
           virtual_finish_at = CASE
               WHEN old_queued > 0 AND new_queued = 0 AND new_running > 0
               THEN virtual_finish_at + (NEW.cost_units::float8 / public.queue_plan_weight(h_org))
               ELSE virtual_finish_at
           END
     WHERE org_id = h_org AND lane = h_lane;

    -- oldest_job_at = earliest run_at still queued. The MIN is scoped to one
    -- (org, lane) via jobs_head_oldest_idx; it runs only when the cached
    -- value may be stale (a queued row left that was at/before the cached
    -- oldest, or a joined row with an earlier run_at).
    UPDATE public.tenant_queue_head
       SET oldest_job_at = (
           SELECT MIN(run_at)
             FROM public.jobs
            WHERE org_id = h_org AND lane = h_lane
              AND state IN ('queued', 'retry_wait')
       )
     WHERE org_id = h_org AND lane = h_lane
       AND (
           (old_queued > 0 AND (oldest_job_at IS NULL OR OLD.run_at <= oldest_job_at))
           OR (new_queued > 0 AND (oldest_job_at IS NULL OR (TG_OP = 'INSERT' AND NEW.run_at < oldest_job_at)))
       );

    DELETE FROM public.tenant_queue_head
     WHERE org_id = h_org AND lane = h_lane
       AND queued_cost = 0 AND running_cost = 0;

    RETURN COALESCE(NEW, OLD);
END $$;

DROP TRIGGER IF EXISTS jobs_tenant_queue_head ON public.jobs;
CREATE TRIGGER jobs_tenant_queue_head
AFTER INSERT OR UPDATE OF state, cost_units, lane OR DELETE ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.refresh_tenant_queue_head();

-- The head is maintained by the jobs trigger under whichever role changed
-- the job row (app for tenant enqueue/writeback paths, worker for claim and
-- reclaim) and is read by claim (worker) and the enqueue quota gate (app):
-- both roles need full DML. queue_plan_weight also reads the owning org's
-- plan, so worker/app need SELECT on organizations too.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tenant_queue_head TO podhub_app, podhub_worker;
GRANT SELECT ON TABLE public.organizations TO podhub_app, podhub_worker;

-- Per-(org, lane) queued scan for claim's bounded lateral: one head, at most
-- CLAIM_MAX_PER_ORG rows, walked in scheduler order (priority, run_at,
-- created_at) so the number of rows examined never grows with the backlog.
DROP INDEX IF EXISTS public.jobs_claim_head_idx;
CREATE INDEX jobs_claim_head_idx
    ON public.jobs (org_id, lane, state, priority ASC, run_at ASC, created_at ASC)
    WHERE state IN ('queued', 'retry_wait');

-- Oldest-queued recompute: MIN(run_at) per (org, lane) is the first entry of
-- this index, so the trigger's aggregate is O(1) index probes, bounded per
-- org/lane and independent of total queue size.
DROP INDEX IF EXISTS public.jobs_head_oldest_idx;
CREATE INDEX jobs_head_oldest_idx
    ON public.jobs (org_id, lane, state, run_at ASC, created_at ASC)
    WHERE state IN ('queued', 'retry_wait');
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
