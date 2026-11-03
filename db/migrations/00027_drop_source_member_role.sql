-- +goose Up
-- +goose StatementBegin
-- A source member is a factory member. The membership row itself is the role;
-- the constant role column and its CHECK add a second, fake role axis.
ALTER TABLE public.sc_source_members
    DROP CONSTRAINT IF EXISTS ck_sc_source_members_role;
ALTER TABLE public.sc_source_members
    DROP COLUMN role;
-- +goose StatementEnd

-- +goose Down
-- +goose StatementBegin
ALTER TABLE public.sc_source_members
    ADD COLUMN role text DEFAULT 'member'::text NOT NULL;
ALTER TABLE public.sc_source_members
    ADD CONSTRAINT ck_sc_source_members_role CHECK (role = 'member'::text);
-- +goose StatementEnd
