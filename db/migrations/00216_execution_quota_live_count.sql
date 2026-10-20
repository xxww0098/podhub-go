-- +goose Up
-- declaration 216 ExecutionQuotaLiveCount m20260923_130000_execution_quota_live_count
-- source: migration/src/execution_quota_live_count.rs @ a03d735
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
    IF EXISTS (
        SELECT 1
        FROM public.execution_quota
        WHERE class = p_class
          AND user_id = 0
          AND NOT (class = 'ai_ocr' AND hard_limit = 0)
    ) THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('eq-live:' || p_class, 0));
    END IF;
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
    inserted bigint;
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
    -- All finite class locks before any User lock, so this cannot invert
    -- against lock_execution_quota (classes, then the User).
    FOR c IN
        SELECT t.x
        FROM unnest(missing) AS t(x)
        WHERE EXISTS (
            SELECT 1 FROM public.execution_quota g
            WHERE g.class = t.x
              AND g.user_id = 0
              AND NOT (g.class = 'ai_ocr' AND g.hard_limit = 0)
        )
        ORDER BY t.x
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended('eq-live:' || c, 0));
    END LOOP;
    FOR c IN
        SELECT t.x FROM unnest(missing) AS t(x) ORDER BY t.x
    LOOP
        PERFORM public.register_execution_demand(c, p_user_id);
    END LOOP;
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
    INSERT INTO public.execution_permits (
        holder_kind, holder_id, lease_epoch, class, org_id, user_id, expires_at
    )
    SELECT p_holder_kind, p_holder_id, p_lease_epoch, x, p_org_id, p_user_id, p_expires_at
    FROM unnest(missing) AS t(x)
    WHERE (
        SELECT COALESCE(bool_and(
            (
                (g.hard_limit = 0 AND g.class = 'ai_ocr')
                OR (
                    SELECT count(*)::bigint
                    FROM public.execution_permits p
                    WHERE p.class = need.class AND p.released_at IS NULL
                ) < g.hard_limit
            )
            AND (
                SELECT count(*)::bigint
                FROM public.execution_permits p
                WHERE p.class = need.class
                  AND p.user_id = p_user_id
                  AND p.released_at IS NULL
            ) < u.hard_limit
        ), false)
        FROM unnest(missing) AS need(class)
        JOIN public.execution_quota g ON g.class = need.class AND g.user_id = 0
        JOIN public.execution_quota u ON u.class = need.class AND u.user_id = p_user_id
    );
    GET DIAGNOSTICS inserted = ROW_COUNT;
    IF inserted IS DISTINCT FROM cardinality(missing) THEN
        RETURN false;
    END IF;
    UPDATE public.execution_quota
       SET used = used + 1
     WHERE class = ANY (missing) AND user_id = p_user_id;
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
    live_class text;
BEGIN
    FOR live_class IN
        SELECT DISTINCT p.class
        FROM public.execution_permits p
        JOIN public.execution_quota g ON g.class = p.class AND g.user_id = 0
        WHERE p.holder_kind = p_holder_kind
          AND p.holder_id = p_holder_id
          AND p.lease_epoch = p_lease_epoch
          AND p.released_at IS NULL
          AND NOT (g.class = 'ai_ocr' AND g.hard_limit = 0)
        ORDER BY p.class
    LOOP
        PERFORM pg_advisory_xact_lock(hashtextextended('eq-live:' || live_class, 0));
    END LOOP;

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
    END LOOP;
    RETURN did;
END
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
END
$$;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
