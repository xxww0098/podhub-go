-- +goose Up
-- +goose NO TRANSACTION
-- declaration 32 InvitationInbox m20260813_000060_invitation_inbox
-- source: migration/src/invitation_inbox.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.org_invitations
    ADD COLUMN IF NOT EXISTS uuid uuid,
    ADD COLUMN IF NOT EXISTS invitee_user_id bigint,
    ADD COLUMN IF NOT EXISTS declined_at timestamp with time zone;
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE public.org_invitations
SET uuid = gen_random_uuid()
WHERE uuid IS NULL;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE public.org_invitations
    ALTER COLUMN uuid SET DEFAULT gen_random_uuid(),
    ALTER COLUMN uuid SET NOT NULL;
-- +goose StatementEnd
-- +goose StatementBegin
ALTER TABLE public.org_invitations
    ALTER COLUMN token_hash DROP NOT NULL;
-- +goose StatementEnd
-- +goose StatementBegin
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'org_invitations_uuid_key'
          AND conrelid = 'public.org_invitations'::regclass
    ) THEN
        ALTER TABLE public.org_invitations
            ADD CONSTRAINT org_invitations_uuid_key UNIQUE (uuid);
    END IF;
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'org_invitations_invitee_user_id_fkey'
          AND conrelid = 'public.org_invitations'::regclass
    ) THEN
        ALTER TABLE public.org_invitations
            ADD CONSTRAINT org_invitations_invitee_user_id_fkey
            FOREIGN KEY (invitee_user_id)
            REFERENCES public.account_users(id) ON DELETE CASCADE;
    END IF;
END
$$;
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE public.org_invitations AS i
SET invitee_user_id = u.id
FROM public.account_users AS u
WHERE i.invitee_user_id IS NULL
  AND lower(u.email) = lower(i.email)
  AND i.accepted_at IS NULL
  AND i.revoked_at IS NULL
  AND i.declined_at IS NULL;
-- +goose StatementEnd
-- +goose StatementBegin
UPDATE public.org_invitations AS i
SET revoked_at = clock_timestamp(),
    updated_at = clock_timestamp()
FROM (
    SELECT id,
           row_number() OVER (
               PARTITION BY org_id, email
               ORDER BY created_at DESC, id DESC
           ) AS rn
    FROM public.org_invitations
    WHERE accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL
) AS ranked
WHERE i.id = ranked.id
  AND ranked.rn > 1;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE UNIQUE INDEX CONCURRENTLY "org_invitations_pending_uidx" ON "public"."org_invitations" ("org_id", "email") WHERE accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "org_invitations_pending_email_idx" ON "public"."org_invitations" ("email") WHERE accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "org_invitations_pending_invitee_idx" ON "public"."org_invitations" ("invitee_user_id") WHERE accepted_at IS NULL AND revoked_at IS NULL AND declined_at IS NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
