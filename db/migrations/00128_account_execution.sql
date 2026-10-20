-- +goose Up
-- declaration 128 AccountExecution m20260906_000279_account_execution
-- source: migration/src/account_execution.rs @ a03d735
-- +goose StatementBegin
DROP TRIGGER jobs_tenant_queue_head ON public.jobs;
UPDATE public.jobs SET submitter_user_id=(payload->>'submitterUserId')::bigint
WHERE submitter_user_id=0 AND payload->>'submitterUserId' ~ '^[1-9][0-9]{0,17}$';
UPDATE public.jobs j SET submitter_user_id = r.created_by
FROM public.listing_rows r
WHERE j.submitter_user_id = 0 AND j.aggregate_type = 'listing_row'
  AND j.aggregate_id = r.id AND j.org_id = r.org_id AND r.created_by > 0;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.jobs WHERE submitter_user_id <= 0
            AND state IN ('queued','retry_wait','running','uncertain')) THEN
  RAISE EXCEPTION 'Account execution upgrade requires proven submitter_user_id for all active jobs';
 END IF;
END $$;
ALTER TABLE public.jobs ALTER COLUMN submitter_user_id DROP DEFAULT;
ALTER TABLE public.jobs ADD CONSTRAINT jobs_active_submitter
 CHECK (submitter_user_id > 0 OR state NOT IN ('queued','retry_wait','running','uncertain'));
ALTER TABLE public.execution_permits ADD COLUMN user_id bigint;
UPDATE public.execution_permits p SET user_id = j.submitter_user_id
FROM public.jobs j WHERE p.holder_kind = 'job' AND p.holder_id = j.id::text
 AND p.org_id = j.org_id AND j.submitter_user_id > 0;
UPDATE public.execution_permits p SET user_id = a.user_id
FROM public.ai_requests a WHERE p.holder_kind = 'ocr' AND p.holder_id = a.public_id
 AND p.org_id = a.org_id;
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.execution_permits WHERE released_at IS NULL AND user_id IS NULL) THEN
  RAISE EXCEPTION 'Drain old upload/verify permits and resolve unowned active permits before account execution upgrade';
 END IF;
END $$;
ALTER TABLE public.execution_permits ADD CONSTRAINT execution_permits_live_user
 CHECK (released_at IS NOT NULL OR user_id > 0 AND user_id IS NOT NULL);
DROP INDEX public.execution_permits_live_idx;
CREATE INDEX execution_permits_live_idx ON public.execution_permits(class,user_id) WHERE released_at IS NULL;
DELETE FROM public.execution_quota WHERE org_id <> 0;
ALTER TABLE public.execution_quota RENAME COLUMN org_id TO user_id;
CREATE FUNCTION public.execution_quota_user_limit(p_class text) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$ SELECT CASE p_class
 WHEN 'ai_ocr' THEN 2::bigint WHEN 'cloud_upload' THEN 2::bigint
 WHEN 'all_execution' THEN 8::bigint WHEN 'verify' THEN 2::bigint ELSE 0::bigint END $$;
INSERT INTO public.execution_quota(class,user_id,used,hard_limit)
SELECT class,user_id,count(*),public.execution_quota_user_limit(class)
FROM public.execution_permits WHERE released_at IS NULL GROUP BY class,user_id;
UPDATE public.execution_quota q SET used = (SELECT count(*) FROM public.execution_permits p
 WHERE p.class=q.class AND p.released_at IS NULL) WHERE q.user_id=0;
DROP FUNCTION public.try_grant_execution_permit(text[],bigint,text,text,bigint,timestamptz);
DROP FUNCTION public.execution_quota_team_limit(text);
DROP FUNCTION public.drr_on_grant(text,bigint,bigint);
DROP TABLE public.execution_fairness;
DROP TABLE public.execution_fairness_cursor;
CREATE TABLE public.execution_fairness (
 class text NOT NULL, user_id bigint NOT NULL CHECK(user_id>0), request_until timestamptz NOT NULL,
 PRIMARY KEY(class,user_id));
CREATE TABLE public.execution_fairness_cursor(class text PRIMARY KEY,last_user_id bigint NOT NULL DEFAULT 0);
INSERT INTO public.execution_fairness_cursor(class)
 VALUES ('ai_ocr'),('cloud_upload'),('all_execution'),('verify');
