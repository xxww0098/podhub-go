-- +goose Up
ALTER TABLE public.submission_intents
    ADD COLUMN slice_image_urls text[] NOT NULL DEFAULT '{}',
    ADD COLUMN slice_images_fetched_at timestamptz;
CREATE INDEX submission_intents_slice_image_urls ON public.submission_intents USING gin (slice_image_urls);
-- Older objects can have frozen uses without image evidence. Reuse remains
-- possible, but only objects first uploaded with tracking may be collected.
ALTER TABLE public.media_object_leases ADD COLUMN slice_gc_tracked boolean NOT NULL DEFAULT false;
CREATE INDEX media_object_leases_slice_reuse ON public.media_object_leases
    (org_id, media_account_id, storage_revision, content_hash, verified_at DESC)
    WHERE retired_at IS NULL AND deleted_at IS NULL;

-- Frozen references share the same fence as uploads and draft writes. The
-- collector takes its exclusive form before a fresh reference check.
-- +goose StatementBegin
CREATE FUNCTION public.guard_slice_intent_images() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
DECLARE
    identity record;
BEGIN
    IF TG_OP='UPDATE' AND NEW.slice_image_urls IS DISTINCT FROM OLD.slice_image_urls THEN
        RAISE EXCEPTION 'frozen slice references cannot change' USING ERRCODE='23514';
    END IF;
    FOR identity IN
        SELECT DISTINCT c.workspace_uuid,c.content_hash
        FROM public.media_reference_candidates(array_to_string(NEW.slice_image_urls,E'\n')) c
        ORDER BY c.workspace_uuid,c.content_hash
    LOOP
        PERFORM public.lock_media_reference_identity(identity.workspace_uuid,identity.content_hash);
    END LOOP;
    IF EXISTS (
        SELECT 1 FROM unnest(NEW.slice_image_urls) image(url)
        WHERE NOT EXISTS (
            SELECT 1 FROM public.media_object_leases l
            WHERE l.org_id=NEW.org_id AND l.public_url=image.url
              AND l.verification_status='verified' AND l.public_ready_at IS NOT NULL
              AND l.retired_at IS NULL AND l.deleted_at IS NULL AND l.gc_claim_token IS NULL
        )
    ) THEN
        RAISE EXCEPTION 'slice image is unavailable' USING ERRCODE='P0M01';
    END IF;
    RETURN NEW;
END;
$$;
-- +goose StatementEnd
REVOKE ALL ON FUNCTION public.guard_slice_intent_images() FROM PUBLIC;
CREATE TRIGGER slice_intent_images_guard BEFORE INSERT OR UPDATE OF slice_image_urls
    ON public.submission_intents FOR EACH ROW EXECUTE FUNCTION public.guard_slice_intent_images();

-- +goose Down
-- +goose StatementBegin
DO $$ BEGIN
    RAISE EXCEPTION 'Slice fetch evidence cannot be discarded without reviewing retained images';
END $$;
-- +goose StatementEnd
