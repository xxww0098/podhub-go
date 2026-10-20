-- +goose Up
-- declaration 214 AiRequestChargedMicrofen m20260922_190000_ai_request_charged_microfen
-- source: migration/src/ai_request_charged_microfen.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.ai_requests
    ADD COLUMN charged_microfen bigint NOT NULL DEFAULT 0,
    ADD COLUMN absorbed_microfen bigint NOT NULL DEFAULT 0;

UPDATE public.ai_requests r
   SET charged_microfen  = -l.amount_microfen,
       absorbed_microfen = r.total_microfen + l.amount_microfen
  FROM public.wallet_ledger l
 WHERE l.ai_request_id = r.id
   AND l.entry_type = 'settle'
   AND r.status = 'settled'
   AND r.charged_microfen = 0;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.ai_requests r
         WHERE r.status = 'settled'
           AND r.total_microfen > 0
           AND r.charged_microfen = 0
    ) THEN
        RAISE EXCEPTION 'ai_requests backfill refused: settled rows with total_microfen > 0 still have charged_microfen = 0 (orphan or zero-amount wallet_ledger settle); reconcile before retrying';
    END IF;
END
$$;

ALTER TABLE public.ai_requests
    ADD CONSTRAINT ai_requests_charged_split CHECK (
        charged_microfen >= 0 AND absorbed_microfen >= 0
        AND charged_microfen + absorbed_microfen = total_microfen);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
