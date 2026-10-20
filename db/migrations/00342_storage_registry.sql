-- +goose Up
-- +goose StatementBegin
-- Long-lived object registry for the assets and private buckets. The transit
-- bucket is deliberately absent: its objects live for one day and never carry
-- a business reference. Keys, scopes and bucket roles are defined in
-- docs/architecture/storage-common.md.
CREATE TABLE public.storage_objects (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bucket          text NOT NULL CHECK (bucket IN ('assets', 'private')),
    bucket_identity text NOT NULL CHECK (bucket_identity ~ '^[0-9a-f]{64}$'),
    object_key      text NOT NULL CHECK (object_key <> '' AND object_key !~ '(^|/)\.\.?(/|$)'),
    dedupe_scope    text NOT NULL
        CHECK (dedupe_scope = 'catalog'
            OR dedupe_scope ~ '^source:[^[:space:]/:]+$'
            OR dedupe_scope ~ '^binding:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$'
            OR dedupe_scope ~ '^org:[0-9]+:(template|file)$'),
    owner_org_id    bigint REFERENCES public.organizations (id) ON DELETE RESTRICT,
    sha256          bytea NOT NULL CHECK (octet_length(sha256) = 32),
    byte_length     bigint NOT NULL CHECK (byte_length > 0),
    content_type    text NOT NULL CHECK (content_type ~ '^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*$'),
    extension       text NOT NULL CHECK (extension IN ('jpg', 'png', 'webp', 'psd', 'mp4', 'mov')),
    state           text NOT NULL DEFAULT 'live' CHECK (state IN ('live', 'deleting', 'deleted')),
    retired_at      timestamptz,
    created_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (bucket_identity, object_key),
    UNIQUE (bucket_identity, dedupe_scope, sha256, extension),
    CONSTRAINT ck_storage_objects_retired CHECK ((state = 'deleted') = (retired_at IS NOT NULL)),
    -- A private object without an owner would be visible to every tenant
    -- through the NULL branch of the policy below.
    CONSTRAINT ck_storage_objects_private_owner CHECK (bucket <> 'private' OR owner_org_id IS NOT NULL)
);
CREATE INDEX ix_storage_objects_live_age
    ON public.storage_objects (created_at)
    WHERE state = 'live';

COMMENT ON TABLE public.storage_objects IS
    'Content-addressed registry for long-lived buckets. Tombstones keep the key from being resurrected.';

CREATE TABLE public.storage_uploads (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id         bigint NOT NULL,
    org_id           bigint REFERENCES public.organizations (id) ON DELETE RESTRICT,
    purpose_kind     text NOT NULL
        CHECK (purpose_kind IN ('org_file', 'org_template', 'delegate_binding', 'source', 'catalog')),
    purpose_id       text NOT NULL,
    bucket           text NOT NULL CHECK (bucket IN ('assets', 'private')),
    bucket_identity  text NOT NULL CHECK (bucket_identity ~ '^[0-9a-f]{64}$'),
    object_key       text NOT NULL CHECK (object_key <> ''),
    dedupe_scope     text NOT NULL,
    sha256           bytea NOT NULL CHECK (octet_length(sha256) = 32),
    byte_length      bigint NOT NULL CHECK (byte_length > 0),
    content_type     text NOT NULL,
    extension        text NOT NULL CHECK (extension IN ('jpg', 'png', 'webp', 'psd', 'mp4', 'mov')),
    multipart_id     text,
    state            text NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'confirmed', 'expired', 'aborted', 'superseded')),
    expires_at       timestamptz NOT NULL,
    confirmed_at     timestamptz,
    object_id        uuid REFERENCES public.storage_objects (id) ON DELETE SET NULL,
    created_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT ck_storage_uploads_confirmed
        CHECK (state <> 'confirmed' OR (object_id IS NOT NULL AND confirmed_at IS NOT NULL))
);

-- The lease is per physical key: any pending row keeps the key alive until it
-- expires. Expired rows are kept as history and never block a new upload.
CREATE UNIQUE INDEX ux_storage_uploads_live
    ON public.storage_uploads (bucket_identity, object_key, actor_id, purpose_kind, purpose_id)
    WHERE state IN ('pending', 'confirmed');
CREATE INDEX ix_storage_uploads_expiry
    ON public.storage_uploads (expires_at)
    WHERE state = 'pending';
CREATE INDEX ix_storage_uploads_key
    ON public.storage_uploads (bucket_identity, object_key, state, expires_at);

CREATE TABLE public.storage_object_refs (
    object_id    uuid NOT NULL REFERENCES public.storage_objects (id) ON DELETE RESTRICT,
    owner_kind   text NOT NULL
        CHECK (owner_kind IN ('psd_template', 'delegate_asset', 'dispatch', 'source_product', 'catalog_product', 'catalog_sku')),
    owner_id     text NOT NULL CHECK (owner_id <> ''),
    owner_org_id bigint REFERENCES public.organizations (id) ON DELETE RESTRICT,
    created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (object_id, owner_kind, owner_id)
);
CREATE INDEX ix_storage_object_refs_owner
    ON public.storage_object_refs (owner_kind, owner_id);

