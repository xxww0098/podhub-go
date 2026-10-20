-- +goose Up
-- declaration 307 AiRequestTokenSubset
-- Post-Rust append. The copied text formula clamps the uncached base at
-- zero when cache exceeds prompt, and bills every completion token when
-- reasoning exceeds completion. ai_requests keeps the provider counts, so
-- the subset check would reject a billable row. Non-negative token checks
-- stay. 00001-00293 are not edited.
-- +goose StatementBegin
ALTER TABLE public.ai_requests DROP CONSTRAINT ai_requests_token_details_within_totals;
-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback. This append follows that shape.
SELECT 1;
