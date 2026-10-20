-- +goose Up
-- declaration 292 PodhubAppAIBillingGrants
-- AI and billing tables the app role could not write. Historical migrations
-- are unchanged. ai_requests was SELECT-only in 00167; this grant is the
-- explicit later request. No new RLS policy is added.
-- +goose StatementBegin
GRANT SELECT, INSERT, UPDATE ON TABLE
    public.ai_requests,
    public.payment_orders,
    public.redeem_codes,
    public.member_seat_lots
    TO podhub_app, podhub_worker;

GRANT USAGE, SELECT ON SEQUENCE
    public.ai_requests_id_seq,
    public.payment_orders_id_seq,
    public.redeem_codes_id_seq,
    public.member_seat_lots_id_seq
    TO podhub_app, podhub_worker;
-- +goose StatementEnd

-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
