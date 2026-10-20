-- +goose Up
-- declaration 306 AiRequestFormulaTotal
-- Post-Rust append. Token rows still require the four lanes to sum to
-- total_microfen. Per-request rows may store the copied QuotaFromFloatStrict
-- result, which truncates some integers down by 1 (249 -> 248). Failed rows
-- keep total_microfen = 0. charged + absorbed = total is unchanged.
-- +goose StatementBegin
ALTER TABLE public.ai_requests DROP CONSTRAINT ai_requests_total_is_sum;
ALTER TABLE public.ai_requests ADD CONSTRAINT ai_requests_total_is_sum CHECK (
    (billing_mode = 'token'
        AND total_microfen = uncached_input_microfen + cached_input_microfen
                           + output_microfen + reasoning_microfen)
    OR (billing_mode = 'per_request'
        AND uncached_input_microfen = 0 AND cached_input_microfen = 0
        AND output_microfen = 0 AND reasoning_microfen = 0
        AND (
            total_microfen = 0
            OR (per_request_microfen - total_microfen BETWEEN 0 AND 1)
        ))
);
-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback. This append follows that shape.
SELECT 1;
