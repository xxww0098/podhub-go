-- +goose Up
-- +goose NO TRANSACTION
-- declaration 69 TeamOwnerMembership m20260823_000231_team_owner_membership
-- source: migration/src/team_owner_membership.rs @ a03d735
-- +goose StatementBegin
UPDATE public.organization_members AS m
   SET role = 'owner',
       manual_disabled = false,
       quota_suspended = false,
       updated_at = clock_timestamp()
  FROM public.organizations AS o
 WHERE o.id = m.org_id
   AND o.dissolved_at IS NULL
   AND m.user_id = o.owner_user_id
   AND m.role <> 'owner'
   AND NOT EXISTS (
       SELECT 1 FROM public.organization_members AS x
        WHERE x.org_id = o.id AND x.role = 'owner'
   );
-- +goose StatementEnd
-- +goose StatementBegin
INSERT INTO public.organization_members
       (org_id, user_id, role, status, join_order, display_name, created_at, updated_at)
SELECT o.id,
       o.owner_user_id,
       'owner',
       'active',
       COALESCE(
           (SELECT max(m2.join_order) FROM public.organization_members m2 WHERE m2.org_id = o.id),
           0
       ) + 1,
       COALESCE(NULLIF(btrim(p.name), ''), u.email),
       o.created_at,
       clock_timestamp()
  FROM public.organizations AS o
  JOIN public.account_users AS u ON u.id = o.owner_user_id
  LEFT JOIN public.account_profiles AS p ON p.user_id = o.owner_user_id
 WHERE o.dissolved_at IS NULL
   AND NOT EXISTS (
       SELECT 1 FROM public.organization_members m WHERE m.org_id = o.id AND m.role = 'owner'
   )
   AND NOT EXISTS (
       SELECT 1 FROM public.organization_members m
        WHERE m.org_id = o.id AND m.user_id = o.owner_user_id
   )
ON CONFLICT (org_id, user_id) DO NOTHING;
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE public.organization_members AS m
   SET role = 'manager',
       updated_at = clock_timestamp()
  FROM (
    SELECT inner_m.id,
           row_number() OVER (
               PARTITION BY inner_m.org_id
               ORDER BY (inner_m.user_id = o.owner_user_id) DESC,
                        inner_m.join_order ASC,
                        inner_m.id ASC
           ) AS rn
      FROM public.organization_members AS inner_m
      JOIN public.organizations AS o ON o.id = inner_m.org_id
     WHERE inner_m.role = 'owner'
  ) AS ranked
 WHERE m.id = ranked.id
   AND ranked.rn > 1;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "uq_org_members_one_owner" ON "public"."organization_members" ("org_id") WHERE role = 'owner';
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_org_members_owner_user" ON "public"."organization_members" ("user_id") WHERE role = 'owner';
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
