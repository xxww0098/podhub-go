-- +goose Up
-- declaration 142 AgentCommissionNotification m20260911_000290_agent_commission_notification
-- source: migration/src/agent_commission_notification.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.notifications
    DROP CONSTRAINT IF EXISTS ck_notifications_kind,
    ADD CONSTRAINT ck_notifications_kind
        CHECK ((kind)::text = ANY (ARRAY['team_invitation'::text,
                                         'agent_commission_credited'::text]));
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
