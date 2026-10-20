-- +goose Up
-- declaration 116 ArtifactVerification m20260905_000277_artifact_verification
-- source: migration/src/artifact_verification.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.media_object_leases
    ADD COLUMN IF NOT EXISTS verification_status text NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS verified_at timestamptz,
    ADD COLUMN IF NOT EXISTS verified_byte_length bigint,
    ADD COLUMN IF NOT EXISTS verified_width integer,
    ADD COLUMN IF NOT EXISTS verified_height integer;
ALTER TABLE public.media_object_leases
    DROP CONSTRAINT IF EXISTS media_object_leases_verification_status_known;
ALTER TABLE public.media_object_leases
    ADD CONSTRAINT media_object_leases_verification_status_known
        CHECK (verification_status IN ('pending', 'metadata_confirmed', 'verified', 'rejected'));

ALTER TABLE public.jobs DROP CONSTRAINT IF EXISTS jobs_state_known;
ALTER TABLE public.jobs
    ADD CONSTRAINT jobs_state_known CHECK (state IN (
        'queued', 'running', 'retry_wait', 'uncertain', 'succeeded', 'failed', 'cancelled'
    ));
CREATE INDEX IF NOT EXISTS jobs_uncertain_idx
    ON public.jobs (kind, updated_at)
    WHERE state = 'uncertain';

ALTER TABLE public.execution_quota DROP CONSTRAINT IF EXISTS execution_quota_class_known;
ALTER TABLE public.execution_quota
    ADD CONSTRAINT execution_quota_class_known
        CHECK (class IN ('ai_ocr', 'cloud_upload', 'all_execution', 'verify'));
ALTER TABLE public.execution_permits DROP CONSTRAINT IF EXISTS execution_permits_class_known;
ALTER TABLE public.execution_permits
    ADD CONSTRAINT execution_permits_class_known
        CHECK (class IN ('ai_ocr', 'cloud_upload', 'all_execution', 'verify'));
ALTER TABLE public.execution_permits DROP CONSTRAINT IF EXISTS execution_permits_holder_known;
ALTER TABLE public.execution_permits
    ADD CONSTRAINT execution_permits_holder_known
        CHECK (holder_kind IN ('job', 'ocr', 'upload_unit', 'verify'));

INSERT INTO public.execution_quota (class, org_id, used, hard_limit) VALUES
    ('verify', 0, 0, 4)
ON CONFLICT (class, org_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.execution_quota_team_limit(p_class text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE p_class
        WHEN 'ai_ocr' THEN 2::bigint
        WHEN 'cloud_upload' THEN 2::bigint
        WHEN 'all_execution' THEN 8::bigint
        WHEN 'verify' THEN 2::bigint
        ELSE 0::bigint
    END;
$$;

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
