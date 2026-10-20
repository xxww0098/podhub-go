-- +goose Up
-- declaration 118 CardPackageSnapshot m20260906_000278_card_package_snapshot
-- source: migration/src/card_package_snapshot.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.card_packages
    ADD COLUMN IF NOT EXISTS snapshot_revision bigint NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS public.card_package_picks (
    org_id bigint NOT NULL REFERENCES public.organizations(id),
    idempotency_key text NOT NULL,
    package_id uuid NOT NULL,
    previewed_revision bigint NOT NULL,
    card_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT card_package_picks_pkey PRIMARY KEY (org_id, idempotency_key),
    CONSTRAINT card_package_picks_key_len CHECK (
        char_length(idempotency_key) BETWEEN 1 AND 128
    )
);

ALTER TABLE public.card_package_picks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.card_package_picks FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.card_package_picks
    FOR ALL
    TO podhub_app
    USING (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    )
    WITH CHECK (
        org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
    );

GRANT SELECT, INSERT ON TABLE public.card_package_picks
    TO podhub_app;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
