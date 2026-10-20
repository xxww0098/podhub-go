-- +goose Up
-- declaration 288 MediaGcRetirement m20261015_000061_media_gc_retirement
-- source: migration/src/media_gc_retirement.rs @ a03d735
-- +goose StatementBegin
ALTER TABLE public.media_object_leases
    ADD COLUMN IF NOT EXISTS retired_at timestamp with time zone;

-- The image branch of media-core::parse_object_ref, including legacy classless
-- teams/workspaces keys and configured prefixes. Videos retain their explicit
-- admin-delete/reupload contract; the automatic image GC never deletes them.
CREATE OR REPLACE FUNCTION public.is_media_gc_image_key(object_key text)
RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT object_key ~* '(^|/)(teams|workspaces)/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}/sha256/[0-9a-f]{64}\.(jpg|png)$'
       AND object_key !~ '(^|/)\.\.?(/|$)'
       AND object_key !~* '(^|/)videos/(teams|workspaces)/[^/]+/sha256/[^/]+$'
       -- Reserved media-core healthcheck PNG digest; it is never an image lease.
       AND object_key !~* '/sha256/aa7bb0431aaeb198a77c26a14fe6dd714a75e4d7db94e3e1238a1fdcbfe1f8d4\.(jpg|png)$';
$$;

-- A pre-upgrade claim may already have dispatched DELETE. No observation can
-- prove otherwise after a process crash; retain these identities conservatively.
-- Untouched live leases keep their existing admission and verification facts.
UPDATE public.media_object_leases
SET retired_at = COALESCE(deleted_at, gc_claimed_at, clock_timestamp())
WHERE retired_at IS NULL AND (deleted_at IS NOT NULL OR gc_claim_token IS NOT NULL)
  AND public.is_media_gc_image_key(object_key);

CREATE OR REPLACE FUNCTION public.guard_media_lease_retirement()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
    IF TG_OP = 'TRUNCATE' THEN
        RAISE EXCEPTION 'media retirement registry cannot be truncated' USING ERRCODE = '23514';
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF OLD.retired_at IS NOT NULL THEN
            RAISE EXCEPTION 'retired media identity cannot be removed' USING ERRCODE = '23514';
        END IF;
        RETURN OLD;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.retired_at IS NOT NULL
       AND NEW.retired_at IS DISTINCT FROM OLD.retired_at THEN
        RAISE EXCEPTION 'media retirement is irreversible' USING ERRCODE = '23514';
    END IF;
    -- Existing explicit image-delete receipts do not know the new column.
    -- Videos have no batch generation, so their explicit receipt remains reusable.
    IF NEW.deleted_at IS NOT NULL AND NEW.retired_at IS NULL
       AND public.is_media_gc_image_key(NEW.object_key) THEN
        NEW.retired_at := NEW.deleted_at;
    END IF;

    IF TG_OP = 'UPDATE' AND (OLD.retired_at IS NOT NULL OR NEW.retired_at IS NOT NULL) THEN
        IF ROW(NEW.workspace_uuid, NEW.batch_id, NEW.content_hash, NEW.org_id,
               NEW.object_key, NEW.media_account_id, NEW.storage_revision,
               NEW.first_seen_at, NEW.last_hit_at, NEW.created_at,
               NEW.verification_status, NEW.verified_at, NEW.verified_byte_length,
               NEW.verified_width, NEW.verified_height)
           IS DISTINCT FROM
           ROW(OLD.workspace_uuid, OLD.batch_id, OLD.content_hash, OLD.org_id,
               OLD.object_key, OLD.media_account_id, OLD.storage_revision,
               OLD.first_seen_at, OLD.last_hit_at, OLD.created_at,
               OLD.verification_status, OLD.verified_at, OLD.verified_byte_length,
               OLD.verified_width, OLD.verified_height)
           OR NEW.expires_at > OLD.expires_at
           OR (OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS DISTINCT FROM OLD.deleted_at)
           OR (NEW.public_ready_at IS NOT NULL AND NEW.public_ready_at IS DISTINCT FROM OLD.public_ready_at)
           OR (NEW.public_url IS NOT NULL AND NEW.public_url IS DISTINCT FROM OLD.public_url) THEN
            RAISE EXCEPTION 'retired media identity cannot be reused or renewed' USING ERRCODE = '23514';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS media_lease_retirement_guard ON public.media_object_leases;
CREATE TRIGGER media_lease_retirement_guard
    BEFORE INSERT OR UPDATE OR DELETE ON public.media_object_leases
    FOR EACH ROW EXECUTE FUNCTION public.guard_media_lease_retirement();
DROP TRIGGER IF EXISTS media_lease_retirement_truncate_guard ON public.media_object_leases;
CREATE TRIGGER media_lease_retirement_truncate_guard
    BEFORE TRUNCATE ON public.media_object_leases
    FOR EACH STATEMENT EXECUTE FUNCTION public.guard_media_lease_retirement();

ALTER TABLE public.media_object_leases
    DROP CONSTRAINT IF EXISTS media_object_leases_deleted_retired;
ALTER TABLE public.media_object_leases
    ADD CONSTRAINT media_object_leases_deleted_retired
    CHECK (NOT public.is_media_gc_image_key(object_key) OR deleted_at IS NULL OR retired_at IS NOT NULL);
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
