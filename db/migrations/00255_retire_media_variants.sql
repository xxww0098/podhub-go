-- +goose Up
-- declaration 255 RetireMediaVariants m20260930_000438_retire_media_variants
-- source: migration/src/retire_media_variants.rs @ a03d735
-- +goose StatementBegin
DO $$
DECLARE
    remaining bigint;
BEGIN
    SELECT count(*) INTO remaining FROM public.media_variants;
    IF remaining > 0 THEN
        RAISE EXCEPTION 'media_variants has % row(s); refusing to drop a non-empty table', remaining
            USING ERRCODE = '55000';
    END IF;
END
$$;

DROP TABLE public.media_variants;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
