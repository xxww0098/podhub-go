-- +goose Up
-- declaration 131 AiOcrUserLimit m20260908_000289_ai_ocr_user_limit
-- source: migration/src/ai_ocr_user_limit.rs @ a03d735
-- +goose StatementBegin
-- Quota grants and releases lock the global row before user rows.
SELECT class FROM public.execution_quota WHERE class = 'ai_ocr' AND user_id = 0 FOR UPDATE;
CREATE OR REPLACE FUNCTION public.execution_quota_user_limit(p_class text) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE p_class
 WHEN 'ai_ocr' THEN 8::bigint WHEN 'cloud_upload' THEN 2::bigint
 WHEN 'all_execution' THEN 8::bigint WHEN 'verify' THEN 2::bigint ELSE 0::bigint END $$;
UPDATE public.execution_quota
SET hard_limit = 8
WHERE class = 'ai_ocr' AND user_id > 0 AND hard_limit = 2;
UPDATE public.execution_quota
SET hard_limit = 0
WHERE class = 'ai_ocr' AND user_id = 0;
CREATE OR REPLACE FUNCTION public.try_grant_execution_permit(
 p_classes text[],p_org_id bigint,p_user_id bigint,p_holder_kind text,
 p_holder_id text,p_lease_epoch bigint,p_expires_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c text; missing text[]; next_user bigint;
BEGIN
 IF p_org_id<=0 OR p_user_id<=0 OR p_holder_id='' OR cardinality(p_classes) IS NULL OR cardinality(p_classes)=0 THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.organization_members WHERE org_id=p_org_id AND user_id=p_user_id AND status='active') THEN RETURN false; END IF;
 PERFORM 1 FROM public.execution_quota WHERE class=ANY(p_classes) AND user_id=0 ORDER BY class FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.execution_permits WHERE holder_kind=p_holder_kind
   AND holder_id=p_holder_id AND lease_epoch=p_lease_epoch AND class=ANY(p_classes)
   AND (released_at IS NOT NULL OR org_id<>p_org_id OR user_id IS DISTINCT FROM p_user_id)) THEN RETURN false; END IF;
 SELECT array_agg(DISTINCT x) INTO missing FROM unnest(p_classes) x
 WHERE NOT EXISTS(SELECT 1 FROM public.execution_permits p WHERE p.holder_kind=p_holder_kind
 AND p.holder_id=p_holder_id AND p.lease_epoch=p_lease_epoch AND p.class=x);
 IF missing IS NULL THEN RETURN true; END IF;
 FOREACH c IN ARRAY missing LOOP PERFORM public.register_execution_demand(c,p_user_id); END LOOP;
 PERFORM 1 FROM public.execution_quota WHERE class=ANY(missing) AND user_id=p_user_id ORDER BY class FOR UPDATE;
 IF EXISTS(SELECT 1 FROM public.execution_quota q WHERE q.class=ANY(missing)
   AND ((q.user_id=0 AND NOT (q.class='ai_ocr' AND q.hard_limit=0)) OR q.user_id=p_user_id)
   AND q.used>=q.hard_limit) THEN RETURN false; END IF;
 FOREACH c IN ARRAY missing LOOP
  SELECT f.user_id INTO next_user FROM public.execution_fairness f
  JOIN public.execution_quota q ON q.class=f.class AND q.user_id=f.user_id
  JOIN public.execution_fairness_cursor cur ON cur.class=f.class
  WHERE f.class=c AND f.request_until>clock_timestamp() AND q.used<q.hard_limit
  ORDER BY (f.user_id>cur.last_user_id) DESC,f.user_id LIMIT 1;
  IF next_user IS DISTINCT FROM p_user_id THEN RETURN false; END IF;
 END LOOP;
 UPDATE public.execution_quota SET used=used+1 WHERE class=ANY(missing) AND user_id IN(0,p_user_id);
 INSERT INTO public.execution_permits(holder_kind,holder_id,lease_epoch,class,org_id,user_id,expires_at)
 SELECT p_holder_kind,p_holder_id,p_lease_epoch,x,p_org_id,p_user_id,p_expires_at FROM unnest(missing) x;
 UPDATE public.execution_fairness_cursor SET last_user_id=p_user_id WHERE class=ANY(missing);
 DELETE FROM public.execution_fairness WHERE class=ANY(missing) AND user_id=p_user_id;
 RETURN true;
END $$;

REVOKE EXECUTE ON FUNCTION public.try_grant_execution_permit(text[], bigint, bigint, text, text, bigint, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.try_grant_execution_permit(text[], bigint, bigint, text, text, bigint, timestamptz) TO podhub_app, podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
