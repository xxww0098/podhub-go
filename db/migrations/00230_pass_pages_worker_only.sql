-- +goose Up
-- declaration 230 PassPagesWorkerOnly m20260927_000412_pass_pages_worker_only
-- source: migration/src/pass_pages_worker_only.rs @ a03d735
-- +goose StatementBegin
REVOKE ALL ON TABLE public.store_product_pass_pages FROM podhub_app;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
