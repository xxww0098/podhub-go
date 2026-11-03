-- +goose Up
-- Seed rows the application reads as configuration, not fixtures: the plan
-- catalogue with per-plan add-on prices, the rebate defaults, the execution
-- quota classes, the seeded Ozon error codes and the unassigned supply
-- source. They used to arrive across a dozen migrations; this file is the
-- state those migrations leave behind.
--
-- Every insert is idempotent so a re-run against an already-seeded database
-- is a no-op.
-- +goose StatementBegin

INSERT INTO public.plans
    (key, name, tagline, store_monthly_cents,
     highlights, admin_only, sort_order, active,
     s3_upload_bytes_monthly, ai_tokens_monthly, created_at, updated_at)
VALUES
    ('free', 'Free', '1 店，永久免费', 0, '[]', false, 0, true,
     1073741824, 0, clock_timestamp(), clock_timestamp()),
    ('lite', 'Lite', '店铺 ¥20/月', 2000, '[]', false, 1, true,
     15569256448, 0, clock_timestamp(), clock_timestamp()),
    ('pro', 'Pro', '店铺 ¥25/月', 2500, '[]', false, 2, true,
     155692564480, 0, clock_timestamp(), clock_timestamp()),
    ('max', 'Max', '店铺 ¥30/月', 3000, '[]', false, 3, true,
     311385128960, 0, clock_timestamp(), clock_timestamp())
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.agent_rebate_policy
    (singleton, default_rebate_bps, min_order_cents, attribution_validity_days, min_withdraw_cents)
VALUES (true, 1000, 10000, 365, 10000)
ON CONFLICT (singleton) DO NOTHING;

INSERT INTO public.platform_initialization (singleton)
VALUES (true)
ON CONFLICT DO NOTHING;

-- ai_ocr is unlimited at the global row (hard_limit 0 means no global cap);
-- the per-user caps live in execution_quota_user_limit().
INSERT INTO public.execution_quota (class, user_id, used, hard_limit) VALUES
    ('ai_ocr', 0, 0, 0),
    ('cloud_upload', 0, 0, 6),
    ('all_execution', 0, 0, 48),
    ('verify', 0, 0, 4)
ON CONFLICT (class, user_id) DO NOTHING;

INSERT INTO public.execution_fairness_cursor (class, last_user_id) VALUES
    ('ai_ocr', 0),
    ('cloud_upload', 0),
    ('all_execution', 0),
    ('verify', 0)
ON CONFLICT (class) DO NOTHING;

INSERT INTO public.ai_price_schedules
    (model, billing_mode,
     input_microfen_per_million, cached_input_microfen_per_million,
     output_microfen_per_million, reasoning_microfen_per_million,
     per_request_microfen, max_request_microfen,
     effective_from, created_by_user_id)
VALUES
    ('qwen3.7-flash', 'token',
     40000000, 20000000,
     160000000, 160000000,
     0, 50000000,
     clock_timestamp(), NULL)
ON CONFLICT (model) DO UPDATE SET
    billing_mode = EXCLUDED.billing_mode,
    input_microfen_per_million = EXCLUDED.input_microfen_per_million,
    cached_input_microfen_per_million = EXCLUDED.cached_input_microfen_per_million,
    output_microfen_per_million = EXCLUDED.output_microfen_per_million,
    reasoning_microfen_per_million = EXCLUDED.reasoning_microfen_per_million,
    per_request_microfen = EXCLUDED.per_request_microfen,
    max_request_microfen = EXCLUDED.max_request_microfen,
    effective_from = clock_timestamp(),
    created_by_user_id = NULL;

