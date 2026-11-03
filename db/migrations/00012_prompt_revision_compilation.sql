-- +goose Up
ALTER TABLE public.prompt_revisions
 ADD COLUMN compiled_text text NOT NULL DEFAULT '',
 ADD COLUMN compiled_sha256 text NOT NULL DEFAULT '' CHECK (compiled_sha256='' OR compiled_sha256 ~ '^[0-9a-f]{64}$');

-- +goose Down
ALTER TABLE public.prompt_revisions DROP COLUMN compiled_text,DROP COLUMN compiled_sha256;
