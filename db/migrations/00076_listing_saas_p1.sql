-- +goose Up
-- declaration 76 ListingSaasP1 m20260825_000238_listing_saas_p1
-- source: migration/src/listing_saas_p1.rs @ a03d735
-- +goose StatementBegin
CREATE TABLE public.listing_cards (
    id                  uuid PRIMARY KEY,
    org_id              bigint NOT NULL REFERENCES public.organizations(id),
    title               text NOT NULL DEFAULT '',
    store_id            uuid,
    revision            bigint NOT NULL DEFAULT 1,
    payload             jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_by          bigint,
    updated_by          bigint,
    created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT listing_cards_revision_pos CHECK (revision >= 1)
);

CREATE INDEX listing_cards_org_updated_idx
    ON public.listing_cards (org_id, updated_at DESC);

ALTER TABLE public.submission_intents
    ADD COLUMN cancel_requested_at timestamptz;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
