-- +goose Up
-- Unbound invitations cannot identify a recipient once private proofs are removed.
UPDATE public.org_invitations
SET revoked_at = clock_timestamp(), updated_at = clock_timestamp()
WHERE invitee_user_id IS NULL AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL;

ALTER TABLE public.org_invitations DROP COLUMN token_hash;

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN RAISE EXCEPTION 'invitation proofs cannot be restored'; END $$;
-- +goose StatementEnd
