-- +goose Up
-- declaration 332 StoreNameSourceManual
-- Data only. 00330 adds name_source with default auto. Rows that already
-- have a display name were chosen by a person; mark them manual so a later
-- seller-info read does not replace that name. A blank name stays auto.
-- Rows inserted after this file use the column default, which is auto.
-- No new columns. 00001-00331 are not edited. organization_stores stays
-- without row level security.
-- +goose StatementBegin
UPDATE public.organization_stores
   SET name_source = 'manual'
 WHERE length(btrim(name::text)) > 0;
-- +goose StatementEnd

-- +goose Down
SELECT 1;
