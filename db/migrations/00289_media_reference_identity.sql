-- +goose Up
-- +goose NO TRANSACTION
-- declaration 289 MediaReferenceIdentity m20261015_000062_media_reference_identity
-- source: migration/src/media_reference_identity.rs @ a03d735
-- +goose StatementBegin
-- Unlike the registry PK, this identity follows the actual DELETE target.
-- Historical PK/key mismatches must not hide a retired image from read models.
CREATE OR REPLACE FUNCTION public.media_gc_image_identity(object_key text)
RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog, public
AS $$
    SELECT CASE WHEN public.is_media_gc_image_key(object_key)
        THEN lower((regexp_match(object_key,
            '(?:teams|workspaces)/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})/sha256/([0-9a-f]{64})\.(?:jpg|png)$',
            'i'))[1])::uuid::text || ':' || lower((regexp_match(object_key,
            '(?:teams|workspaces)/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})/sha256/([0-9a-f]{64})\.(?:jpg|png)$',
            'i'))[2])
        END;
$$;

-- A candidate extractor, not a URL validator: references historically match
-- embedded keys, including query strings. Callers must recheck their original
-- table-specific substring/equality predicate against the stored object_key.
CREATE OR REPLACE FUNCTION public.media_reference_candidates(reference_text text)
RETURNS TABLE(workspace_uuid uuid, content_hash text)
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT DISTINCT parts[1]::uuid, lower(parts[2])
    FROM regexp_matches(reference_text,
        '(?:teams|workspaces)/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12})/sha256/([0-9a-f]{64})\.(?:jpg|png)',
        'gi') AS matches(parts);
$$;
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_media_object_leases_image_identity" ON "public"."media_object_leases" (media_gc_image_identity(object_key));
-- +goose StatementEnd
-- +goose StatementBegin
CREATE INDEX CONCURRENTLY "ix_media_object_leases_stale_unretired_claim" ON "public"."media_object_leases" ("gc_claimed_at", "workspace_uuid", "batch_id", "content_hash") WHERE retired_at IS NULL AND gc_claim_token IS NOT NULL;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
