-- +goose Up
-- +goose NO TRANSACTION
-- declaration 44 DropTrackEventsUserIdx m20260818_000208_drop_track_events_user_idx
-- source: migration/src/drop_track_events_user_idx.rs @ a03d735
-- +goose StatementBegin
DROP INDEX CONCURRENTLY IF EXISTS "public"."ix_track_events_user";
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
