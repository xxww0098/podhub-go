-- +goose Up
-- declaration 263 AutomationGrantScopes m20261004_000446_automation_grant_scopes
-- source: migration/src/automation_grant_scopes.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.automation_grants
    ADD COLUMN scope_kind text NOT NULL DEFAULT 'workspace',
    ADD COLUMN source_ids text[],
    ALTER COLUMN org_id DROP NOT NULL;
ALTER TABLE public.automation_grants DROP CONSTRAINT automation_grants_actions_known;
ALTER TABLE public.automation_grants
    ADD CONSTRAINT automation_grants_scope_shape CHECK (
        (scope_kind = 'workspace' AND org_id IS NOT NULL AND org_id > 0 AND source_ids IS NULL)
        OR (scope_kind = 'catalog' AND org_id IS NULL AND source_ids IS NULL)
        OR (scope_kind = 'supplier_catalog' AND org_id IS NULL)
    ),
    ADD CONSTRAINT automation_grants_source_ids_shape CHECK (
        source_ids IS NULL OR (cardinality(source_ids) <= 200
        AND array_position(source_ids, NULL) IS NULL
        AND (cardinality(source_ids) = 0 OR array_ndims(source_ids) = 1))
    ),
    ADD CONSTRAINT automation_grants_actions_known CHECK (
        cardinality(actions) > 0 AND (
            (scope_kind = 'workspace' AND actions <@ ARRAY['read','prepare','submit','catalog:read','cards:write']::text[])
            OR (scope_kind = 'catalog' AND actions <@ ARRAY['catalog:read']::text[])
            OR (scope_kind = 'supplier_catalog' AND actions <@ ARRAY['supplier:read','supplier:write','supplier:delete','supplier:publish','supplier:price']::text[])
        )
    );
CREATE INDEX automation_grants_owner_scope_idx ON public.automation_grants (user_id, scope_kind, org_id, created_at DESC, id);

CREATE FUNCTION public.automation_grant_authority_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(NEW.user_id,NEW.org_id,NEW.scope_kind,NEW.source_ids,NEW.actions,NEW.token_hash)
       IS DISTINCT FROM ROW(OLD.user_id,OLD.org_id,OLD.scope_kind,OLD.source_ids,OLD.actions,OLD.token_hash) THEN
        RAISE EXCEPTION 'automation grant authority is immutable';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER automation_grant_authority_immutable BEFORE UPDATE ON public.automation_grants
    FOR EACH ROW EXECUTE FUNCTION public.automation_grant_authority_immutable();
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
