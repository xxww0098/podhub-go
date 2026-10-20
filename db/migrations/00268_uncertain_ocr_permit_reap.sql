-- +goose Up
-- declaration 268 UncertainOcrPermitReap m20261007_000001_uncertain_ocr_permit_reap
-- source: migration/src/uncertain_ocr_permit_reap.rs @ a03d735
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
                              AND NOT (
                                  j.state = 'uncertain'
                                  AND j.kind = 'ai.recognize'
                                  AND j.lease_until IS NOT NULL
                                  AND j.lease_until <= clock_timestamp() - interval '180 seconds'
                                  AND NOT EXISTS (
                                      SELECT 1 FROM public.ai_requests a
                                      WHERE a.org_id = j.org_id
                                        AND a.job_id = j.id
                                        AND a.status NOT IN ('settled', 'failed', 'unbilled_unknown')
                                  )
                              )
                        ))
                        OR (p.holder_kind IN ('ocr', 'upload_unit', 'verify')
                            AND p.expires_at IS NOT NULL
                            AND p.expires_at < clock_timestamp())
                   )
                 GROUP BY p.holder_kind, p.holder_id, p.lease_epoch
                 ORDER BY p.holder_kind, p.holder_id, p.lease_epoch
                 LIMIT GREATEST(p_limit, 1)
          ) stale_holders
         ORDER BY holder_kind, holder_id, lease_epoch
    LOOP
        IF public.release_execution_permit(stale.holder_kind, stale.holder_id, stale.lease_epoch) THEN
            n := n + 1;
        END IF;
    END LOOP;
    RETURN n;
END
$$;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