INSERT INTO public.ozon_error_catalog (
    source, code, attribute_id, description_category_id, type_id,
    level, state, field, attribute_name, sample_description, occurrences
) VALUES
    ('docs_seed', 'SPU_already_exists', 0, 0, 0, '', '', '', '', '', 0),
    ('docs_seed', 'Invalid_state', 0, 0, 0, '', '', '', '', '', 0),
    ('docs_seed', 'Incorrect_density', 0, 0, 0, '', '', '', '', '密度 0.001–13.55', 0),
    ('docs_seed', 'item_limit_exceeded', 0, 0, 0, '', '', '', '', '', 0),
    ('docs_seed', 'product_is_not_created', 0, 0, 0, '', '', '', '', '', 0),
    ('docs_seed', 'offer_id_not_found', 0, 0, 0, '', '', '', '', '', 0),
    ('docs_seed', 'WAREHOUSE_NOT_FOUND', 0, 0, 0, '', '', '', '', '', 0),
    ('docs_seed', 'FLAMMABLE_ONLY_ON_SELF_OR_PROVIDER_DELIVERY', 0, 0, 0, '', '', '', '', '', 0)
ON CONFLICT DO NOTHING;

INSERT INTO public.sc_sources
    (source_id, name, listed, created_at_ms, updated_at_ms, created_by_account_uuid)
VALUES (
    'src_unassigned',
    '未分配',
    false,
    CAST(extract(epoch from clock_timestamp()) * 1000 AS bigint),
    CAST(extract(epoch from clock_timestamp()) * 1000 AS bigint),
    'system:migration'
)
ON CONFLICT (source_id) DO NOTHING;

INSERT INTO public.banned_tags (term, match_mode, note, created_by, enabled)
SELECT 'сигарета', 'stem', 'Ozon 限制烟草相关标签。词干匹配 сигарет 及其词形。', 'system', true
WHERE NOT EXISTS (SELECT 1 FROM public.banned_tags WHERE term = 'сигарета');

INSERT INTO public.banned_tags (term, match_mode, note, created_by, enabled)
SELECT 'табак', 'stem', '词干 табак。词尾前 к/ч 交替，因此 табачный 命中（额外前缀 табач，未见日常无关词）。覆盖 табака。табакерка（鼻烟壶）会同中。不命中 таблица、табор、табурет、табель。五字以下的 к 词干不做 ч 交替，避免 парк 碰到 парча。', 'system', true
WHERE NOT EXISTS (SELECT 1 FROM public.banned_tags WHERE term = 'табак');

INSERT INTO public.banned_tags (term, match_mode, note, created_by, enabled)
SELECT 'вейп', 'stem', '词干 вейп。覆盖 вейпы、вейпа、вейповый、вейпинг。不命中 веер、век、веймар。', 'system', true
WHERE NOT EXISTS (SELECT 1 FROM public.banned_tags WHERE term = 'вейп');

INSERT INTO public.banned_tags (term, match_mode, note, created_by, enabled)
SELECT 'никотин', 'stem', '词干保持 никотин，不剥 ин。覆盖 никотина、никотиновый。不命中 никон、николай、никонов。', 'system', true
WHERE NOT EXISTS (SELECT 1 FROM public.banned_tags WHERE term = 'никотин');

INSERT INTO public.banned_tags (term, match_mode, note, created_by, enabled)
SELECT 'электронная_сигарета', 'stem', '词干 электронная_сигарет。空格、下划线、连字符视为同一分隔。覆盖 электронная_сигареты。首词变格 электронные_сигареты 不靠本词干，靠 сигарета 那一段。不命中单独的 электронная、электронная_книга、электронная_сигара。', 'system', true
WHERE NOT EXISTS (SELECT 1 FROM public.banned_tags WHERE term = 'электронная_сигарета');

INSERT INTO public.banned_tags (term, match_mode, note, created_by, enabled)
SELECT 'испаритель', 'stem', '只剥末尾 ь，词干 испарител。覆盖 испарителя、испарители、испарителем、испарительный。不剥 ель 或 тель，因此不命中 испарение、испариться、испарить、искра。', 'system', true
WHERE NOT EXISTS (SELECT 1 FROM public.banned_tags WHERE term = 'испаритель');
-- +goose StatementEnd
-- +goose Down
-- Seed rows are configuration the runtime reads; a rollback would break it.
SELECT 1;
