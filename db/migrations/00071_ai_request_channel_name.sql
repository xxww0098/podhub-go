-- +goose Up
-- declaration 71 AiRequestChannelName m20260823_000233_ai_request_channel_name
-- source: migration/src/ai_request_channel_name.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.ai_requests
    ADD COLUMN IF NOT EXISTS channel_name character varying(80);

ALTER TABLE public.ai_requests
    DROP CONSTRAINT IF EXISTS ai_requests_channel_name_valid;

ALTER TABLE public.ai_requests
    ADD CONSTRAINT ai_requests_channel_name_valid
    CHECK (
        channel_name IS NULL
        OR (char_length(channel_name) BETWEEN 1 AND 80 AND channel_name = btrim(channel_name))
    ) NOT VALID;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