COMMENT ON TABLE public.storage_object_refs IS
    'Explicit object references, maintained only by business-table triggers in the same transaction.';

-- Fence key: the physical key, not the digest. Equal content under two keys
-- does not serialise, and a key rename cannot slip past a reference check.
CREATE OR REPLACE FUNCTION public.storage_key_fence(p_bucket_identity text, p_object_key text)
RETURNS bigint
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog
AS $$
    SELECT hashtextextended('storage-key:v1:' || p_bucket_identity || ':' || p_object_key, 0)
$$;

-- Reference writers and confirmations share this lock; the collector takes the
-- exclusive form. The post-fence lookups need a fresh statement snapshot, so a
-- repeatable-read transaction is refused.
CREATE OR REPLACE FUNCTION public.lock_storage_key_shared(p_bucket_identity text, p_object_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'storage reference writes require read committed isolation' USING ERRCODE = '25001';
    END IF;
    IF NOT pg_try_advisory_xact_lock_shared(public.storage_key_fence(p_bucket_identity, p_object_key)) THEN
        RAISE EXCEPTION 'storage object is busy; retry the transaction' USING ERRCODE = '55P03';
    END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_storage_key_shared(text, text) FROM PUBLIC, podhub_app, podhub_worker;
GRANT EXECUTE ON FUNCTION public.lock_storage_key_shared(text, text) TO podhub_app, podhub_worker;

-- The collector calls this before re-reading references. A false return means
-- another transaction holds the shared form; the caller retries later.
CREATE OR REPLACE FUNCTION public.try_lock_storage_key_exclusive(p_bucket_identity text, p_object_key text)
RETURNS boolean
LANGUAGE sql
VOLATILE
STRICT
PARALLEL UNSAFE
SET search_path = pg_catalog
AS $$
    SELECT pg_try_advisory_xact_lock(public.storage_key_fence(p_bucket_identity, p_object_key))
$$;
REVOKE ALL ON FUNCTION public.try_lock_storage_key_exclusive(text, text) FROM PUBLIC, podhub_app, podhub_worker;
GRANT EXECUTE ON FUNCTION public.try_lock_storage_key_exclusive(text, text) TO podhub_app, podhub_worker;

-- Reference candidates are the union of a business row's object columns.
-- A scalar column is one uuid; an array column is either uuid strings or
-- objects carrying objectId / object_id. The result is sorted and distinct so
-- every transaction takes shared fences in the same order.
CREATE OR REPLACE FUNCTION public.storage_ref_candidates(p_row jsonb, p_paths text[])
RETURNS uuid[]
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog
AS $$
DECLARE
    v_out uuid[] := '{}';
    v_path text;
    v_value jsonb;
    v_item jsonb;
    v_text text;
BEGIN
    IF p_row IS NULL THEN
        RETURN v_out;
    END IF;
    FOREACH v_path IN ARRAY p_paths LOOP
        v_value := p_row -> v_path;
        CONTINUE WHEN v_value IS NULL OR jsonb_typeof(v_value) = 'null';
        IF jsonb_typeof(v_value) = 'string' THEN
            v_text := v_value #>> '{}';
            IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                v_out := v_out || v_text::uuid;
            END IF;
        ELSIF jsonb_typeof(v_value) = 'array' THEN
            FOR v_item IN SELECT value FROM jsonb_array_elements(v_value) LOOP
                IF jsonb_typeof(v_item) = 'string' THEN
                    v_text := v_item #>> '{}';
                ELSIF jsonb_typeof(v_item) = 'object' THEN
                    v_text := COALESCE(v_item ->> 'objectId', v_item ->> 'object_id');
                ELSE
                    v_text := NULL;
                END IF;
                IF v_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
                    v_out := v_out || v_text::uuid;
                END IF;
            END LOOP;
        END IF;
    END LOOP;
    RETURN ARRAY(SELECT DISTINCT x FROM unnest(v_out) AS x ORDER BY x);
END;
$$;
REVOKE ALL ON FUNCTION public.storage_ref_candidates(jsonb, text[]) FROM PUBLIC, podhub_app, podhub_worker;

-- TG_ARGV: owner_kind, comma-separated object columns, owner id column,
-- optional org column (empty for platform-owned rows). Set difference, never
-- per-column: one object may appear in several columns of the same row.
CREATE OR REPLACE FUNCTION public.sync_storage_object_refs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
    v_owner_kind text := TG_ARGV[0];
    v_paths text[] := string_to_array(TG_ARGV[1], ',');
    v_owner_column text := TG_ARGV[2];
    v_org_column text := TG_ARGV[3];
    v_old_ids uuid[] := '{}';
    v_new_ids uuid[] := '{}';
    v_owner text;
    v_org bigint;
    v_object uuid;
    v_identity text;
    v_key text;
    v_state text;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        v_old_ids := public.storage_ref_candidates(to_jsonb(OLD), v_paths);
    END IF;
    IF TG_OP <> 'DELETE' THEN
        v_new_ids := public.storage_ref_candidates(to_jsonb(NEW), v_paths);
    END IF;

    IF TG_OP = 'DELETE' THEN
        v_owner := to_jsonb(OLD) ->> v_owner_column;
    ELSE
        v_owner := to_jsonb(NEW) ->> v_owner_column;
    END IF;
    IF v_owner IS NULL OR v_owner = '' THEN
        RAISE EXCEPTION 'storage reference owner is empty' USING ERRCODE = 'P0S02';
    END IF;
    IF v_org_column <> '' THEN
        IF TG_OP = 'DELETE' THEN
            v_org := NULLIF(to_jsonb(OLD) ->> v_org_column, '')::bigint;
        ELSE
            v_org := NULLIF(to_jsonb(NEW) ->> v_org_column, '')::bigint;
        END IF;
    END IF;

    FOREACH v_object IN ARRAY v_old_ids LOOP
        CONTINUE WHEN v_object = ANY (v_new_ids);
        SELECT bucket_identity, object_key INTO v_identity, v_key
          FROM public.storage_objects WHERE id = v_object;
        IF FOUND THEN
            PERFORM public.lock_storage_key_shared(v_identity, v_key);
        END IF;
        DELETE FROM public.storage_object_refs
         WHERE object_id = v_object AND owner_kind = v_owner_kind AND owner_id = v_owner;
    END LOOP;

    FOREACH v_object IN ARRAY v_new_ids LOOP
        CONTINUE WHEN v_object = ANY (v_old_ids);
        SELECT bucket_identity, object_key, state INTO v_identity, v_key, v_state
          FROM public.storage_objects WHERE id = v_object FOR KEY SHARE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'storage object does not exist' USING ERRCODE = 'P0S03';
        END IF;
        IF v_state <> 'live' THEN
            RAISE EXCEPTION 'storage object is not live' USING ERRCODE = 'P0S04';
        END IF;
        PERFORM public.lock_storage_key_shared(v_identity, v_key);
        INSERT INTO public.storage_object_refs (object_id, owner_kind, owner_id, owner_org_id)
        VALUES (v_object, v_owner_kind, v_owner, v_org)
        ON CONFLICT (object_id, owner_kind, owner_id) DO NOTHING;
    END LOOP;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.sync_storage_object_refs() FROM PUBLIC, podhub_app, podhub_worker;

-- The template table becomes the first registered owner. It has no runtime
-- writer yet; the path, scope and reference kind are fixed here so the upload
-- path can be attached without another registry change.
ALTER TABLE public.workspace_psd_templates
    ADD COLUMN IF NOT EXISTS object_id uuid REFERENCES public.storage_objects (id) ON DELETE RESTRICT,
    ADD COLUMN IF NOT EXISTS original_name text;
DROP TRIGGER IF EXISTS storage_ref_sync ON public.workspace_psd_templates;
CREATE TRIGGER storage_ref_sync
    AFTER INSERT OR UPDATE OF object_id OR DELETE ON public.workspace_psd_templates
    FOR EACH ROW EXECUTE FUNCTION public.sync_storage_object_refs('psd_template', 'object_id', 'id', 'org_id');

-- Tenant isolation. The registry itself holds object metadata only (key,
-- digest, size, type); it carries no URL and no content, so it is shared
-- infrastructure like media_object_leases. References are the tenant-scoped
-- rows: platform objects are platform-wide, private ones only exist inside
-- their org, and a staff session sees both.
--
-- References are ENABLE RLS without FORCE on purpose. The only writer is the
-- definer trigger above, which runs as the table owner and therefore bypasses
-- the policy; podhub_app has SELECT and no DML grant. FORCE would also bind
-- the definer and would leave no policy that a tenant-bound session could not
-- forge.
ALTER TABLE public.storage_object_refs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS storage_ref_read ON public.storage_object_refs;
CREATE POLICY storage_ref_read ON public.storage_object_refs
    FOR SELECT TO podhub_app
    USING (
        owner_org_id IS NULL
        OR owner_org_id = NULLIF(current_setting('app.current_org_id', true), '')::bigint
        OR current_setting('app.staff_access', true) = '1'
    );

-- ALTER DEFAULT PRIVILEGES in 00191 grants new tables to both roles. The
-- registry is narrower than that default, so take the grant away first.
REVOKE ALL ON public.storage_objects, public.storage_uploads, public.storage_object_refs
    FROM PUBLIC, podhub_app, podhub_worker;
GRANT SELECT, INSERT, UPDATE ON public.storage_objects TO podhub_app;
GRANT SELECT ON public.storage_objects TO podhub_worker;
GRANT SELECT, INSERT, UPDATE ON public.storage_uploads TO podhub_app;
GRANT SELECT, INSERT, UPDATE ON public.storage_uploads TO podhub_worker;
GRANT SELECT ON public.storage_object_refs TO podhub_app;
GRANT SELECT ON public.storage_object_refs TO podhub_worker;

-- Reference rows are written only by the definer trigger; app and worker keep
-- read access and can never truncate the registry.
REVOKE TRUNCATE ON public.storage_objects, public.storage_uploads, public.storage_object_refs
    FROM PUBLIC, podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
