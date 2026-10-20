-- +goose Up
-- declaration 114 ExecutionQuota m20260905_000275_execution_quota
-- source: migration/src/execution_quota.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE IF NOT EXISTS public.execution_quota (
    class text NOT NULL,
    org_id bigint NOT NULL,
    used bigint NOT NULL DEFAULT 0,
    hard_limit bigint NOT NULL,
    CONSTRAINT execution_quota_pkey PRIMARY KEY (class, org_id),
    CONSTRAINT execution_quota_used_nonneg CHECK (used >= 0),
    CONSTRAINT execution_quota_limit_pos CHECK (hard_limit >= 0),
    CONSTRAINT execution_quota_class_known
        CHECK (class IN ('ai_ocr', 'cloud_upload', 'all_execution'))
);

CREATE TABLE IF NOT EXISTS public.execution_permits (
    holder_kind text NOT NULL,
    holder_id text NOT NULL,
    lease_epoch bigint NOT NULL,
    class text NOT NULL,
    org_id bigint NOT NULL,
    released_at timestamptz,
    expires_at timestamptz,
    CONSTRAINT execution_permits_pkey
        PRIMARY KEY (holder_kind, holder_id, lease_epoch, class),
    CONSTRAINT execution_permits_holder_known
        CHECK (holder_kind IN ('job', 'ocr')),
    CONSTRAINT execution_permits_class_known
        CHECK (class IN ('ai_ocr', 'cloud_upload', 'all_execution'))
);

CREATE INDEX IF NOT EXISTS execution_permits_live_idx
    ON public.execution_permits (class, org_id)
    WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS execution_permits_expiry_idx
    ON public.execution_permits (expires_at)
    WHERE released_at IS NULL AND expires_at IS NOT NULL;

INSERT INTO public.execution_quota (class, org_id, used, hard_limit) VALUES
    ('ai_ocr', 0, 0, 20),
    ('cloud_upload', 0, 0, 6),
    ('all_execution', 0, 0, 48)
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
        ELSE 0::bigint
    END;
$$;

CREATE OR REPLACE FUNCTION public.try_grant_execution_permit(
    p_classes text[],
    p_org_id bigint,
    p_holder_kind text,
    p_holder_id text,
    p_lease_epoch bigint,
    p_expires_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_org_id <= 0 OR p_holder_id = '' OR p_classes IS NULL OR array_length(p_classes, 1) IS NULL THEN
        RETURN false;
    END IF;
    IF p_holder_kind = 'job' AND NOT EXISTS (
        SELECT 1 FROM public.jobs WHERE id::text = p_holder_id AND org_id = p_org_id
    ) THEN
        RETURN false;
    END IF;

    INSERT INTO public.execution_quota (class, org_id, used, hard_limit)
    SELECT class_name, p_org_id, 0, public.execution_quota_team_limit(class_name)
    FROM unnest(p_classes) AS class_name
    ON CONFLICT (class, org_id) DO NOTHING;

    PERFORM 1
    FROM public.execution_quota
    WHERE class = ANY(p_classes)
      AND org_id IN (0, p_org_id)
    ORDER BY class, org_id
    FOR UPDATE;

    IF NOT EXISTS (
        SELECT 1
        FROM unnest(p_classes) AS class_name
        WHERE NOT EXISTS (
            SELECT 1
            FROM public.execution_permits
            WHERE holder_kind = p_holder_kind
              AND holder_id = p_holder_id
              AND lease_epoch = p_lease_epoch
              AND class = class_name
              AND released_at IS NULL
        )
    ) THEN
        RETURN true;
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.execution_quota
        WHERE class = ANY(p_classes)
          AND org_id IN (0, p_org_id)
          AND used >= hard_limit
    ) THEN
        RETURN false;
    END IF;

    UPDATE public.execution_quota
       SET used = used + 1
     WHERE class = ANY(p_classes)
       AND org_id IN (0, p_org_id)
       AND used < hard_limit;

    INSERT INTO public.execution_permits (
        holder_kind, holder_id, lease_epoch, class, org_id, expires_at
    )
    SELECT p_holder_kind, p_holder_id, p_lease_epoch, class_name, p_org_id, p_expires_at
    FROM unnest(p_classes) AS class_name
    ON CONFLICT (holder_kind, holder_id, lease_epoch, class) DO NOTHING;

    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_execution_permit(
    p_holder_kind text,
    p_holder_id text,
    p_lease_epoch bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    released_row record;
    did boolean := false;
BEGIN
    PERFORM 1
    FROM public.execution_quota q
    WHERE EXISTS (
        SELECT 1
        FROM public.execution_permits p
        WHERE p.holder_kind = p_holder_kind
          AND p.holder_id = p_holder_id
          AND p.lease_epoch = p_lease_epoch
          AND p.released_at IS NULL
          AND q.class = p.class
          AND q.org_id IN (0, p.org_id)
    )
    ORDER BY q.class, q.org_id
    FOR UPDATE;

    FOR released_row IN
        UPDATE public.execution_permits
           SET released_at = clock_timestamp()
         WHERE holder_kind = p_holder_kind
           AND holder_id = p_holder_id
           AND lease_epoch = p_lease_epoch
           AND released_at IS NULL
     RETURNING class, org_id
    LOOP
        did := true;
        UPDATE public.execution_quota
           SET used = used - 1
         WHERE class = released_row.class
           AND org_id = released_row.org_id
           AND used > 0;
        UPDATE public.execution_quota
           SET used = used - 1
         WHERE class = released_row.class
           AND org_id = 0
           AND used > 0;
    END LOOP;
    RETURN did;
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
                              AND j.state = 'running'
                        ))
                        OR (p.holder_kind = 'ocr'
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

ALTER TABLE public.execution_permits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.execution_permits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON public.execution_permits;
CREATE POLICY tenant_isolation ON public.execution_permits
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.execution_quota TO podhub_app, podhub_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.execution_permits TO podhub_app, podhub_worker;
GRANT EXECUTE ON FUNCTION public.execution_quota_team_limit(text) TO podhub_app, podhub_worker;
GRANT EXECUTE ON FUNCTION public.try_grant_execution_permit(text[], bigint, text, text, bigint, timestamptz) TO podhub_app, podhub_worker;
GRANT EXECUTE ON FUNCTION public.release_execution_permit(text, text, bigint) TO podhub_app, podhub_worker;
GRANT EXECUTE ON FUNCTION public.reap_stale_execution_permits(bigint) TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
