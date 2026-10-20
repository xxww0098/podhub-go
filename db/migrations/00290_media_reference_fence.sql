-- +goose Up
-- declaration 290 MediaReferenceFence m20261015_000063_media_reference_fence
-- source: migration/src/media_reference_fence.rs @ a03d735
-- +goose StatementBegin
CREATE OR REPLACE FUNCTION public.lock_media_reference_identity(p_workspace uuid, p_digest text)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
    -- The post-fence lookups require a fresh statement snapshot. Repeatable
    -- snapshots could miss retirement committed before this shared lock was
    -- acquired and then admit another primary key for the same physical key.
    -- Reject only managed-image writes; read-only observations are unaffected.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'media reference writes require read committed isolation' USING ERRCODE = '25001';
    END IF;
    -- Shared locks allow reference writers and registry insertion to coexist.
    -- They are NOT unique admission and do not replace lease row locks. Even
    -- absent registry identities are covered until the business writer commits.
    -- GC takes the exclusive form, then a separate READ COMMITTED statement
    -- rechecks references before retirement; no lock spans the origin request.
    IF NOT pg_try_advisory_xact_lock_shared(hashtextextended(
        'podhub:media-reference:v1:' || p_workspace::text || ':' || lower(p_digest), 0)) THEN
        RAISE EXCEPTION 'media reference is busy; retry the transaction' USING ERRCODE = '55P03';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_media_reference_identity(uuid, text) FROM PUBLIC, podhub_app, podhub_worker;

CREATE OR REPLACE FUNCTION public.guard_media_lease_reference_identity()
RETURNS trigger
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    identity text;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        identity := public.media_gc_image_identity(OLD.object_key);
        IF identity IS NOT NULL THEN
            PERFORM public.lock_media_reference_identity(split_part(identity,':',1)::uuid,split_part(identity,':',2));
        END IF;
    END IF;
    IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.object_key IS DISTINCT FROM OLD.object_key) THEN
        identity := public.media_gc_image_identity(NEW.object_key);
        IF identity IS NOT NULL THEN
            PERFORM public.lock_media_reference_identity(split_part(identity,':',1)::uuid,split_part(identity,':',2));
        END IF;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;

    identity := public.media_gc_image_identity(NEW.object_key);
    IF identity IS NOT NULL AND NEW.retired_at IS NULL AND NEW.deleted_at IS NULL
       AND (TG_OP='INSERT' OR OLD.retired_at IS NULL) THEN
        -- The shared fence is held before this distinct SPI statement. This
        -- VOLATILE lookup uses a fresh READ COMMITTED snapshot, including a GC
        -- retirement committed after the outer INSERT's statement began.
        -- Old registry hashes/batches/accounts are not physical generations:
        -- even a different PK cannot grant the same exact retired object key.
        IF EXISTS (
            SELECT 1 FROM public.media_object_leases prior
            WHERE public.media_gc_image_identity(prior.object_key)=identity
              AND prior.object_key=NEW.object_key AND prior.retired_at IS NOT NULL
        ) THEN
            RAISE EXCEPTION 'media object is retired; upload under a new key' USING ERRCODE = 'P0M01';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_media_lease_reference_identity() FROM PUBLIC, podhub_app, podhub_worker;
DROP TRIGGER IF EXISTS media_lease_reference_fence ON public.media_object_leases;
CREATE TRIGGER media_lease_reference_fence
    BEFORE INSERT OR UPDATE OR DELETE ON public.media_object_leases
    FOR EACH ROW EXECUTE FUNCTION public.guard_media_lease_reference_identity();

-- A historical wrong registry PK is not a new physical object generation.
-- Propagate only established retirement evidence for the exact same object key;
-- a different batch/prefix/key with the same digest remains unrelated and live.
-- Keep the original proof and metadata: retirement records possible DELETE,
-- not a confirmed absence, and is never a reason to invent or erase evidence.
WITH retired AS MATERIALIZED (
    SELECT public.media_gc_image_identity(object_key) AS identity,
           object_key, min(retired_at) AS retired_at
    FROM public.media_object_leases
    WHERE retired_at IS NOT NULL AND public.media_gc_image_identity(object_key) IS NOT NULL
    GROUP BY public.media_gc_image_identity(object_key), object_key
)
UPDATE public.media_object_leases alias
SET retired_at=retired.retired_at
FROM retired
WHERE alias.retired_at IS NULL
  AND public.media_gc_image_identity(alias.object_key)=retired.identity
  AND alias.object_key=retired.object_key;

