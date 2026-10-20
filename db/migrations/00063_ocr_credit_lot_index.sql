-- +goose Up
-- declaration 63 OcrCreditLotIndex m20260822_000226_ocr_credit_lot_index
-- source: migration/src/ocr_credit_lot_index.rs @ a03d735
-- +goose StatementBegin
DROP INDEX IF EXISTS public.ix_ocr_credit_lots_live;
CREATE INDEX ix_ocr_credit_lots_live
    ON public.ocr_credit_lots (org_id, starts_at, expires_at);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
