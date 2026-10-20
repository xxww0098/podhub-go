-- +goose Up
-- declaration 184 MemberSeatLimitOverride m20260917_000322_member_seat_limit_override
-- source: migration/src/member_seat_limit_override.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.organizations
    ADD COLUMN IF NOT EXISTS member_seat_limit_override bigint;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'ck_organizations_member_seat_limit_override'
          AND conrelid = 'public.organizations'::regclass
    ) THEN
        ALTER TABLE public.organizations
            ADD CONSTRAINT ck_organizations_member_seat_limit_override
                CHECK (member_seat_limit_override IS NULL OR member_seat_limit_override >= 1)
                NOT VALID;
    END IF;
END
$$;

WITH latest AS (
    SELECT DISTINCT ON (a.org_id)
           a.org_id,
           a.created_at AS applied_at,
           a.message::jsonb AS detail
      FROM public.audit_logs a
     WHERE a.action = 'account_member_seats_applied'
       AND a.status = 'success'
       AND a.message ~ '^\s*\{'
     ORDER BY a.org_id, a.created_at_ms DESC, a.id DESC
)
UPDATE public.organizations o
   SET member_seat_limit_override = d.override_seats
  FROM (
        SELECT l.org_id,
               CASE
                   WHEN COALESCE((l.detail ->> 'follow_plan_member_seats')::boolean, false)
                       THEN NULL
                   WHEN (l.detail #>> '{member_seats,to}') ~ '^\d+$'
                        AND (l.detail #>> '{member_seats,to}')::bigint >= 1
                        AND (l.detail #>> '{member_seats,to}')::bigint
                            <> GREATEST(COALESCE((
                                   SELECT SUM(s.seats)::bigint
                                     FROM public.member_seat_lots s
                                    WHERE s.org_id = l.org_id
                                      AND s.starts_at <= l.applied_at
                                      AND s.expires_at > l.applied_at), 0), 1)
                       THEN (l.detail #>> '{member_seats,to}')::bigint
                   ELSE NULL
               END AS override_seats
          FROM latest l
       ) d
 WHERE o.id = d.org_id
   AND o.member_seat_limit_override IS DISTINCT FROM d.override_seats;

WITH live AS (
    SELECT org_id, SUM(seats)::bigint AS seats
      FROM public.member_seat_lots
     WHERE starts_at <= clock_timestamp() AND expires_at > clock_timestamp()
     GROUP BY org_id
)
UPDATE public.organizations o
   SET seat_limit = COALESCE(o.member_seat_limit_override,
                             GREATEST(COALESCE(l.seats, 0), 1)),
       quota_revision = quota_revision + 1,
       updated_at = clock_timestamp()
  FROM live l
 WHERE l.org_id = o.id
   AND o.dissolved_at IS NULL
   AND o.seat_limit IS DISTINCT FROM COALESCE(
           o.member_seat_limit_override, GREATEST(l.seats, 1));

UPDATE public.organizations o
   SET seat_limit = COALESCE(o.member_seat_limit_override, 1),
       quota_revision = quota_revision + 1,
       updated_at = clock_timestamp()
 WHERE o.dissolved_at IS NULL
   AND NOT EXISTS (
       SELECT 1 FROM public.member_seat_lots s
        WHERE s.org_id = o.id
          AND s.starts_at <= clock_timestamp()
          AND s.expires_at > clock_timestamp())
   AND o.seat_limit IS DISTINCT FROM COALESCE(o.member_seat_limit_override, 1);

ALTER TABLE public.organizations 
                 VALIDATE CONSTRAINT ck_organizations_member_seat_limit_override;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