CREATE OR REPLACE FUNCTION public.guard_media_reference_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    reference_text text;
    exact_key text;
    reference_url text;
    images jsonb;
    match_kind text;
    scope_org bigint;
    scope_workspace uuid;
    now_at timestamptz := clock_timestamp();
    identities record;
    workspaces uuid[];
    digests text[];
    live_workspaces uuid[];
    live_batches text[];
    live_digests text[];
    has_retired boolean;
BEGIN
    CASE TG_TABLE_NAME
    WHEN 'listing_rows' THEN
        IF NOT (NEW.submission_state IN ('queued','submitting','unknown')
            OR (NEW.media_state='ready' AND NEW.submission_state NOT IN ('accepted','cancelled')
                AND NEW.updated_at >= now_at - interval '7 days')
            OR (NEW.submission_state='accepted' AND NEW.updated_at >= now_at - interval '7 days')) THEN
            RETURN NEW;
        END IF;
        images := CASE WHEN jsonb_typeof(NEW.payload->'media'->'images')='array'
                       THEN NEW.payload->'media'->'images' ELSE '[]'::jsonb END;
        reference_text := images::text;
        scope_org := NEW.org_id;
        match_kind := 'listing';
    WHEN 'store_products' THEN
        IF NEW.gone_at_ms IS NOT NULL OR COALESCE(NEW.primary_image,'')='' THEN RETURN NEW; END IF;
        reference_text := NEW.primary_image;
        reference_url := NEW.primary_image;
        scope_org := NEW.org_id;
        match_kind := 'url';
    WHEN 'supplier_media_objects' THEN
        -- Supplier objects intentionally retain matching keys across every
        -- Workspace. Adding an org predicate here would narrow GC protection.
        exact_key := COALESCE(NEW.object_key,'');
        reference_url := COALESCE(NEW.public_url,'');
        reference_text := exact_key || E'\n' || reference_url;
        match_kind := 'supplier';
    WHEN 'media_blobs' THEN
        IF NEW.state='deleted' THEN RETURN NEW; END IF;
        exact_key := NEW.storage_key;
        reference_text := exact_key;
        scope_org := NEW.org_id;
        match_kind := 'key';
    WHEN 'media_uploads' THEN
        IF NEW.state<>'pending' OR NEW.expires_at<=now_at THEN RETURN NEW; END IF;
        exact_key := NEW.storage_key;
        reference_text := exact_key;
        scope_org := NEW.org_id;
        match_kind := 'key';
    WHEN 'jobs' THEN
        IF NEW.state NOT IN ('queued','running','retry_wait','uncertain') THEN RETURN NEW; END IF;
        reference_text := NEW.payload::text;
        scope_org := NEW.org_id;
        match_kind := 'job';
    ELSE
        RAISE EXCEPTION 'unexpected media reference table';
    END CASE;

    -- Every candidate contains this delimiter. Ordinary external URLs and
    -- unrelated Job payloads therefore avoid even an organization lookup;
    -- this fast rejection cannot narrow the embedded-key match set below.
    IF reference_text IS NULL OR position('/sha256/' in lower(reference_text))=0 THEN
        RETURN NEW;
    END IF;
    -- The extractor does not query the registry; only matching physical
    -- identities go on to indexed lease lookups and row locks.
    IF scope_org IS NOT NULL THEN
        SELECT o.uuid INTO scope_workspace FROM public.organizations o WHERE o.id=scope_org;
        IF scope_workspace IS NULL THEN RETURN NEW; END IF;
    END IF;
    FOR identities IN
        SELECT c.workspace_uuid, c.content_hash
        FROM public.media_reference_candidates(reference_text) c
        ORDER BY c.workspace_uuid, c.content_hash
    LOOP
        PERFORM public.lock_media_reference_identity(identities.workspace_uuid, identities.content_hash);
        workspaces := array_append(workspaces, identities.workspace_uuid);
        digests := array_append(digests, identities.content_hash);
    END LOOP;
    IF workspaces IS NULL THEN RETURN NEW; END IF;

    -- Drain the ordered locking subquery before issuing a single batch UPDATE.
    -- NOWAIT also handles multi-row business transactions that visit different
    -- objects in opposite orders: retry, never wait while holding the other row.
    SELECT array_agg(l.workspace_uuid), array_agg(l.batch_id), array_agg(l.content_hash)
      INTO live_workspaces, live_batches, live_digests
      FROM (
        SELECT lease.workspace_uuid, lease.batch_id, lease.content_hash
        FROM public.media_object_leases lease
        JOIN unnest(workspaces,digests) AS wanted(workspace_uuid,content_hash)
          ON public.media_gc_image_identity(lease.object_key)=wanted.workspace_uuid::text||':'||wanted.content_hash
        WHERE lease.retired_at IS NULL AND lease.deleted_at IS NULL
          AND (scope_workspace IS NULL OR lease.workspace_uuid=scope_workspace)
          AND CASE match_kind
            WHEN 'listing' THEN EXISTS (SELECT 1 FROM jsonb_array_elements(images) img WHERE
                lower(COALESCE(img->>'object_key',''))=lower(lease.object_key)
                OR (COALESCE(img->>'public_url','')<>'' AND
                    (position(lower(lease.object_key) in lower(img->>'public_url'))>0
                     OR (COALESCE(lease.public_url,'')<>'' AND
                         split_part(split_part(img->>'public_url','?',1),'#',1)
                         =split_part(split_part(lease.public_url,'?',1),'#',1)))))
            WHEN 'url' THEN position(lower(lease.object_key) in lower(reference_url))>0
                OR (COALESCE(lease.public_url,'')<>'' AND
                    split_part(split_part(reference_url,'?',1),'#',1)
                    =split_part(split_part(lease.public_url,'?',1),'#',1))
            WHEN 'supplier' THEN exact_key=lease.object_key
                OR position(lower(lease.object_key) in lower(reference_url))>0
                OR (COALESCE(lease.public_url,'')<>'' AND reference_url<>'' AND
                    split_part(split_part(reference_url,'?',1),'#',1)
                    =split_part(split_part(lease.public_url,'?',1),'#',1))
            WHEN 'key' THEN exact_key=lease.object_key
            WHEN 'job' THEN position(lease.object_key in reference_text)>0
                OR (COALESCE(lease.public_url,'')<>'' AND position(lease.public_url in reference_text)>0)
            ELSE false END
        ORDER BY lease.workspace_uuid, lease.batch_id, lease.content_hash
        FOR NO KEY UPDATE OF lease NOWAIT
      ) l;

    UPDATE public.media_object_leases lease
       SET expires_at=GREATEST(lease.expires_at,now_at+interval '4 hours'), updated_at=clock_timestamp()
      FROM unnest(live_workspaces,live_batches,live_digests) AS live(workspace_uuid,batch_id,content_hash)
     WHERE lease.workspace_uuid=live.workspace_uuid AND lease.batch_id=live.batch_id
       AND lease.content_hash=live.content_hash AND lease.retired_at IS NULL AND lease.deleted_at IS NULL;

    IF TG_TABLE_NAME IN ('store_products','jobs') THEN
        -- Observations are persisted even when an image is retired. Their use
        -- boundaries/read models decide availability from stronger evidence.
        RETURN NEW;
    END IF;

    -- Retirement cannot be reversed, so observations of retired objects need
    -- no row lock and must not delay GC's completion receipt. This is a second
    -- statement after locking the live set: a concurrent explicit retirement
    -- committed while that set was selected is still observed here. Pinning is
    -- intentionally conservative; invalidation needs a positive identity:
    -- an explicit exact key or the saved full public URL (query/fragment aside).
    -- An external host/path or wrapper URL merely containing the key is unknown.
    SELECT EXISTS (
        SELECT 1 FROM public.media_object_leases lease
        JOIN unnest(workspaces,digests) AS wanted(workspace_uuid,content_hash)
          ON public.media_gc_image_identity(lease.object_key)=wanted.workspace_uuid::text||':'||wanted.content_hash
        WHERE (lease.retired_at IS NOT NULL OR lease.deleted_at IS NOT NULL)
          AND (scope_workspace IS NULL OR lease.workspace_uuid=scope_workspace)
          AND CASE match_kind
            WHEN 'listing' THEN EXISTS (SELECT 1 FROM jsonb_array_elements(images) img WHERE
                img->>'object_key'=lease.object_key
                OR (COALESCE(lease.public_url,'')<>'' AND COALESCE(img->>'public_url','')<>'' AND
                    split_part(split_part(img->>'public_url','?',1),'#',1)
                    =split_part(split_part(lease.public_url,'?',1),'#',1)))
            WHEN 'supplier' THEN exact_key=lease.object_key
                OR (COALESCE(lease.public_url,'')<>'' AND reference_url<>'' AND
                    split_part(split_part(reference_url,'?',1),'#',1)
                    =split_part(split_part(lease.public_url,'?',1),'#',1))
            WHEN 'key' THEN exact_key=lease.object_key
            ELSE false END
    ) INTO has_retired;

    IF has_retired THEN
        IF TG_TABLE_NAME IN ('supplier_media_objects','media_blobs','media_uploads') THEN
            RAISE EXCEPTION 'media object is retired; upload under a new key' USING ERRCODE = 'P0M01';
        ELSIF TG_TABLE_NAME='listing_rows' THEN
          IF NEW.media_state='ready' THEN
            -- Preserve remote receipts, paid content and media evidence. This
            -- is only the usability projection; the existing row-version and
            -- stream triggers publish it with the same atomic business write.
            NEW.media_state := 'failed';
            NEW.payload := jsonb_set(NEW.payload, '{failureLog}',
                (CASE WHEN jsonb_typeof(NEW.payload->'failureLog')='array'
                      THEN NEW.payload->'failureLog' ELSE '[]'::jsonb END)
                || jsonb_build_array(jsonb_build_object(
                    'stage','media','code','MEDIA_OBJECT_MISSING',
                    'message','图片已进入不可逆回收；请用「一键准备」重新上传图片后再发送（不会重新识图）',
                    'occurred_at_ms',floor(extract(epoch from clock_timestamp())*1000))), true);
          END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_media_reference_write() FROM PUBLIC, podhub_app, podhub_worker;

