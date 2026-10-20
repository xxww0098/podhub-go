-- +goose Up
-- declaration 206 DelegateSync m20260922_130000_delegate_sync
-- source: migration/src/delegate_sync.rs @ a03d735
-- +goose StatementBegin
-- §E.26：委托单事件进卖家铃铛。既有 kind 全量重列（改 CHECK 即重写约束）。
ALTER TABLE public.notifications
    DROP CONSTRAINT IF EXISTS ck_notifications_kind,
    ADD CONSTRAINT ck_notifications_kind
        CHECK ((kind)::text = ANY (ARRAY['team_invitation'::text,
                                         'agent_commission_credited'::text,
                                         'agent_withdrawal_paid'::text,
                                         'agent_withdrawal_rejected'::text,
                                         'delegate_order_event'::text]));
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