CREATE FUNCTION public.register_execution_demand(p_class text,p_user_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$ BEGIN
 IF p_user_id <= 0 THEN RAISE EXCEPTION 'execution requires a positive User'; END IF;
 PERFORM 1 FROM public.execution_quota WHERE class=p_class AND user_id=0 FOR UPDATE;
 INSERT INTO public.execution_quota(class,user_id,hard_limit)
 VALUES(p_class,p_user_id,public.execution_quota_user_limit(p_class)) ON CONFLICT DO NOTHING;
 INSERT INTO public.execution_fairness(class,user_id,request_until)
 VALUES(p_class,p_user_id,clock_timestamp()+interval '30 seconds')
 ON CONFLICT(class,user_id) DO UPDATE SET request_until=excluded.request_until;
END $$;
CREATE FUNCTION public.try_grant_execution_permit(
 p_classes text[],p_org_id bigint,p_user_id bigint,p_holder_kind text,
 p_holder_id text,p_lease_epoch bigint,p_expires_at timestamptz) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE c text; missing text[]; next_user bigint;
BEGIN
 IF p_org_id<=0 OR p_user_id<=0 OR p_holder_id='' OR cardinality(p_classes) IS NULL OR cardinality(p_classes)=0 THEN RETURN false; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.organization_members WHERE org_id=p_org_id AND user_id=p_user_id AND status='active') THEN RETURN false; END IF;
 -- Global rows serialize grants, release and demand registration in class order.
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
 IF EXISTS(SELECT 1 FROM public.execution_quota WHERE class=ANY(missing)
 AND user_id IN (0,p_user_id) AND used>=hard_limit) THEN RETURN false; END IF;
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
CREATE OR REPLACE FUNCTION public.release_execution_permit(
    p_holder_kind text,
    p_holder_id text,
    p_lease_epoch bigint
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    released_row record;
    did boolean := false;
BEGIN
    PERFORM 1
    FROM public.execution_quota q
    WHERE EXISTS (
        SELECT 1
        FROM public.execution_permits p
        WHERE p.holder_kind = p_holder_kind
          AND p.holder_id = p_holder_id
          AND p.lease_epoch = p_lease_epoch
          AND p.released_at IS NULL
          AND q.class = p.class
          AND q.user_id IN (0, p.user_id)
    )
    ORDER BY q.class, q.user_id
    FOR UPDATE;

    -- A terminal Job can still own a committed upstream call. Cancellation
    -- and reaping share this guard; the current Row is not effect evidence.
    IF p_holder_kind = 'job' THEN
      IF EXISTS (
        SELECT 1 FROM public.execution_permits owned
        WHERE owned.holder_kind = 'job'
          AND owned.holder_id = p_holder_id
          AND owned.lease_epoch = p_lease_epoch
          AND owned.released_at IS NULL
          AND (
              EXISTS (
                  SELECT 1 FROM public.ai_requests a
                  WHERE a.org_id = owned.org_id
                    AND a.job_id = p_holder_id::uuid
                    AND a.operation = 'ocr'
                    AND a.status IN ('held', 'dispatching')
              )
              OR EXISTS (
                  SELECT 1 FROM public.execution_permits unit
                  WHERE unit.holder_kind = 'upload_unit'
                    AND unit.org_id = owned.org_id
                    AND unit.holder_id LIKE ('job:' || p_holder_id || ':' || p_lease_epoch::text || ':%')
                    AND unit.released_at IS NULL
              )
          )
      ) THEN
        RETURN false;
      END IF;
    END IF;

    FOR released_row IN
        UPDATE public.execution_permits
           SET released_at = clock_timestamp()
         WHERE holder_kind = p_holder_kind
           AND holder_id = p_holder_id
           AND lease_epoch = p_lease_epoch
           AND released_at IS NULL
     RETURNING class, user_id
    LOOP
        did := true;
        UPDATE public.execution_quota
           SET used = used - 1
         WHERE class = released_row.class
           AND user_id = released_row.user_id
           AND used > 0;
        UPDATE public.execution_quota
           SET used = used - 1
         WHERE class = released_row.class
           AND user_id = 0
           AND used > 0;
    END LOOP;
    RETURN did;
END;
$$;


CREATE OR REPLACE FUNCTION public.reap_stale_execution_permits(p_limit bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    stale record;
    n bigint := 0;
BEGIN
    PERFORM 1 FROM public.execution_quota WHERE user_id=0 ORDER BY class FOR UPDATE;
    FOR stale IN
        SELECT holder_kind, holder_id, lease_epoch
          FROM (
                SELECT p.holder_kind, p.holder_id, p.lease_epoch
                  FROM public.execution_permits p
                 WHERE p.released_at IS NULL
                   AND (
                        (p.holder_kind = 'job' AND NOT EXISTS (
                            SELECT 1
                            FROM public.jobs j
                            WHERE j.id::text = p.holder_id
                              AND j.lease_epoch = p.lease_epoch
                              AND j.state IN ('running', 'uncertain')
                        ))
                        OR (p.holder_kind IN ('ocr', 'upload_unit', 'verify')
                            AND p.expires_at IS NOT NULL
                            AND p.expires_at < clock_timestamp())
                   )
                 GROUP BY p.holder_kind, p.holder_id, p.lease_epoch
                 LIMIT GREATEST(p_limit, 1)
          ) stale_holders
    LOOP
        IF public.release_execution_permit(stale.holder_kind, stale.holder_id, stale.lease_epoch) THEN
            n := n + 1;
        END IF;
    END LOOP;
    RETURN n;
END;
$$;
DROP TABLE public.tenant_queue_head;
DROP FUNCTION public.refresh_tenant_queue_head();
DROP FUNCTION public.queue_plan_weight(bigint);
CREATE TABLE public.account_queue_cursor (
 lane text PRIMARY KEY,last_user_id bigint NOT NULL DEFAULT 0);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.account_queue_cursor TO podhub_app,podhub_worker;
CREATE TABLE public.account_queue_head (
 user_id bigint NOT NULL,lane text NOT NULL,queued_cost bigint NOT NULL DEFAULT 0,
 running_cost bigint NOT NULL DEFAULT 0,oldest_job_at timestamptz,
 PRIMARY KEY(user_id,lane),CHECK(queued_cost>=0 AND running_cost>=0));
CREATE INDEX account_queue_head_claim_idx ON public.account_queue_head(lane,user_id) WHERE queued_cost>0;
DROP INDEX public.jobs_claim_head_idx;
DROP INDEX public.jobs_head_oldest_idx;
DROP INDEX public.jobs_submitter_claim_idx;
CREATE INDEX jobs_claim_head_idx ON public.jobs(submitter_user_id,lane,created_at,id)
 WHERE state IN ('queued','retry_wait') AND payload->>'executor' IS DISTINCT FROM 'browser';
CREATE INDEX jobs_head_oldest_idx ON public.jobs(submitter_user_id,lane,run_at)
 WHERE state IN ('queued','retry_wait');
INSERT INTO public.account_queue_head(user_id,lane,queued_cost,running_cost,oldest_job_at)
SELECT submitter_user_id,lane,
 sum(CASE WHEN state IN ('queued','retry_wait') THEN cost_units ELSE 0 END),
 sum(CASE WHEN state='running' THEN cost_units ELSE 0 END),
 min(run_at) FILTER(WHERE state IN ('queued','retry_wait'))
FROM public.jobs WHERE state IN ('queued','retry_wait','running') GROUP BY submitter_user_id,lane;
CREATE FUNCTION public.refresh_account_queue_head() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE u bigint:=COALESCE(NEW.submitter_user_id,OLD.submitter_user_id);
 l text:=COALESCE(NEW.lane,OLD.lane); oq bigint:=0; nq bigint:=0; orc bigint:=0; nr bigint:=0;
BEGIN
 IF TG_OP='UPDATE' AND (NEW.submitter_user_id<>OLD.submitter_user_id OR NEW.lane<>OLD.lane) THEN
  RAISE EXCEPTION 'Job execution User and lane are immutable';
 END IF;
 IF TG_OP<>'INSERT' THEN
  IF OLD.state IN ('queued','retry_wait') THEN oq:=OLD.cost_units; END IF;
  IF OLD.state='running' THEN orc:=OLD.cost_units; END IF;
 END IF;
 IF TG_OP<>'DELETE' THEN
  IF NEW.state IN ('queued','retry_wait') THEN nq:=NEW.cost_units; END IF;
  IF NEW.state='running' THEN nr:=NEW.cost_units; END IF;
 END IF;
 IF oq=0 AND nq=0 AND orc=0 AND nr=0 THEN RETURN COALESCE(NEW,OLD); END IF;
 INSERT INTO public.account_queue_head(user_id,lane) VALUES(u,l) ON CONFLICT DO NOTHING;
 UPDATE public.account_queue_head SET queued_cost=queued_cost-oq+nq,running_cost=running_cost-orc+nr
 WHERE user_id=u AND lane=l;
 UPDATE public.account_queue_head SET oldest_job_at=(SELECT min(run_at) FROM public.jobs
  WHERE submitter_user_id=u AND lane=l AND state IN ('queued','retry_wait')) WHERE user_id=u AND lane=l;
 DELETE FROM public.account_queue_head WHERE user_id=u AND lane=l AND queued_cost=0 AND running_cost=0;
 RETURN COALESCE(NEW,OLD);
END $$;
CREATE TRIGGER jobs_account_queue_head AFTER INSERT OR UPDATE OF state,cost_units,lane,submitter_user_id OR DELETE ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.refresh_account_queue_head();
GRANT SELECT,INSERT,UPDATE,DELETE ON public.account_queue_head,public.execution_fairness,public.execution_fairness_cursor TO podhub_app,podhub_worker;
GRANT EXECUTE ON FUNCTION public.execution_quota_user_limit(text),public.register_execution_demand(text,bigint),
 public.try_grant_execution_permit(text[],bigint,bigint,text,text,bigint,timestamptz) TO podhub_app,podhub_worker;
-- +goose StatementEnd
-- +goose Down
-- Rust down() refuses a destructive rollback.
SELECT 1;
