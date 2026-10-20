-- +goose Up
-- declaration 141 AgentAttributionReview m20260911_000288_agent_attribution_review
-- source: migration/src/agent_attribution_review.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.account_users
    ADD COLUMN agent_attribution_source varchar(16),
    ADD CONSTRAINT account_users_agent_attribution_source_known
        CHECK (agent_attribution_source IS NULL
            OR agent_attribution_source IN ('register', 'claim'));

UPDATE public.account_users
   SET agent_attribution_source = 'register'
 WHERE invited_by_agent_user_id IS NOT NULL;

ALTER TABLE public.agents
    ADD COLUMN review_flagged_at timestamp with time zone;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
