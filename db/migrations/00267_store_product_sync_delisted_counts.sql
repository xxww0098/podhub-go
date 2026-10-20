-- +goose Up
-- declaration 267 StoreProductSyncDelistedCounts m20261005_000001_store_product_sync_delisted_counts
-- source: migration/src/store_product_sync_delisted_counts.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.store_product_sync
    ADD COLUMN count_processing bigint,
    ADD COLUMN count_delisted   bigint;

-- 旧 CHECK 会放行 UNKNOWN，部分 NULL 的旧汇总不能当作完成过全量同步。
-- 整体置空后再回填完整汇总，避免严格约束拒绝存量行或补造未知计数。
UPDATE public.store_product_sync
   SET count_total = NULL, count_on_sale = NULL, count_processing = NULL,
       count_hidden = NULL, count_moderation_failed = NULL,
       count_zero_stock = NULL, count_archived = NULL, count_delisted = NULL
 WHERE num_nonnulls(count_total, count_on_sale, count_hidden,
                    count_moderation_failed, count_zero_stock, count_archived)
       BETWEEN 1 AND 5;

-- 镜像可能已在下一轮列表/详情或 verify 中变化，不能混用旧汇总与新桶。
-- 八项从同一聚合整体替换，与 finalize 同口径；软删除店铺的汇总也保留。
-- 只回填完整旧汇总，全空行仍表示未完成全量同步，不能填成零。
WITH per_store AS (
        SELECT st.org_id, st.uuid,
               count(*) FILTER (WHERE sp.gone_at_ms IS NULL
                                     AND d.state != 'archived') AS total,
               count(*) FILTER (WHERE sp.gone_at_ms IS NULL
                                     AND d.state = 'on_sale') AS on_sale,
               count(*) FILTER (WHERE sp.gone_at_ms IS NULL
                                     AND d.state = 'processing') AS processing,
               count(*) FILTER (WHERE sp.gone_at_ms IS NULL
                                     AND d.state = 'hidden') AS hidden,
               count(*) FILTER (WHERE sp.gone_at_ms IS NULL
                                     AND d.state = 'moderation_failed') AS moderation_failed,
               count(*) FILTER (WHERE sp.gone_at_ms IS NULL
                                     AND d.state = 'on_sale'
                                     AND sp.stock_present = 0) AS zero_stock,
               count(*) FILTER (WHERE sp.gone_at_ms IS NULL
                                     AND d.state = 'archived') AS archived,
               count(*) FILTER (WHERE sp.gone_at_ms IS NOT NULL) AS delisted
          FROM public.organization_stores st
          LEFT JOIN public.store_products sp
                 ON sp.store_pk = st.id AND sp.org_id = st.org_id
          LEFT JOIN public.ozon_product_status d ON d.id = sp.status_id
         GROUP BY st.org_id, st.uuid
)
UPDATE public.store_product_sync s
   SET count_total = c.total,
       count_on_sale = c.on_sale,
       count_processing = c.processing,
       count_hidden = c.hidden,
       count_moderation_failed = c.moderation_failed,
       count_zero_stock = c.zero_stock,
       count_archived = c.archived,
       count_delisted = c.delisted
  FROM per_store c
 WHERE s.org_id = c.org_id AND s.store_id = c.uuid
   AND s.count_total IS NOT NULL;

ALTER TABLE public.store_product_sync
    DROP CONSTRAINT store_product_sync_counts_shape;
ALTER TABLE public.store_product_sync
    ADD CONSTRAINT store_product_sync_counts_shape CHECK (
        (
            count_total IS NULL AND count_on_sale IS NULL
            AND count_processing IS NULL AND count_hidden IS NULL
            AND count_moderation_failed IS NULL AND count_zero_stock IS NULL
            AND count_archived IS NULL AND count_delisted IS NULL
        )
        OR (
            count_total IS NOT NULL AND count_on_sale IS NOT NULL
            AND count_processing IS NOT NULL AND count_hidden IS NOT NULL
            AND count_moderation_failed IS NOT NULL AND count_zero_stock IS NOT NULL
            AND count_archived IS NOT NULL AND count_delisted IS NOT NULL
            AND count_total >= 0 AND count_on_sale >= 0 AND count_processing >= 0
            AND count_hidden >= 0 AND count_moderation_failed >= 0
            AND count_zero_stock >= 0 AND count_archived >= 0
            AND count_delisted >= 0
        )
    );
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