DROP TRIGGER IF EXISTS media_reference_guard ON public.listing_rows;
CREATE TRIGGER media_reference_guard BEFORE INSERT OR UPDATE ON public.listing_rows
    FOR EACH ROW EXECUTE FUNCTION public.guard_media_reference_write();
DROP TRIGGER IF EXISTS media_reference_guard ON public.store_products;
CREATE TRIGGER media_reference_guard BEFORE INSERT OR UPDATE ON public.store_products
    FOR EACH ROW EXECUTE FUNCTION public.guard_media_reference_write();
DROP TRIGGER IF EXISTS media_reference_guard ON public.supplier_media_objects;
CREATE TRIGGER media_reference_guard BEFORE INSERT OR UPDATE ON public.supplier_media_objects
    FOR EACH ROW EXECUTE FUNCTION public.guard_media_reference_write();
DROP TRIGGER IF EXISTS media_reference_guard ON public.media_blobs;
CREATE TRIGGER media_reference_guard BEFORE INSERT OR UPDATE ON public.media_blobs
    FOR EACH ROW EXECUTE FUNCTION public.guard_media_reference_write();
DROP TRIGGER IF EXISTS media_reference_guard ON public.media_uploads;
CREATE TRIGGER media_reference_guard BEFORE INSERT OR UPDATE ON public.media_uploads
    FOR EACH ROW EXECUTE FUNCTION public.guard_media_reference_write();
DROP TRIGGER IF EXISTS media_reference_guard ON public.jobs;
CREATE TRIGGER media_reference_guard BEFORE INSERT OR UPDATE ON public.jobs
    FOR EACH ROW EXECUTE FUNCTION public.guard_media_reference_write();
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
