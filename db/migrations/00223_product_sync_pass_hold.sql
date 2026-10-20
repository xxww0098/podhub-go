-- +goose Up
-- declaration 223 StoreProductSyncPassHold m20260924_000405_product_sync_pass_hold
-- source: migration/src/store_product_sync_pass_hold.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.store_product_sync
    ADD COLUMN pass text NOT NULL DEFAULT 'none',
    ADD COLUMN hold text NOT NULL DEFAULT 'none',
    ADD COLUMN hold_until_ms bigint,
    ADD COLUMN hold_reason text,
    ADD COLUMN calls_day date,
    ADD COLUMN calls_reconcile integer NOT NULL DEFAULT 0,
    ADD COLUMN calls_refresh integer NOT NULL DEFAULT 0,
    ADD COLUMN calls_manual integer NOT NULL DEFAULT 0,
    ADD COLUMN generation_started_at_ms bigint,
    ADD CONSTRAINT store_product_sync_pass CHECK (
        pass IN ('none','list_live','list_archived','detail','commit')
    ),
    ADD CONSTRAINT store_product_sync_hold CHECK (
        hold IN ('none','yield','backoff','budget','cooldown','credential','disabled')
    ),
    -- A row holds or it does not; the reason is a stable code when known.
    ADD CONSTRAINT store_product_sync_hold_shape CHECK (
        (hold = 'none') = (hold_until_ms IS NULL)
    ),
    ADD CONSTRAINT store_product_sync_hold_reason CHECK (
        hold_reason IS NULL OR hold_reason IN (
            'rate_limited','generation_expired','credential_revoked',
            'credential_expired','ip_restricted','workspace_breaker',
            'deployment_breaker','egress_blocked','store_busy','seller_error',
            'budget_exhausted','store_disabled'
        )
    ),
    ADD CONSTRAINT store_product_sync_calls_purpose_shape CHECK (
        (calls_day IS NULL) = (calls_reconcile = 0 AND calls_refresh = 0 AND calls_manual = 0)
    ),
    ADD CONSTRAINT store_product_sync_calls_nonneg CHECK (
        calls_reconcile >= 0 AND calls_refresh >= 0 AND calls_manual >= 0
    ),
    ADD CONSTRAINT store_product_sync_generation_start CHECK (
        generation_started_at_ms IS NULL OR generation_started_at_ms > 0
    );

UPDATE public.store_product_sync SET
    -- The cursor's layer prefix decides the pass for every phase — a paused
    -- row keeps its progress. Only prefixless in-pass rows fall back to the
    -- phase; 'p:' cursors (pricing) resume at the commit unit.
    pass = CASE
        WHEN cursor_last_id LIKE 'a:%' THEN 'list_archived'
        WHEN cursor_last_id LIKE 'd:%' THEN 'detail'
        WHEN cursor_last_id LIKE 'f:%' THEN 'commit'
        WHEN cursor_last_id LIKE 'l:%' THEN 'list_live'
        WHEN phase = 'pricing' THEN 'commit'
        WHEN phase = 'listing' THEN 'list_live'
        WHEN phase = 'detailing' THEN 'detail'
        ELSE 'none'
    END,
    hold = CASE
        WHEN phase = 'failed' THEN 'backoff'
        WHEN phase = 'budget_exhausted' THEN 'budget'
        WHEN phase = 'cooldown' THEN 'cooldown'
        ELSE 'none'
    END,
    -- COALESCE: the old shape admitted illegal combinations (C7 — a
    -- 'failed' row with no retry stamp). An expired window (0) reads as
    -- "held in name only, resume now".
    hold_until_ms = CASE
        WHEN phase = 'failed' THEN COALESCE(retry_at_ms, next_due_at_ms, 0)
        WHEN phase = 'budget_exhausted' THEN COALESCE(next_due_at_ms, 0)
        WHEN phase = 'cooldown' THEN COALESCE(cooldown_until_ms, next_due_at_ms, 0)
        ELSE NULL
    END,
    hold_reason = CASE
        WHEN phase = 'failed' THEN 'seller_error'
        WHEN phase = 'budget_exhausted' THEN NULL
        WHEN phase = 'cooldown' THEN 'rate_limited'
        ELSE NULL
    END,
    calls_day = calls_day_key::date,
    calls_reconcile = calls_today,
    cursor_last_id = CASE
        WHEN cursor_last_id LIKE '_:%'
             THEN NULLIF(substring(cursor_last_id from 3), '')
        ELSE NULL
    END;

ALTER TABLE public.store_product_sync
    DROP CONSTRAINT store_product_sync_phase,
    DROP COLUMN phase,
    DROP COLUMN cooldown_until_ms,
    DROP COLUMN retry_at_ms,
    DROP COLUMN last_error,
    DROP COLUMN calls_day_key,
    DROP COLUMN calls_today,
    DROP COLUMN seen_total,
    DROP COLUMN fetched_total;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
