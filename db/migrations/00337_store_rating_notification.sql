-- +goose Up
-- declaration 337 StoreRatingNotification
-- Post-Rust append. Adds one notifications.kind so a worsened rating can
-- reuse the existing in-app bell. The previous five kinds stay in the
-- check, in the same order. No column is added.
-- +goose StatementBegin
ALTER TABLE public.notifications
    DROP CONSTRAINT IF EXISTS ck_notifications_kind,
    ADD CONSTRAINT ck_notifications_kind
        CHECK ((kind)::text = ANY (ARRAY[
            'team_invitation'::text,
            'agent_commission_credited'::text,
            'agent_withdrawal_paid'::text,
            'agent_withdrawal_rejected'::text,
            'delegate_order_event'::text,
            'store_rating_worsened'::text
        ]));
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
