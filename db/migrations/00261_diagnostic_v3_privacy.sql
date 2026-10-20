-- +goose Up
-- +goose NO TRANSACTION
-- declaration 261 DiagnosticV3Privacy m20261001_000444_diagnostic_v3_privacy
-- source: migration/src/diagnostic_v3_privacy.rs @ a03d735
-- +goose StatementBegin
SELECT 1;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
