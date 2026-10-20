-- +goose Up
-- +goose NO TRANSACTION
-- declaration 55 RestoreSingleSuperAdmin m20260820_000218_restore_single_super_admin
-- source: migration/src/restore_single_super_admin.rs @ a03d735
-- +goose StatementBegin
UPDATE public.account_users AS surplus
SET role = 'admin',
    updated_at = clock_timestamp()
WHERE surplus.role = 'super_admin'
  AND surplus.id <> (
      SELECT COALESCE(
          (SELECT MIN(keep.id)
             FROM public.account_users AS keep
            WHERE keep.role = 'super_admin'
              AND keep.disabled_at IS NULL),
          (SELECT MIN(keep.id)
             FROM public.account_users AS keep
            WHERE keep.role = 'super_admin')
      )
  );
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "account_users_single_super_admin" ON "public"."account_users" ("role") WHERE ((role)::text = 'super_admin'::text);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
