CREATE TABLE ozon_warehouse_fences (
    org_id bigint NOT NULL,
    store_id uuid NOT NULL,
    warehouse_id bigint NOT NULL,
    PRIMARY KEY (org_id, store_id, warehouse_id)
);
