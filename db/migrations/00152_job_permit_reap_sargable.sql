-- +goose Up
-- declaration 152 JobPermitReapSargable m20260913_000296_job_permit_reap_sargable
-- source: migration/src/job_permit_reap_sargable.rs @ a03d735
-- +goose StatementBegin
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
    PERFORM 1 FROM public.execution_quota WHERE user_id=0 ORDER BY class FOR UPDATE;
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
                            WHERE j.id = CASE
                                    WHEN p.holder_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                    THEN p.holder_id::uuid
                                END
                              AND j.lease_epoch = p.lease_epoch
                              AND j.state IN ('running', 'uncertain')
                        ))
                        OR (p.holder_kind IN ('ocr', 'upload_unit', 'verify')
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
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
