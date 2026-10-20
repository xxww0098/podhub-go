-- +goose Up
-- declaration 188 ExecutionQuotaUserRowLocks m20260919_000326_execution_quota_user_row_locks
-- source: migration/src/execution_quota_user_row_locks.rs @ a03d735
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.register_execution_demand(p_class text, p_user_id bigint)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF p_user_id <= 0 THEN
        RAISE EXCEPTION 'execution requires a positive User';
    END IF;
    PERFORM 1
    FROM public.execution_quota
    WHERE class = p_class
      AND user_id = 0
      AND NOT (class = 'ai_ocr' AND hard_limit = 0)
    FOR UPDATE;
    PERFORM pg_advisory_xact_lock(hashtextextended('eq-user:' || p_class || ':' || p_user_id::text, 0));
    INSERT INTO public.execution_quota(class, user_id, hard_limit)
    VALUES (p_class, p_user_id, public.execution_quota_user_limit(p_class))
    ON CONFLICT DO NOTHING;
    INSERT INTO public.execution_fairness(class, user_id, request_until)
    VALUES (p_class, p_user_id, clock_timestamp() + interval '30 seconds')
    ON CONFLICT (class, user_id) DO UPDATE SET request_until = excluded.request_until;
END
$$;

CREATE OR REPLACE FUNCTION public.try_grant_execution_permit(
    p_classes text[],
    p_org_id bigint,
    p_user_id bigint,
    p_holder_kind text,
    p_holder_id text,
    p_lease_epoch bigint,
    p_expires_at timestamptz
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    c text;
    missing text[];
    next_user bigint;
BEGIN
    IF p_org_id <= 0 OR p_user_id <= 0 OR p_holder_id = ''
       OR cardinality(p_classes) IS NULL OR cardinality(p_classes) = 0 THEN
        RETURN false;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM public.organization_members
        WHERE org_id = p_org_id AND user_id = p_user_id AND status = 'active'
    ) THEN
        RETURN false;
    END IF;
    PERFORM 1
    FROM public.execution_quota
    WHERE class = ANY (p_classes)
      AND user_id = 0
      AND NOT (class = 'ai_ocr' AND hard_limit = 0)
    ORDER BY class
    FOR UPDATE;
    IF EXISTS (
        SELECT 1 FROM public.execution_permits
        WHERE holder_kind = p_holder_kind
          AND holder_id = p_holder_id
          AND lease_epoch = p_lease_epoch
          AND class = ANY (p_classes)
          AND (released_at IS NOT NULL OR org_id <> p_org_id OR user_id IS DISTINCT FROM p_user_id)
    ) THEN
        RETURN false;
    END IF;
    SELECT array_agg(DISTINCT x) INTO missing
    FROM unnest(p_classes) x
    WHERE NOT EXISTS (
        SELECT 1 FROM public.execution_permits p
        WHERE p.holder_kind = p_holder_kind
          AND p.holder_id = p_holder_id
          AND p.lease_epoch = p_lease_epoch
          AND p.class = x
    );
    IF missing IS NULL THEN
        RETURN true;
    END IF;
    FOREACH c IN ARRAY missing LOOP
        PERFORM public.register_execution_demand(c, p_user_id);
    END LOOP;
    PERFORM 1
    FROM public.execution_quota
    WHERE class = ANY (missing) AND user_id = p_user_id
    ORDER BY class
    FOR UPDATE;
    IF EXISTS (
        SELECT 1 FROM public.execution_quota q
        WHERE q.class = ANY (missing)
          AND (
              (q.user_id = 0 AND NOT (q.class = 'ai_ocr' AND q.hard_limit = 0))
              OR q.user_id = p_user_id
          )
          AND q.used >= q.hard_limit
    ) THEN
        RETURN false;
    END IF;
    FOREACH c IN ARRAY missing LOOP
        SELECT f.user_id INTO next_user
        FROM public.execution_fairness f
        JOIN public.execution_quota q ON q.class = f.class AND q.user_id = f.user_id
        JOIN public.execution_fairness_cursor cur ON cur.class = f.class
        WHERE f.class = c
          AND f.request_until > clock_timestamp()
          AND q.used < q.hard_limit
        ORDER BY (f.user_id > cur.last_user_id) DESC, f.user_id
        LIMIT 1;
        IF next_user IS DISTINCT FROM p_user_id THEN
            RETURN false;
        END IF;
    END LOOP;
    UPDATE public.execution_quota
       SET used = used + 1
     WHERE class = ANY (missing) AND user_id IN (0, p_user_id)
       AND NOT (user_id = 0 AND class = 'ai_ocr' AND hard_limit = 0);
    INSERT INTO public.execution_permits (
        holder_kind, holder_id, lease_epoch, class, org_id, user_id, expires_at
    )
    SELECT p_holder_kind, p_holder_id, p_lease_epoch, x, p_org_id, p_user_id, p_expires_at
    FROM unnest(missing) x;
    UPDATE public.execution_fairness_cursor
       SET last_user_id = p_user_id
     WHERE class = ANY (missing);
    DELETE FROM public.execution_fairness
     WHERE class = ANY (missing) AND user_id = p_user_id;
    RETURN true;
END
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
          AND q.user_id IN (0, p.user_id)
    )
      AND NOT (q.class = 'ai_ocr' AND q.user_id = 0 AND q.hard_limit = 0)
    ORDER BY CASE WHEN q.user_id = 0 THEN 0 ELSE 1 END, q.class, q.user_id
    FOR UPDATE;

    IF p_holder_kind = 'job' THEN
      IF EXISTS (
        SELECT 1 FROM public.execution_permits owned
        WHERE owned.holder_kind = 'job'
          AND owned.holder_id = p_holder_id
          AND owned.lease_epoch = p_lease_epoch
          AND owned.released_at IS NULL
          AND (
              EXISTS (
                  SELECT 1 FROM public.ai_requests a
                  WHERE a.org_id = owned.org_id
                    AND a.job_id = p_holder_id::uuid
                    AND a.operation = 'ocr'
                    AND a.status IN ('held', 'dispatching')
              )
              OR EXISTS (
                  SELECT 1 FROM public.execution_permits unit
                  WHERE unit.holder_kind = 'upload_unit'
                    AND unit.org_id = owned.org_id
                    AND unit.holder_id LIKE ('job:' || p_holder_id || ':' || p_lease_epoch::text || ':%')
                    AND unit.released_at IS NULL
              )
          )
      ) THEN
        RETURN false;
      END IF;
    END IF;

    FOR released_row IN
        UPDATE public.execution_permits
           SET released_at = clock_timestamp()
         WHERE holder_kind = p_holder_kind
           AND holder_id = p_holder_id
           AND lease_epoch = p_lease_epoch
           AND released_at IS NULL
     RETURNING class, user_id
    LOOP
        did := true;
        UPDATE public.execution_quota
           SET used = used - 1
         WHERE class = released_row.class
           AND user_id = released_row.user_id
           AND used > 0;
        UPDATE public.execution_quota
           SET used = used - 1
         WHERE class = released_row.class
           AND user_id = 0
           AND used > 0
           AND NOT (released_row.class = 'ai_ocr' AND hard_limit = 0);
    END LOOP;
    RETURN did;
END
$$;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
