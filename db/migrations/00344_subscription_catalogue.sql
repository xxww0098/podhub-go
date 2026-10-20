-- +goose Up
-- +goose StatementBegin
-- The four-tier catalogue. Add-on prices are global, so they live in a
-- one-row settings table instead of being repeated on every plan row.
CREATE TABLE public.billing_settings (
    id                  boolean PRIMARY KEY DEFAULT true CHECK (id),
    store_monthly_cents  bigint NOT NULL CHECK (store_monthly_cents > 0),
    member_monthly_cents bigint NOT NULL CHECK (member_monthly_cents > 0),
    updated_at          timestamptz NOT NULL
);
INSERT INTO public.billing_settings
    (id, store_monthly_cents, member_monthly_cents, updated_at)
VALUES (true, 2000, 3000, clock_timestamp());

-- Paid workspaces on ultra move to max before the row disappears. Capacity
-- is projected from the catalogue afterwards, so the store count follows.
UPDATE public.organizations
   SET plan = 'max', updated_at = clock_timestamp()
 WHERE plan = 'ultra';
UPDATE public.payment_orders
   SET plan = 'max', updated_at = clock_timestamp()
 WHERE plan = 'ultra';

UPDATE public.plans
   SET seat_limit          = CASE key WHEN 'free' THEN 1 WHEN 'lite' THEN 1 WHEN 'pro' THEN 6 WHEN 'max' THEN 11 END,
       max_stores          = CASE key WHEN 'free' THEN 1 WHEN 'lite' THEN 5 WHEN 'pro' THEN 30 WHEN 'max' THEN 50 END,
       price_monthly_cents = CASE key WHEN 'free' THEN 0 WHEN 'lite' THEN 10000 WHEN 'pro' THEN 60000 WHEN 'max' THEN 100000 END,
       price_yearly_cents  = 0,
       tagline             = CASE key
                                 WHEN 'free' THEN '1 店 1 人，永久免费'
                                 WHEN 'lite' THEN '5 店 1 人起'
                                 WHEN 'pro'  THEN '30 店 6 人起'
                                 WHEN 'max'  THEN '50 店 11 人起'
                             END,
       sort_order          = CASE key WHEN 'free' THEN 0 WHEN 'lite' THEN 1 WHEN 'pro' THEN 2 WHEN 'max' THEN 3 END,
       active              = true,
       updated_at          = clock_timestamp()
 WHERE key IN ('free', 'lite', 'pro', 'max');

DELETE FROM public.plans WHERE key = 'ultra';

-- The free plan keeps a tiny S3 allowance (1 GiB/month) and no AI grant;
-- free top-ups go through the wallet. No plan grants AI tokens by default:
-- they are bought from the wallet, which keeps the plan fee about capacity.
UPDATE public.plans
   SET s3_upload_bytes_monthly = 1073741824,
       ai_tokens_monthly       = 0,
       ocr_monthly             = 0,
       updated_at              = clock_timestamp()
 WHERE key = 'free';

-- New workspaces start on free; a paid plan is bought, never defaulted.
ALTER TABLE public.organizations ALTER COLUMN plan SET DEFAULT 'free';
ALTER TABLE public.account_users ALTER COLUMN plan SET DEFAULT 'free';
-- +goose StatementEnd
-- +goose Down
SELECT 1;
