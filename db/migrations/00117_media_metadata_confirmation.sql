-- +goose Up
-- declaration 117 MediaMetadataConfirmation m20260916_000301_media_metadata_confirmation
-- source: migration/src/media_metadata_confirmation.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.media_object_leases
    DROP CONSTRAINT IF EXISTS media_object_leases_verification_status_known;
ALTER TABLE public.media_object_leases
    ADD CONSTRAINT media_object_leases_verification_status_known
        CHECK (verification_status IN ('pending', 'metadata_confirmed', 'verified', 'rejected'));
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
