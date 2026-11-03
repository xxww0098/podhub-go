-- +goose Up
-- Email ownership verification is no longer part of account access.
DELETE FROM public.auth_email_tokens WHERE purpose = 'verify';
ALTER TABLE public.auth_email_tokens DROP CONSTRAINT ck_auth_email_tokens_purpose;
ALTER TABLE public.auth_email_tokens ADD CONSTRAINT ck_auth_email_tokens_purpose CHECK (purpose = 'reset');
ALTER TABLE public.account_users DROP COLUMN email_verified_at;

-- +goose Down
ALTER TABLE public.account_users ADD COLUMN email_verified_at timestamp with time zone;
ALTER TABLE public.auth_email_tokens DROP CONSTRAINT ck_auth_email_tokens_purpose;
ALTER TABLE public.auth_email_tokens ADD CONSTRAINT ck_auth_email_tokens_purpose CHECK (purpose IN ('reset', 'verify'));
