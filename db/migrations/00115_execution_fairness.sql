-- +goose Up
-- declaration 115 ExecutionFairness m20260905_000276_execution_fairness
-- source: migration/src/execution_fairness.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.jobs
    ADD COLUMN IF NOT EXISTS submitter_user_id bigint NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS jobs_submitter_claim_idx
    ON public.jobs (org_id, lane, submitter_user_id, created_at, id)
    WHERE state IN ('queued', 'retry_wait');

CREATE TABLE IF NOT EXISTS public.execution_fairness (
    class text NOT NULL,
    org_id bigint NOT NULL,
    deficit bigint NOT NULL DEFAULT 0,
    submitter_cursor bigint NOT NULL DEFAULT 0,
    CONSTRAINT execution_fairness_pkey PRIMARY KEY (class, org_id),
    CONSTRAINT execution_fairness_deficit_nonneg CHECK (deficit >= 0),
    CONSTRAINT execution_fairness_deficit_capped CHECK (deficit <= 2),
    CONSTRAINT execution_fairness_class_known
        CHECK (class IN ('ai_ocr', 'cloud_upload'))
);

CREATE TABLE IF NOT EXISTS public.execution_fairness_cursor (
    class text PRIMARY KEY,
    last_org_id bigint NOT NULL DEFAULT 0,
    CONSTRAINT execution_fairness_cursor_class_known
        CHECK (class IN ('ai_ocr', 'cloud_upload'))
);

INSERT INTO public.execution_fairness_cursor (class, last_org_id) VALUES
    ('ai_ocr', 0),
    ('cloud_upload', 0)
ON CONFLICT (class) DO NOTHING;

ALTER TABLE public.execution_permits
    DROP CONSTRAINT IF EXISTS execution_permits_holder_known;
ALTER TABLE public.execution_permits
    ADD CONSTRAINT execution_permits_holder_known
        CHECK (holder_kind IN ('job', 'ocr', 'upload_unit'));

CREATE OR REPLACE FUNCTION public.reap_stale_execution_permits(p_limit bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    stale record;
    n bigint := 0;
BEGIN
    FOR stale IN
        SELECT holder_kind, holder_id, lease_epoch
          FROM (
                SELECT p.holder_kind, p.holder_id, p.lease_epoch
                  FROM public.execution_permits p
                 WHERE p.released_at IS NULL
                   AND (
                        (p.holder_kind = 'job' AND NOT EXISTS (
                            SELECT 1
                            FROM public.jobs j
                            WHERE j.id::text = p.holder_id
                              AND j.lease_epoch = p.lease_epoch
                              AND j.state = 'running'
                        ))
                        OR (p.holder_kind IN ('ocr', 'upload_unit')
                            AND p.expires_at IS NOT NULL
                            AND p.expires_at < clock_timestamp())
                   )
                 GROUP BY p.holder_kind, p.holder_id, p.lease_epoch
                 LIMIT GREATEST(p_limit, 1)
          ) stale_holders
    LOOP
        IF public.release_execution_permit(stale.holder_kind, stale.holder_id, stale.lease_epoch) THEN
            n := n + 1;
        END IF;
    END LOOP;
    RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION public.drr_on_grant(
    p_class text,
    p_org_id bigint,
    p_submitter bigint
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_class NOT IN ('ai_ocr', 'cloud_upload') OR p_org_id <= 0 THEN
        RETURN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.organization_members WHERE org_id = p_org_id AND user_id = p_submitter AND status = 'active') THEN
        RETURN;
    END IF;

    INSERT INTO public.execution_fairness_cursor (class, last_org_id)
    VALUES (p_class, 0)
    ON CONFLICT (class) DO NOTHING;

    PERFORM 1
    FROM public.execution_fairness_cursor
    WHERE class = p_class
    FOR UPDATE;

    INSERT INTO public.execution_fairness (class, org_id, deficit, submitter_cursor)
    VALUES (p_class, p_org_id, 0, p_submitter)
    ON CONFLICT (class, org_id) DO UPDATE
        SET deficit = GREATEST(
                LEAST(public.execution_fairness.deficit + 1, 2) - 1,
                0
            ),
            submitter_cursor = p_submitter;

    UPDATE public.execution_fairness_cursor
       SET last_org_id = p_org_id
     WHERE class = p_class;
END;
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.execution_fairness TO podhub_app, podhub_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.execution_fairness_cursor TO podhub_app, podhub_worker;
GRANT EXECUTE ON FUNCTION public.drr_on_grant(text, bigint, bigint) TO podhub_app, podhub_worker;
GRANT EXECUTE ON FUNCTION public.reap_stale_execution_permits(bigint) TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
