-- +goose Up
-- declaration 244 RetireImagePipelineFamily m20260930_000427_retire_image_pipeline_family
-- source: migration/src/retire_image_pipeline_family.rs @ a03d735
-- +goose StatementBegin
DROP TABLE public.image_ref_edges, public.image_objects;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
