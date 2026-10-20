-- +goose Up
-- declaration 58 RedeemStoreSlots m20260821_000221_redeem_store_slots
-- source: migration/src/redeem_store_slots.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.redeem_codes
    ADD COLUMN IF NOT EXISTS store_slots integer;

UPDATE public.redeem_codes r
SET store_slots = greatest(p.max_stores, 1)
FROM public.plans p
WHERE p.key = r.plan
  AND r.store_slots IS NULL;

UPDATE public.redeem_codes
SET store_slots = 3
WHERE store_slots IS NULL;

ALTER TABLE public.redeem_codes
    ALTER COLUMN store_slots SET NOT NULL;

ALTER TABLE public.redeem_codes
    DROP CONSTRAINT IF EXISTS redeem_codes_store_slots_check;

ALTER TABLE public.redeem_codes
    ADD CONSTRAINT redeem_codes_store_slots_check CHECK (store_slots >= 1);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
